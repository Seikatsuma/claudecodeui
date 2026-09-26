import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Выжимка переписки для поиска.
 *
 * Файл переписки Claude — это в основном служебное: картинки в base64, вывод
 * команд, содержимое прочитанных файлов. Короткое слово («sun») находится
 * почти в каждом файле и почти в каждой длинной строке, поэтому поиск прямо по
 * файлам переписки разбирал всё подряд: 1,2 ГБ и 20+ секунд на запрос (замер
 * 23.09.26 на общем сайте).
 *
 * Здесь рядом с базой экземпляра лежит по одному файлу-выжимке на файл
 * переписки: одна строка на видимое сообщение (кто, когда, текст). Выжимка
 * дописывается с того места, где остановилась в прошлый раз, — переписка только
 * растёт, поэтому каждый поиск дочитывает лишь новые строки. Если файл
 * переписки подменили или укоротили — выжимка строится заново.
 */

export type SearchableRole = 'user' | 'assistant';
export type IndexedProvider = 'claude' | 'codex';

export type IndexedMessage = {
  /** Номер разговора у провайдера (у Claude в одном файле их может быть несколько). */
  s: string | null;
  /** Номер сообщения — по нему лента прокручивает к находке. */
  u: string | null;
  r: SearchableRole;
  t: string | null;
  x: string;
};

export type IndexedSessionSummary = {
  resolvedSummary: string | null;
  lastUserText: string | null;
  lastAssistantText: string | null;
};

type IndexMeta = {
  version: number;
  source: string;
  dev: number;
  ino: number;
  /** Сколько байт переписки уже разобрано (всегда по концу целой строки). */
  offset: number;
  /** Отпечаток начала файла: другой файл под тем же именем — строить заново. */
  head: string;
  /** Размер выжимки на момент записи: хвост сверх него — от оборванной записи. */
  indexSize: number;
  currentSessionId: string | null;
  pendingSummaries: Record<string, string>;
  sessions: Record<string, IndexedSessionSummary>;
};

export type ExtractedRecord =
  | { kind: 'message'; message: IndexedMessage; isCompactSummary: boolean }
  | { kind: 'summary'; sessionId: string | null; leafUuid: string | null; summary: string };

export type RecordExtractor = (entry: Record<string, any>) => ExtractedRecord | null;

// 2 — служебные строки человека (isMeta) в выжимку больше не попадают.
const INDEX_VERSION = 2;
const HEAD_BYTES = 512;
const SUMMARY_TEXT_LIMIT = 300;
const MAX_PENDING_SUMMARIES = 200;
// Отдельная строка переписки бывает в десятки мегабайт (вывод команды,
// картинка). Видимого текста в такой строке нет, а разбор её стоит дорого.
const SKIP_LINE_BYTES = 8 * 1024 * 1024;

const inFlight = new Map<string, Promise<string | null>>();
// Что уже известно о выжимке в этом процессе: если файл переписки не менялся,
// хватает одного stat — без чтения описания и начала файла.
const knownFresh = new Map<string, { size: number; mtimeMs: number; ino: number; indexPath: string }>();

export function getSearchIndexDir(): string {
  const dbPath = process.env.DATABASE_PATH;
  const base = dbPath ? path.dirname(dbPath) : path.join(os.homedir(), '.cloudcli');
  return path.join(base, 'search-index');
}

function indexPathsFor(sourcePath: string): { indexPath: string; metaPath: string } {
  const hash = crypto.createHash('sha1').update(sourcePath).digest('hex');
  const dir = getSearchIndexDir();
  return {
    indexPath: path.join(dir, `${hash}.jsonl`),
    metaPath: path.join(dir, `${hash}.meta.json`),
  };
}

async function readHead(sourcePath: string, size: number): Promise<string> {
  const handle = await fs.open(sourcePath, 'r');
  try {
    const length = Math.min(HEAD_BYTES, size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return crypto.createHash('sha1').update(buffer).digest('hex');
  } finally {
    await handle.close();
  }
}

async function loadMeta(metaPath: string): Promise<IndexMeta | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(metaPath, 'utf8')) as IndexMeta;
    return parsed?.version === INDEX_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

function clip(text: string): string {
  return text.length > SUMMARY_TEXT_LIMIT ? text.slice(0, SUMMARY_TEXT_LIMIT) : text;
}

function freshMeta(sourcePath: string, stat: fsSync.Stats, head: string): IndexMeta {
  return {
    version: INDEX_VERSION,
    source: sourcePath,
    dev: stat.dev,
    ino: stat.ino,
    offset: 0,
    head,
    indexSize: 0,
    currentSessionId: null,
    pendingSummaries: {},
    sessions: {},
  };
}

function applyRecord(meta: IndexMeta, record: ExtractedRecord, out: string[]): void {
  if (record.kind === 'summary') {
    if (record.sessionId) {
      const state = sessionState(meta, record.sessionId);
      state.resolvedSummary = clip(record.summary);
    } else if (record.leafUuid) {
      meta.pendingSummaries[record.leafUuid] = clip(record.summary);
      const keys = Object.keys(meta.pendingSummaries);
      if (keys.length > MAX_PENDING_SUMMARIES) {
        delete meta.pendingSummaries[keys[0]];
      }
    }
    return;
  }

  const { message } = record;
  const state = sessionState(meta, message.s ?? '');
  if (record.isCompactSummary) {
    state.resolvedSummary = clip(message.x);
  }
  if (message.r === 'user') {
    state.lastUserText = clip(message.x);
  } else {
    state.lastAssistantText = clip(message.x);
  }
  out.push(JSON.stringify(message));
}

function sessionState(meta: IndexMeta, sessionId: string): IndexedSessionSummary {
  if (!meta.sessions[sessionId]) {
    meta.sessions[sessionId] = { resolvedSummary: null, lastUserText: null, lastAssistantText: null };
  }
  return meta.sessions[sessionId];
}

/**
 * Разбирает одну строку переписки. Номер разговора у Claude в строке есть не
 * всегда — тогда берётся последний встреченный (так же читает сам Claude).
 */
function processLine(
  line: string,
  provider: IndexedProvider,
  extract: RecordExtractor,
  meta: IndexMeta,
  out: string[],
): void {
  if (!line.trim()) {
    return;
  }

  let entry: Record<string, any>;
  try {
    entry = JSON.parse(line) as Record<string, any>;
  } catch {
    return;
  }

  if (provider === 'claude') {
    if (entry.sessionId) {
      meta.currentSessionId = String(entry.sessionId);
    }
    const entrySessionId = entry.sessionId ? String(entry.sessionId) : meta.currentSessionId;
    if (entrySessionId && entry.parentUuid) {
      const pending = meta.pendingSummaries[String(entry.parentUuid)];
      const state = sessionState(meta, entrySessionId);
      if (pending && !state.resolvedSummary) {
        state.resolvedSummary = pending;
      }
    }
    const record = extract(entry);
    if (!record) {
      return;
    }
    if (record.kind === 'summary') {
      applyRecord(meta, { ...record, sessionId: entry.sessionId ? String(entry.sessionId) : null }, out);
      return;
    }
    applyRecord(meta, { ...record, message: { ...record.message, s: entrySessionId } }, out);
    return;
  }

  const record = extract(entry);
  if (record) {
    applyRecord(meta, record, out);
  }
}

async function buildOrExtend(
  sourcePath: string,
  provider: IndexedProvider,
  extract: RecordExtractor,
): Promise<string | null> {
  let stat: fsSync.Stats;
  try {
    stat = await fs.stat(sourcePath);
  } catch {
    return null;
  }

  const known = knownFresh.get(sourcePath);
  if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs && known.ino === stat.ino) {
    return known.indexPath;
  }

  const { indexPath, metaPath } = indexPathsFor(sourcePath);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });

  const head = stat.size > 0 ? await readHead(sourcePath, stat.size) : '';
  let meta = await loadMeta(metaPath);
  let indexSize = -1;
  try {
    indexSize = (await fs.stat(indexPath)).size;
  } catch {
    indexSize = -1;
  }

  const stillSameFile = meta !== null
    && meta.source === sourcePath
    && meta.dev === stat.dev
    && meta.ino === stat.ino
    && stat.size >= meta.offset
    && (meta.offset === 0 || meta.head === head)
    && indexSize >= meta.indexSize;

  if (!stillSameFile || meta === null) {
    meta = freshMeta(sourcePath, stat, head);
    await fs.writeFile(indexPath, '');
  } else if (indexSize > meta.indexSize) {
    // Прошлая запись оборвалась между выжимкой и её описанием — хвост лишний.
    await fs.truncate(indexPath, meta.indexSize);
  }

  if (stat.size === meta.offset) {
    knownFresh.set(sourcePath, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, indexPath });
    return indexPath;
  }

  meta.head = head;
  const startOffset = meta.offset;
  const endOffset = stat.size;
  const out: string[] = [];
  let consumed = startOffset;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let skipping = false;

  const stream = fsSync.createReadStream(sourcePath, { start: startOffset, end: endOffset - 1 });
  for await (const rawChunk of stream) {
    const chunk = rawChunk as Buffer;
    let from = 0;
    while (from < chunk.length) {
      const newline = chunk.indexOf(10, from);
      if (newline === -1) {
        if (!skipping) {
          pending.push(chunk.subarray(from));
          pendingBytes += chunk.length - from;
          if (pendingBytes > SKIP_LINE_BYTES) {
            skipping = true;
            pending = [];
          }
        }
        consumed += chunk.length - from;
        break;
      }

      if (!skipping) {
        pending.push(chunk.subarray(from, newline));
        const line = Buffer.concat(pending).toString('utf8');
        processLine(line, provider, extract, meta, out);
      }
      consumed += newline + 1 - from;
      pending = [];
      pendingBytes = 0;
      skipping = false;
      meta.offset = consumed;
      from = newline + 1;
    }
  }

  if (out.length > 0) {
    await fs.appendFile(indexPath, `${out.join('\n')}\n`);
  }
  meta.indexSize = (await fs.stat(indexPath)).size;
  const tmpMeta = `${metaPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpMeta, JSON.stringify(meta));
  await fs.rename(tmpMeta, metaPath);
  // Незаконченная последняя строка (запись ещё идёт) — не свежая: дочитать в
  // следующий раз, когда файл подрастёт.
  if (meta.offset === stat.size) {
    knownFresh.set(sourcePath, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, indexPath });
  } else {
    knownFresh.delete(sourcePath);
  }
  return indexPath;
}

/**
 * Возвращает путь к свежей выжимке файла переписки (дочитав новые строки).
 * Два одновременных поиска по одному файлу ждут одну и ту же работу.
 */
export function ensureSearchIndex(
  sourcePath: string,
  provider: IndexedProvider,
  extract: RecordExtractor,
): Promise<string | null> {
  const running = inFlight.get(sourcePath);
  if (running) {
    return running;
  }

  const job = buildOrExtend(sourcePath, provider, extract)
    .catch((error) => {
      console.warn('[search-index] выжимка не обновилась:', sourcePath, error instanceof Error ? error.message : error);
      return null;
    })
    .finally(() => {
      inFlight.delete(sourcePath);
    });
  inFlight.set(sourcePath, job);
  return job;
}

export async function readIndexedSummaries(
  sourcePath: string,
): Promise<Record<string, IndexedSessionSummary>> {
  const meta = await loadMeta(indexPathsFor(sourcePath).metaPath);
  return meta?.sessions ?? {};
}

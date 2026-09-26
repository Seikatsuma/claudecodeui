/**
 * Сжатый текст переписки чата — материал, из которого модель пишет выжимку
 * для нового чата («Продолжить в новом чате»).
 *
 * Файл переписки у долгого чата — десятки мегабайт: вывод команд, чтение
 * файлов, размышления, служебные записи. Модели, которая пишет выжимку, из
 * этого нужны слова человека, ответы агента и следы действий (какие файлы
 * правились, какие команды шли). Остальное отбрасывается здесь, без модели.
 *
 * Что берётся и почему (сверено с открытыми практиками передачи дел, 23.09.26):
 * - Сообщения человека — все и почти дословно: встроенное сжатие Claude Code
 *   держит раздел «All user messages», потому что именно в них поправки и
 *   смена намерения.
 * - Ответы агента — текстом, без размышлений: размышления — черновик, выводы
 *   в тексте.
 * - Действия — одной строкой: путь правленого файла, описание команды, запрос
 *   поиска, задание помощника. Вывод инструментов не берётся (Anthropic:
 *   «clearing tool calls and results» — первое, что выбрасывает сжатие),
 *   кроме коротких ошибок: неудачные попытки дороже всего открывать заново.
 * - Сжатие внутри чата уже было — берётся последняя сводка сжатия и всё после
 *   неё (ровно то, что агент чата сейчас «помнит»), а из части до неё — только
 *   сообщения человека: сводки сжатия теряют поправки чаще всего остального.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { isTranscriptServiceText, stripInjectedContext } from '@/shared/utils.js';

/** Потолок одного сообщения человека: длинные вставки (логи, тексты) режутся. */
const HUMAN_MESSAGE_MAX_CHARS = 6000;
/** Потолок одного текстового ответа агента. */
const ASSISTANT_TEXT_MAX_CHARS = 4000;
/** Потолок сводки сжатия (их пишет сама модель, обычно 5–20 тыс. знаков). */
const COMPACT_SUMMARY_MAX_CHARS = 40000;
/** Короткая ошибка инструмента — сколько знаков оставить. */
const TOOL_ERROR_MAX_CHARS = 240;
/** Сколько последних правленых файлов перечислять в шапке выжимки. */
const CHANGED_FILES_LIMIT = 40;

type AnyRecord = Record<string, any>;

type DigestEntry =
  | { kind: 'human'; at: string | null; text: string }
  | { kind: 'assistant'; at: string | null; text: string }
  | { kind: 'action'; text: string }
  | { kind: 'compact'; at: string | null; text: string };

/** Итог разбора переписки: текст для модели и факты, собранные без модели. */
export type TranscriptDigest = {
  /** Текст для модели: сообщения по порядку, по строке на действие. */
  text: string;
  /** Файлы, которые правились в чате (последние сверху), — для шапки выжимки. */
  changedFiles: string[];
  /** Сколько сообщений человека попало в текст. */
  humanMessages: number;
  /** Было ли внутри чата сжатие (тогда ранняя часть — только слова человека). */
  hadCompaction: boolean;
};

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)} …[обрезано, всего ${text.length} зн.]`;
}


function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part: AnyRecord) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part: AnyRecord) => part.text as string)
    .join('\n');
}

function hasImage(content: unknown): boolean {
  return Array.isArray(content) && content.some((part: AnyRecord) => part?.type === 'image');
}

function oneLine(text: string, max: number): string {
  return clip(text.replace(/\s+/g, ' ').trim(), max);
}

/** Одна строка о вызове инструмента. Чтение и поиск по файлам не пишутся: их много, смысла мало. */
function describeToolUse(block: AnyRecord): string | null {
  const name = String(block.name ?? '');
  const input: AnyRecord = block.input && typeof block.input === 'object' ? block.input : {};
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return typeof input.file_path === 'string' || typeof input.notebook_path === 'string'
        ? `${name === 'Write' ? 'записан файл' : 'правка файла'} ${input.file_path ?? input.notebook_path}`
        : null;
    case 'Bash': {
      const described = typeof input.description === 'string' && input.description.trim();
      const command = typeof input.command === 'string' ? input.command : '';
      return described
        ? `команда: ${oneLine(described, 160)} — \`${oneLine(command, 160)}\``
        : `команда: \`${oneLine(command, 220)}\``;
    }
    case 'Agent':
    case 'Task':
      return `помощник: ${oneLine(String(input.description ?? input.prompt ?? ''), 200)}`;
    case 'WebSearch':
      return `поиск в сети: ${oneLine(String(input.query ?? ''), 200)}`;
    case 'WebFetch':
      return `открыта страница: ${oneLine(String(input.url ?? ''), 200)}`;
    case 'Skill':
      return `навык: ${oneLine(String(input.skill ?? input.name ?? ''), 120)}`;
    default:
      if (name.startsWith('mcp__')) return `внешний инструмент: ${name.replace(/^mcp__/, '')}`;
      return null;
  }
}

function formatTime(at: string | null): string {
  if (!at) return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `[${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}] `;
}

/**
 * Разбирает строки переписки одного чата. Отдельно от чтения файла — чтобы
 * проверять разбор в тестах на строках, без файлов.
 */
export function digestTranscriptLines(lines: Iterable<string>, providerSessionId: string | null): TranscriptDigest {
  const builder = createDigestBuilder(providerSessionId);
  for (const line of lines) builder.add(line);
  return builder.finish();
}

/**
 * Разбор по одной строке: файл переписки не держится в памяти целиком, в
 * памяти только уже сжатые записи.
 */
function createDigestBuilder(providerSessionId: string | null) {
  const entries: DigestEntry[] = [];
  const changedFiles = new Map<string, number>();
  let order = 0;

  const add = (line: string): void => {
    if (!line.trim()) return;
    let entry: AnyRecord;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    // В файле бывают строки других разговоров (продолжения, ветки) — только свой.
    if (providerSessionId && entry.sessionId && entry.sessionId !== providerSessionId) return;
    if (entry.isSidechain) return;
    const at = typeof entry.timestamp === 'string' ? entry.timestamp : null;
    const content = entry.message?.content;

    if (entry.type === 'user') {
      if (entry.isCompactSummary) {
        const summary = stripInjectedContext(textOfContent(content));
        if (summary) entries.push({ kind: 'compact', at, text: clip(summary, COMPACT_SUMMARY_MAX_CHARS) });
        return;
      }
      if (entry.isMeta) return;
      if (entry.toolUseResult !== undefined || (Array.isArray(content) && content.some((p: AnyRecord) => p?.type === 'tool_result'))) {
        // Из результатов берём только короткие ошибки — след неудачной попытки.
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part?.type === 'tool_result' && part.is_error) {
              const errorText = typeof part.content === 'string' ? part.content : textOfContent(part.content);
              if (errorText.trim()) entries.push({ kind: 'action', text: `ошибка: ${oneLine(errorText, TOOL_ERROR_MAX_CHARS)}` });
            }
          }
        }
        return;
      }
      const raw = textOfContent(content).trim();
      if (isTranscriptServiceText(raw)) return;
      const text = stripInjectedContext(raw);
      if (!text && !hasImage(content)) return;
      const withImage = hasImage(content) ? `${text}${text ? ' ' : ''}[приложено изображение]` : text;
      entries.push({ kind: 'human', at, text: clip(withImage, HUMAN_MESSAGE_MAX_CHARS) });
      return;
    }

    if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          entries.push({ kind: 'assistant', at, text: clip(block.text.trim(), ASSISTANT_TEXT_MAX_CHARS) });
        } else if (block?.type === 'tool_use') {
          const described = describeToolUse(block);
          if (described) entries.push({ kind: 'action', text: described });
          const file = block.input?.file_path ?? block.input?.notebook_path;
          if (typeof file === 'string' && ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(block.name)) {
            changedFiles.set(file, order++);
          }
        }
      }
    }
  };

  const finish = (): TranscriptDigest => {
    const lastCompact = entries.map((entry) => entry.kind).lastIndexOf('compact');
    const out: string[] = [];
    let humanMessages = 0;
    entries.forEach((entry, index) => {
      const beforeCompaction = lastCompact >= 0 && index < lastCompact;
      if (beforeCompaction && entry.kind !== 'human') return;
      switch (entry.kind) {
        case 'human':
          humanMessages += 1;
          out.push(`\n${formatTime(entry.at)}ЧЕЛОВЕК: ${entry.text}`);
          break;
        case 'assistant':
          out.push(`${formatTime(entry.at)}АГЕНТ: ${entry.text}`);
          break;
        case 'action': {
          const line = `  · ${entry.text}`;
          // Одинаковые действия подряд (десять одинаковых правок одного файла) — одной строкой.
          if (out[out.length - 1] !== line) out.push(line);
          break;
        }
        case 'compact':
          out.push(`\n${formatTime(entry.at)}СВОДКА СЖАТИЯ (так агент чата помнил всё, что было до этого места):\n${entry.text}\n`);
          break;
      }
    });

    if (lastCompact > 0) {
      out.unshift('(До последнего сжатия чата ниже оставлены только сообщения человека; остальное до него пересказано в сводке сжатия.)');
    }

    return {
      text: out.join('\n').trim(),
      changedFiles: [...changedFiles.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, CHANGED_FILES_LIMIT)
        .map(([file]) => file),
      humanMessages,
      hadCompaction: lastCompact >= 0,
    };
  };

  return { add, finish };
}

/** Кусок файла переписки в байтах: `start` — с начала строки, `end` — не включая. */
export type TranscriptRange = { start?: number; end?: number };

/** Читает файл переписки построчно (файлы бывают по сотне мегабайт) и разбирает его. */
export async function digestTranscriptFile(
  filePath: string,
  providerSessionId: string | null,
  range: TranscriptRange = {},
): Promise<TranscriptDigest> {
  const builder = createDigestBuilder(providerSessionId);
  const { start = 0, end } = range;
  if (end !== undefined && end <= start) return builder.finish();
  const input = createReadStream(filePath, { encoding: 'utf8', start, ...(end !== undefined ? { end: end - 1 } : {}) });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of reader) builder.add(line);
  return builder.finish();
}

/**
 * Граница последней ЦЕЛОЙ строки файла: байт сразу после последнего перевода
 * строки. Чат пишет в файл прямо сейчас, последняя строка может быть
 * недописана — её дочитает следующий кусок, а не потеряет этот.
 */
export async function transcriptLineBoundary(filePath: string): Promise<number> {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const window = 256 * 1024;
    for (let to = size; to > 0; to -= window) {
      const from = Math.max(0, to - window);
      const buffer = Buffer.alloc(to - from);
      await handle.read(buffer, 0, buffer.length, from);
      const lastNewline = buffer.lastIndexOf(0x0a);
      if (lastNewline >= 0) return from + lastNewline + 1;
    }
    return 0;
  } finally {
    await handle.close();
  }
}

/**
 * Весь разговор чата текстом — слова человека и ответы агента ЦЕЛИКОМ, без
 * размышлений и вывода инструментов. Кладётся файлом рядом с выжимкой.
 *
 * Зачем (разбор 26.09.26): выжимка пересказывает, а готовые тексты —
 * промпт, письмо, список — пересказом не переносятся. В переносе 23.09 новый
 * чат сам сказал: «промпт целиком остался только в прошлом чате». Сырой файл
 * переписки для этого не годится: десятки мегабайт служебных записей, в них
 * не найти нужный ответ. Здесь — только разговор, по порядку, со временем.
 */
export async function exportDialogFile(
  filePath: string,
  providerSessionId: string | null,
  outPath: string,
  title: string,
): Promise<void> {
  await mkdir(path.dirname(outPath), { recursive: true });
  const out = createWriteStream(outPath, { encoding: 'utf8' });
  const write = (text: string) => new Promise<void>((resolve, reject) => {
    out.write(text, (error) => (error ? reject(error) : resolve()));
  });
  try {
    await write(`# Разговор чата «${title}» — слова человека и ответы агента целиком\n\n`);
    const reader = readline.createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line.trim()) continue;
      let entry: AnyRecord;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (providerSessionId && entry.sessionId && entry.sessionId !== providerSessionId) continue;
      if (entry.isSidechain || entry.isMeta || entry.isCompactSummary) continue;
      const at = typeof entry.timestamp === 'string' ? entry.timestamp : null;
      const content = entry.message?.content;
      if (entry.type === 'user') {
        if (entry.toolUseResult !== undefined || (Array.isArray(content) && content.some((p: AnyRecord) => p?.type === 'tool_result'))) continue;
        const raw = textOfContent(content).trim();
        if (isTranscriptServiceText(raw)) continue;
        const text = stripInjectedContext(raw);
        if (!text) continue;
        await write(`## ${formatTime(at)}Человек\n\n${text}\n\n`);
      } else if (entry.type === 'assistant' && Array.isArray(content)) {
        const text = content
          .filter((block: AnyRecord) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim())
          .map((block: AnyRecord) => block.text.trim())
          .join('\n\n');
        if (text) await write(`## ${formatTime(at)}Агент\n\n${text}\n\n`);
      }
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
  }
}

/** Размер файла переписки — сколько байт уже разобрано заготовкой. */
export async function transcriptSize(filePath: string): Promise<number> {
  return (await stat(filePath)).size;
}

/**
 * Возврат чата Devin к своему сообщению — «отменить всё, что было после, и
 * переписать».
 *
 * У Claude разговор — построчный файл, возврат — его обрезка. У Devin
 * разговор — дерево узлов в общей `sessions.db`, а живая ветка задана
 * указателем `sessions.main_chain_id`: и `session/load`, и лента сайта читают
 * беседу от него вверх по родителям. Возврат — перенос указателя на родителя
 * выбранного сообщения: оно и всё за ним перестают быть частью беседы, но
 * остаются в таблице брошенной веткой — ровно так же Devin хранит ветки,
 * отрезанные собственным `/revert` (проверено живым `session/load`: после
 * переноса повтор читает новую вершину, хвоста нет).
 *
 * Ничего не удаляется. Перед переносом прошлый указатель и список
 * отцепляемых узлов пишется в `<devin-runs>/rewind/<чат>-<время>.json` — по
 * нему же распознаётся повторное нажатие (ответ на телефон не дошёл, окно
 * ждёт, человек жмёт ещё раз).
 */
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import { isSurvivorRunning, stopSurvivor } from '@/modules/providers/list/claude/survivor-runs.js';
import { providerRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import { chatRunRegistry, clearChatQueue, listChatQueue } from '@/modules/websocket/index.js';
import { parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';
import {
  AppError,
  getDevinDatabasePath,
  readJsonRecord,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

import { devinRunsDir } from './devin-acp-client.js';
import { liveDevinChain, type DevinChainRow } from './devin-chain.js';

/** Сколько ждём остановку хода Devin перед переносом указателя. */
const STOP_WAIT_MS = 15_000;
const POLL_MS = 250;
/** Пауза после остановки: супервизор дописывает последние узлы хода. */
const SETTLE_MS = 700;
/** Столько после возврата повторное нажатие на то же сообщение считаем тем же возвратом. */
const REPEAT_WINDOW_MS = 30 * 60_000;

/** Узел живой цепочки с текстом реплики человека (null — не реплика). */
type DevinChainNode = {
  nodeId: number;
  parentId: number | null;
  text: string | null;
};

export type DevinRewindResult = {
  /** Текст сообщения, к которому вернулись, — подставляется в поле ввода. */
  text: string;
  /** Тексты из очереди, снятой при возврате. */
  queuedTexts: string[];
  /** Сколько узлов отцеплено от живой цепочки. */
  removedLines: number;
  /** Файл с прошлым указателем и списком отцепленных узлов. */
  backupPath: string;
};

/**
 * Текст реплики человека без служебных блоков `<images_input>`/`<files_input>`:
 * этот текст уезжает в поле ввода, а вложенные файлы возврат не восстанавливает
 * (как и у Claude — переписывается только текст). `null` — служебный узел или
 * ответ агента.
 */
function cleanUserText(content: unknown): string | null {
  if (typeof content === 'string') {
    const text = parseImagesInputTag(parseFilesInputTag(content).text).text.trim();
    return text || null;
  }
  // Типизированный ввод ACP — массив блоков; текст внутри может нести те же теги.
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const record = readObjectRecord(block);
      if (!record) continue;
      const inner = readObjectRecord(record.content) ?? record;
      const blockType = readOptionalString(record.type);
      const text = blockType === 'content' || !blockType
        ? readOptionalString(inner.text)
        : blockType === 'text'
          ? readOptionalString(inner.text)
          : null;
      if (text) parts.push(parseImagesInputTag(parseFilesInputTag(text).text).text);
    }
    const joined = parts.join('\n').trim();
    return joined || null;
  }
  return null;
}

function devinUserText(chatMessageJson: string): string | null {
  const message = readJsonRecord(chatMessageJson);
  if (!message || readOptionalString(message.role) !== 'user') return null;
  const metadata = readObjectRecord(message.metadata);
  if (metadata?.is_user_input !== true) return null;
  return cleanUserText(message.content);
}

/** Лента кладёт в номер сообщения номер узла (`devin_<nodeId>`). */
function nodeIdFromMessageId(messageId: string | null): number | null {
  if (!messageId) return null;
  const match = /^devin_(\d+)/.exec(messageId);
  return match ? Number(match[1]) : null;
}

/**
 * Как у Claude-возврата: сравнение без служебной обёртки и лишних пробелов.
 * `<images_input>`/`<files_input>` снимаются — лента шлёт текст уже без них,
 * а в базе они лежат внутри реплики.
 */
function comparable(text: string): string {
  return (cleanUserText(text) ?? '')
    .replace(/<files>[\s\S]*?<\/files>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function openDevinDbWritable(dbPath: string): InstanceType<typeof Database> {
  return new Database(dbPath);
}

/** Живая цепочка от вершины к корню с текстами реплик человека. */
function liveChain(db: InstanceType<typeof Database>, providerSessionId: string): DevinChainNode[] {
  const chain = liveDevinChain(db, providerSessionId);
  if (chain.length === 0) {
    throw new AppError('Беседы нет у Devin.', { code: 'REWIND_NO_SESSION', statusCode: 404 });
  }
  // Цепочка приходит от корня к вершине — откату удобнее от свежего.
  return chain
    .map((row: DevinChainRow) => ({
      nodeId: row.nodeId,
      parentId: row.parentId,
      text: devinUserText(row.chatMessage),
    }))
    .reverse();
}

/**
 * Сообщение, от которого возвращаемся: по номеру узла (`devin_42`), по номеру
 * сообщения Devin внутри узла либо по тексту — последнее совпадение, как у
 * Claude-возврата (одинаковые «продолжай» в длинном чате — обычное дело).
 */
function locateDevinTarget(
  chain: DevinChainNode[],
  messageId: string | null,
  text: string | null,
): DevinChainNode | null {
  const wantedNodeId = nodeIdFromMessageId(messageId);
  if (wantedNodeId !== null) {
    const hit = chain.find((node) => node.nodeId === wantedNodeId);
    if (hit && hit.text !== null) return hit;
  }
  const wantedText = text ? comparable(text) : '';
  if (!wantedText) return null;
  // Цепочка идёт от свежего к корню: первое совпадение — самое новое, как
  // «последняя такая строка» у Claude-возврата (два одинаковых «продолжай»).
  for (const node of chain) {
    if (node.text !== null && comparable(node.text) === wantedText) return node;
  }
  return null;
}

type DevinRewindBackup = {
  sessionId: string;
  providerSessionId: string;
  previousTip: number | null;
  removedNodeIds: number[];
  targetNodeId: number;
  targetText: string;
  queuedTexts: string[];
  at: string;
};

function backupDir(): string {
  return path.join(devinRunsDir(), 'rewind');
}

function backupStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Повтор того же возврата: узел уже вне живой цепочки, а в свежей копии он
 * был отцеплён последним возвратом — отдаём тот же текст, как и Claude-ветка.
 */
async function findRepeatedRewind(
  appSessionId: string,
  messageId: string | null,
  text: string | null,
): Promise<DevinRewindResult | null> {
  const dir = backupDir();
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).filter((name) => name.startsWith(`${appSessionId}-`));
  } catch {
    return null;
  }
  const wantedNodeId = nodeIdFromMessageId(messageId);
  const wantedText = text ? comparable(text) : '';
  let latest: { backup: DevinRewindBackup; name: string; at: number } | null = null;
  for (const name of names) {
    try {
      const backup = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8')) as DevinRewindBackup;
      const at = Date.parse(backup.at);
      if (Number.isNaN(at) || Date.now() - at > REPEAT_WINDOW_MS) continue;
      if (!latest || latest.at < at) latest = { backup, name, at };
    } catch {
      // Битый файл копии пропускаем.
    }
  }
  if (!latest) return null;
  const sameTarget = wantedNodeId !== null
    ? latest.backup.targetNodeId === wantedNodeId || latest.backup.removedNodeIds.includes(wantedNodeId)
    : wantedText !== '' && comparable(latest.backup.targetText) === wantedText;
  if (!sameTarget) return null;
  return {
    text: latest.backup.targetText,
    queuedTexts: latest.backup.queuedTexts,
    removedLines: 0,
    backupPath: path.join(dir, latest.name),
  };
}

/** Останавливает ход: живой — отменой через ACP, переживший рестарт — сигналом. */
async function stopRun(appSessionId: string): Promise<void> {
  const run = chatRunRegistry.getRun(appSessionId);
  if (run && run.status === 'running') {
    const stopped = await providerRuntimeService.abort(run.provider, appSessionId);
    chatRunRegistry.completeRun(appSessionId, { exitCode: stopped ? 0 : 1, aborted: true });
  } else if (isSurvivorRunning(appSessionId)) {
    stopSurvivor(appSessionId);
  }
}

/** Останавливает идущий ход и ждёт, пока реестр его отпустит. */
async function stopAndWaitIdle(appSessionId: string): Promise<void> {
  const deadline = Date.now() + STOP_WAIT_MS;
  let lastStopAt = 0;
  while (Date.now() < deadline) {
    const busy = chatRunRegistry.isProcessing(appSessionId) || isSurvivorRunning(appSessionId);
    if (busy) {
      if (Date.now() - lastStopAt > 2_000) {
        await stopRun(appSessionId);
        lastStopAt = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      continue;
    }
    // Хода нет — даём супервизору миг на дописывание узлов и выходим.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    if (!chatRunRegistry.isProcessing(appSessionId) && !isSurvivorRunning(appSessionId)) return;
  }
  throw new AppError('Агент не остановился за 15 секунд — попробуйте ещё раз.', {
    code: 'REWIND_AGENT_BUSY',
    statusCode: 409,
  });
}

/**
 * Потребитель: `session-rewind.service.ts` — кнопка «Вернуться сюда» под
 * сообщением человека в чате Devin. Доступ ограничен владельцем площадки там
 * же, где ограничен сам запуск Devin (websocket-гейт), поэтому здесь
 * дополнительной проверки нет.
 */
export async function rewindDevinSession(input: {
  sessionId: string;
  providerSessionId: string;
  messageId: string | null;
  text: string | null;
}): Promise<DevinRewindResult> {
  const dbPath = getDevinDatabasePath();
  if (!fsSync.existsSync(dbPath)) {
    throw new AppError('Хранилище бесед Devin недоступно.', { code: 'REWIND_NO_TRANSCRIPT', statusCode: 404 });
  }

  const reader = new Database(dbPath, { readonly: true, fileMustExist: true });
  let target: DevinChainNode | null = null;
  try {
    target = locateDevinTarget(liveChain(reader, input.providerSessionId), input.messageId, input.text);
  } finally {
    reader.close();
  }
  if (!target) {
    const repeated = await findRepeatedRewind(input.sessionId, input.messageId, input.text);
    if (repeated) {
      console.log('[Возврат к сообщению] Devin, повторно — уже возвращено', {
        sessionId: input.sessionId,
        backupPath: repeated.backupPath,
      });
      return repeated;
    }
    throw new AppError('Не нашёл это сообщение в разговоре.', {
      code: 'REWIND_MESSAGE_NOT_FOUND',
      statusCode: 404,
    });
  }

  // Очередь снимаем до остановки — как у Claude-ветки: конец хода отправил
  // бы её поверх отката, а тексты человека пропали бы.
  const queuedTexts = listChatQueue(input.sessionId)
    .map((item) => item.content)
    .filter((content) => typeof content === 'string' && content.trim());
  if (queuedTexts.length > 0) clearChatQueue(input.sessionId);

  await stopAndWaitIdle(input.sessionId);

  const lateQueued = listChatQueue(input.sessionId)
    .map((item) => item.content)
    .filter((content) => typeof content === 'string' && content.trim());
  if (lateQueued.length > 0) {
    clearChatQueue(input.sessionId);
    queuedTexts.push(...lateQueued);
  }

  const db = openDevinDbWritable(dbPath);
  try {
    // Цепочку читаем заново: за время остановки ход мог дописать узлы, и
    // переносить указатель нужно от актуальной вершины.
    const chain = liveChain(db, input.providerSessionId);
    const freshTarget = locateDevinTarget(chain, input.messageId, input.text);
    if (!freshTarget) {
      throw new AppError('Не нашёл это сообщение в разговоре.', {
        code: 'REWIND_MESSAGE_NOT_FOUND',
        statusCode: 404,
      });
    }

    const sessionRow = db
      .prepare('SELECT main_chain_id FROM sessions WHERE id = ?')
      .get(input.providerSessionId) as { main_chain_id: number | null };
    // Отцеплены и выбранная реплика (она уходит в поле ввода), и всё за ней.
    const removedNodeIds = chain
      .slice(0, chain.findIndex((node) => node.nodeId === freshTarget.nodeId) + 1)
      .map((node) => node.nodeId);

    await fsp.mkdir(backupDir(), { recursive: true });
    const backupPath = path.join(backupDir(), `${input.sessionId}-${backupStamp()}.json`);
    const backup: DevinRewindBackup = {
      sessionId: input.sessionId,
      providerSessionId: input.providerSessionId,
      previousTip: sessionRow.main_chain_id,
      removedNodeIds,
      targetNodeId: freshTarget.nodeId,
      targetText: freshTarget.text ?? '',
      queuedTexts,
      at: new Date().toISOString(),
    };
    await fsp.writeFile(backupPath, JSON.stringify(backup, null, 2), 'utf8');

    // Новая вершина — родитель выбранного сообщения: оно само и всё за ним
    // уходят из беседы, но остаются узлами-веткой в таблице.
    db.prepare('UPDATE sessions SET main_chain_id = ? WHERE id = ?').run(
      freshTarget.parentId,
      input.providerSessionId,
    );

    console.log('[Возврат к сообщению] Devin', {
      sessionId: input.sessionId,
      providerSessionId: input.providerSessionId,
      removedNodes: removedNodeIds.length,
      backupPath,
    });

    return {
      text: freshTarget.text ?? '',
      queuedTexts,
      removedLines: removedNodeIds.length,
      backupPath,
    };
  } finally {
    db.close();
  }
}

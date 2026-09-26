/**
 * Возврат чата к своему сообщению — «отменить всё, что было после, и
 * переписать».
 *
 * Зачем. Агент понял задачу не так или ушёл не туда. До сих пор была только
 * «Отмена» хода: неудачная попытка оставалась в разговоре, и следующее
 * сообщение «нет, я имел в виду другое» агент читал поверх неё. Возврат
 * убирает из разговора выбранное сообщение и всё, что шло за ним, — как
 * «rewind» в Claude Code. Текст сообщения возвращается в поле ввода, его
 * можно поправить и отправить заново.
 *
 * Как. Разговор — построчный файл (JSONL), строки дописываются в конец.
 * Возврат — это обрезка файла по началу строки выбранного сообщения. Чат
 * остаётся тем же (тот же номер, вкладка, место в списке), а следующий ход
 * агента продолжает с последней оставшейся реплики.
 *
 * Ничего не теряется: перед обрезкой полная копия файла кладётся рядом
 * (`<файл>.before-rewind-<время>`). Расширение у неё не `.jsonl`, поэтому ни
 * список чатов, ни сам Claude Code её за разговор не принимают.
 *
 * Память. Файлы разговоров бывают по 70 МБ, у службы потолок 450 МБ. Поэтому
 * файл читается построчно (в памяти одна строка), копия делается средствами
 * системы, а обрезка — на месте.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import readline from 'node:readline';

import { sessionsDb } from '@/modules/database/index.js';
import { isSurvivorRunning, stopSurvivor } from '@/modules/providers/list/claude/survivor-runs.js';
import { forgetTranscriptTail } from '@/modules/providers/list/claude/transcript-tail-cache.js';
import { providerRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import { chatRunRegistry, clearChatQueue, listChatQueue } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';

type JsonlRecord = Record<string, any>;

/** Сколько ждём, пока остановленный агент допишет последние строки. */
const STOP_WAIT_MS = 15_000;
/** Файл не меняется столько — считаем, что агент затих. */
const QUIET_MS = 1_000;
const POLL_MS = 250;

const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export type RewindResult = {
  /** Текст сообщения, к которому вернулись, — подставляется в поле ввода. */
  text: string;
  /** Тексты из очереди, снятой при возврате: они тоже вернутся в поле ввода. */
  queuedTexts: string[];
  /** Сколько строк разговора убрано. */
  removedLines: number;
  /** Где лежит полная копия разговора до возврата. */
  backupPath: string;
};

/** Текст реплики человека; `null` — это не реплика (результат действия, служебное). */
function userText(record: JsonlRecord): string | null {
  // Сообщение, отправленное, пока агент работал, лежит не строкой `user`, а
  // вставкой `queued_command` (так же его читает лента, claude-sessions.provider).
  if (record?.type === 'attachment' && record.attachment?.type === 'queued_command') {
    const attachment = record.attachment;
    if (attachment.commandMode && attachment.commandMode !== 'prompt') return null;
    if (typeof attachment.prompt === 'string') return attachment.prompt;
    if (Array.isArray(attachment.prompt)) {
      return attachment.prompt
        .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
        .map((part: any) => part.text as string)
        .join('\n');
    }
    return null;
  }
  if (record?.type !== 'user' || record.isMeta === true || record.isSidechain === true) return null;
  const content = record.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  if (content.some((part) => part?.type === 'tool_result')) return null;
  const text = content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
  const hasImage = content.some((part) => part?.type === 'image');
  return text || hasImage ? text : null;
}

/**
 * Лента показывает реплику без служебной обёртки вложений (`<files>…</files>`)
 * и без пробелов по краям. Для сравнения приводим обе стороны к этому виду.
 */
function comparable(text: string): string {
  return text.replace(/<files>[\s\S]*?<\/files>/g, '').replace(/\s+/g, ' ').trim();
}

/** Лента кладёт в свой номер сообщения номер строки разговора (`<uuid>_text_0`). */
function uuidFromMessageId(messageId: string | null): string | null {
  const match = messageId ? UUID_PREFIX.exec(messageId) : null;
  return match ? match[0].toLowerCase() : null;
}

/**
 * Находит строку выбранного сообщения и байт, с которого она начинается.
 *
 * Сначала по номеру строки. Только что отправленное сообщение номера в ленте
 * ещё не имеет — тогда по тексту, и берём ПОСЛЕДНЕЕ совпадение: одинаковые
 * «продолжай» в длинном чате — обычное дело, а человек почти всегда
 * возвращается к недавнему.
 */
async function locateTarget(
  jsonlPath: string,
  uuid: string | null,
  text: string | null,
): Promise<{ offset: number; text: string; totalLines: number; lineIndex: number } | null> {
  const wanted = text ? comparable(text) : '';
  let byUuid: { offset: number; text: string; lineIndex: number } | null = null;
  let byText: { offset: number; text: string; lineIndex: number } | null = null;

  const stream = fs.createReadStream(jsonlPath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let offset = 0;
  let lineIndex = 0;
  for await (const line of rl) {
    const lineStart = offset;
    // readline отдаёт строку без перевода строки: +1 за него.
    offset += Buffer.byteLength(line, 'utf8') + 1;
    const index = lineIndex;
    lineIndex += 1;
    if (byUuid || !(line.includes('"user"') || line.includes('"queued_command"'))) continue;

    let record: JsonlRecord;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const recordText = userText(record);
    if (recordText === null) continue;

    if (uuid && typeof record.uuid === 'string' && record.uuid.toLowerCase() === uuid) {
      byUuid = { offset: lineStart, text: recordText, lineIndex: index };
      continue;
    }
    if (wanted && comparable(recordText) === wanted) {
      byText = { offset: lineStart, text: recordText, lineIndex: index };
    }
  }

  const found = byUuid ?? byText;
  return found ? { ...found, totalLines: lineIndex } : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Останавливает идущий ход и ждёт, пока агент затихнет: остановленный процесс
 * ещё долю секунды дописывает хвост, и дописанное после обрезки вернуло бы в
 * разговор куски отменённой попытки.
 */
async function stopRun(appSessionId: string): Promise<void> {
  const run = chatRunRegistry.getRun(appSessionId);
  if (run && run.status === 'running') {
    const stopped = await providerRuntimeService.abort(run.provider, appSessionId);
    chatRunRegistry.completeRun(appSessionId, { exitCode: stopped ? 0 : 1, aborted: true });
  } else if (isSurvivorRunning(appSessionId)) {
    stopSurvivor(appSessionId);
  }
}

async function stopAndWaitQuiet(appSessionId: string, jsonlPath: string): Promise<void> {
  await stopRun(appSessionId);
  let lastStopAt = Date.now();

  const deadline = Date.now() + STOP_WAIT_MS;
  let lastSize = -1;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    const size = (await fsp.stat(jsonlPath)).size;
    const busy = chatRunRegistry.isProcessing(appSessionId);
    // Ход завёлся заново (очередь успела отправить сообщение между снятием и
    // остановкой) — останавливаем и его, не чаще раза в две секунды.
    if (busy && Date.now() - lastStopAt > 2_000) {
      await stopRun(appSessionId);
      lastStopAt = Date.now();
    }
    if (busy || size !== lastSize) {
      lastSize = size;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= QUIET_MS) {
      return;
    }
    await sleep(POLL_MS);
  }
  throw new AppError('Агент не остановился за 15 секунд — попробуйте ещё раз.', {
    code: 'REWIND_AGENT_BUSY',
    statusCode: 409,
  });
}

/** Байт `offset` — начало строки записи: перед ним `\n` (или это начало файла), с него идёт `{`. */
async function isLineStart(jsonlPath: string, offset: number): Promise<boolean> {
  const handle = await fsp.open(jsonlPath, 'r');
  try {
    const buffer = Buffer.alloc(2);
    const start = Math.max(0, offset - 1);
    const { bytesRead } = await handle.read(buffer, 0, 2, start);
    if (offset === 0) return bytesRead >= 1 && buffer[0] === 0x7b;
    return bytesRead === 2 && buffer[0] === 0x0a && buffer[1] === 0x7b;
  } finally {
    await handle.close();
  }
}

function backupStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Потребитель: `provider.routes.ts` (`POST /sessions/:sessionId/rewind`) —
 * кнопка «Вернуться сюда» под сообщением человека в ленте.
 */
export const sessionRewindService = {
  async rewind(input: {
    sessionId: string;
    messageId: string | null;
    text: string | null;
  }): Promise<RewindResult> {
    const session = sessionsDb.getSessionById(input.sessionId);
    if (!session) {
      throw new AppError('Чат не найден.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    }
    if (session.provider !== 'claude') {
      throw new AppError('Возврат к сообщению пока есть только для чатов Claude.', {
        code: 'REWIND_UNSUPPORTED_PROVIDER',
        statusCode: 400,
      });
    }
    const jsonlPath = session.jsonl_path;
    if (!jsonlPath || !fs.existsSync(jsonlPath)) {
      throw new AppError('Файл разговора не найден.', { code: 'REWIND_NO_TRANSCRIPT', statusCode: 404 });
    }

    const uuid = uuidFromMessageId(input.messageId);
    // Проверяем, что сообщение есть, ДО остановки агента: если найти его
    // нельзя, работающий ход не должен оборваться зря.
    if (!(await locateTarget(jsonlPath, uuid, input.text))) {
      throw new AppError('Не нашёл это сообщение в разговоре.', {
        code: 'REWIND_MESSAGE_NOT_FOUND',
        statusCode: 404,
      });
    }

    // Очередь снимаем до остановки: иначе конец хода тут же отправил бы из неё
    // следующее сообщение — поверх обрезки. Тексты очереди не теряются, они
    // уходят в поле ввода вместе с текстом выбранного сообщения.
    const queuedTexts = listChatQueue(input.sessionId)
      .map((item) => item.content)
      .filter((content) => typeof content === 'string' && content.trim());
    if (queuedTexts.length > 0) clearChatQueue(input.sessionId);

    await stopAndWaitQuiet(input.sessionId, jsonlPath);

    // Второй раз — на случай, если в очередь что-то поставили, пока агент
    // останавливался.
    const lateQueued = listChatQueue(input.sessionId)
      .map((item) => item.content)
      .filter((content) => typeof content === 'string' && content.trim());
    if (lateQueued.length > 0) {
      clearChatQueue(input.sessionId);
      queuedTexts.push(...lateQueued);
    }

    // Место ищем заново: пока агент останавливался, файл дописался.
    const target = await locateTarget(jsonlPath, uuid, input.text);
    if (!target) {
      throw new AppError('Не нашёл это сообщение в разговоре.', {
        code: 'REWIND_MESSAGE_NOT_FOUND',
        statusCode: 404,
      });
    }

    // Страховка сдвига: обрезаем только ровно по началу строки. Иначе
    // (например, переводы строк `\r\n`) лучше отказать, чем испортить разговор.
    if (!(await isLineStart(jsonlPath, target.offset))) {
      throw new AppError('Не удалось точно найти место в разговоре — ничего не менял.', {
        code: 'REWIND_BAD_OFFSET',
        statusCode: 500,
      });
    }

    const backupPath = `${jsonlPath}.before-rewind-${backupStamp()}`;
    await fsp.copyFile(jsonlPath, backupPath);
    await fsp.truncate(jsonlPath, target.offset);
    forgetTranscriptTail(jsonlPath);

    console.log('[Возврат к сообщению]', {
      sessionId: input.sessionId,
      removedLines: target.totalLines - target.lineIndex,
      backupPath,
    });

    return {
      text: target.text,
      queuedTexts,
      removedLines: target.totalLines - target.lineIndex,
      backupPath,
    };
  },
};

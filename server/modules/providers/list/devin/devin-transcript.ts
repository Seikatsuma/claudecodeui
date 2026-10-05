/**
 * Экспорт беседы Devin в построчный файл формата переписки Claude.
 *
 * Зачем. «Продолжить в новом чате» (server/modules/handoff) читает разговор
 * построчным JSONL: дайджест, файл всего разговора и последние правки кода
 * собираются одним разбором. У Devin разговор — узлы в общей `sessions.db`,
 * поэтому перед переносом живая цепочка выгружается в файл рядом с рабочими
 * файлами кнопки (`<аккаунт>/handoffs/devin-<чат>.jsonl`), а дальше весь
 * конвейер работает без изменений.
 *
 * Форма записей — та, что понимает handoff-digest: `type: 'user'|'assistant'`
 * с `message.content` (строка или блоки text/tool_use/tool_result), `sessionId`
 * — номер беседы Devin (дайджест отбрасывает записи не своего разговора),
 * `timestamp` — ISO. Имена действий Devin переводятся в привычные дайджесту
 * (exec→Bash, edit→Edit и т.п.), чтобы карта файлов и «действия агента»
 * читались так же, как у Claude-чата.
 *
 * Экспорт стабилен по префиксу: перезапись при дописанных в конец узлах не
 * меняет начало файла, поэтому заготовка выжимки (prepareHandoff) проверяет
 * свежесть по байтовому отпечатку, как у обычной переписки.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import { getDevinDatabasePath, readJsonRecord, readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { fullDevinConversation } from './devin-chain.js';

/** Действия Devin → имена, которые описывает дайджест (карта файлов, «· действие»). */
const TOOL_NAME_MAP: Record<string, string> = {
  exec: 'Bash',
  edit: 'Edit',
  write: 'Write',
  notebook_edit: 'NotebookEdit',
  read: 'Read',
  webfetch: 'WebFetch',
  web_search: 'WebSearch',
  run_subagent: 'Task',
  skill: 'Skill',
};

type AnyRecord = Record<string, any>;

function timestampOf(rowCreatedAt: number | null, metadata: AnyRecord | null): string | null {
  const at = readOptionalString(metadata?.created_at);
  if (at) return at;
  return typeof rowCreatedAt === 'number' ? new Date(rowCreatedAt * 1000).toISOString() : null;
}

/** Аргументы действия под имя, которое ждёт дайджест. */
function mapToolInput(name: string, args: AnyRecord): AnyRecord {
  if (name === 'run_subagent') {
    return { description: readOptionalString(args.title) ?? readOptionalString(args.task) ?? '' };
  }
  return args;
}

/**
 * Узел беседы → записи переписки (0 или 1). Служебные узлы (system,
 * внутренние запросы самого Devin вроде «Now summarize…») в экспорт не идут:
 * человеку и новому агенту они не нужны.
 */
function nodeToRecords(
  providerSessionId: string,
  rowChatMessage: string,
  rowCreatedAt: number | null,
): AnyRecord[] {
  const message = readJsonRecord(rowChatMessage);
  if (!message) return [];
  const role = readOptionalString(message.role);
  const metadata = readObjectRecord(message.metadata);
  const timestamp = timestampOf(rowCreatedAt, metadata);
  const base = { sessionId: providerSessionId, timestamp };

  if (role === 'user') {
    if (metadata?.is_user_input !== true) return [];
    return [{ ...base, type: 'user', message: { role: 'user', content: message.content } }];
  }

  if (role === 'assistant') {
    const content: AnyRecord[] = [];
    const text = readOptionalString(message.content);
    if (text && text.trim()) content.push({ type: 'text', text });
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const call of toolCalls) {
      const rawName = readOptionalString(call?.name) ?? '';
      const args = readObjectRecord(call?.arguments) ?? {};
      content.push({
        type: 'tool_use',
        name: TOOL_NAME_MAP[rawName] ?? rawName,
        input: mapToolInput(rawName, args),
      });
    }
    if (content.length === 0) return [];
    return [{ ...base, type: 'assistant', message: { role: 'assistant', content } }];
  }

  if (role === 'tool') {
    const resultMeta = readObjectRecord(metadata?.extensions)?.['chisel/tool_result_meta'];
    const failed = readObjectRecord(resultMeta)?.success === false;
    return [{
      ...base,
      type: 'user',
      toolUseResult: message.content,
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: readOptionalString(message.tool_call_id) ?? undefined,
          content: message.content,
          is_error: failed,
        }],
      },
    }];
  }

  return [];
}

/**
 * Потребитель: `handoff.service.ts` (`resolveSource` для provider='devin') —
 * «Продолжить в новом чате». Выгружает живую цепочку беседы в `outPath`
 * (перезаписывает), возвращает число записанных записей. Пустая беседа — 0,
 * файл при этом всё равно создаётся пустым.
 */
export async function exportDevinTranscript(providerSessionId: string, outPath: string): Promise<number> {
  const db = new Database(getDevinDatabasePath(), { readonly: true, fileMustExist: true });
  let lines: string[] = [];
  try {
    for (const row of fullDevinConversation(db, providerSessionId)) {
      for (const record of nodeToRecords(providerSessionId, row.chatMessage, row.createdAt)) {
        lines.push(JSON.stringify(record));
      }
    }
  } finally {
    db.close();
  }
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
  return lines.length;
}

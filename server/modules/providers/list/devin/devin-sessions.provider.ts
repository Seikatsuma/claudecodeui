import fsSync from 'node:fs';

import Database from 'better-sqlite3';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
} from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  getDevinDatabasePath,
  normalizeProviderTimestamp,
  readJsonRecord,
  readObjectRecord,
  readOptionalString,
  sliceTailPage,
} from '@/shared/utils.js';

import { fullDevinConversation } from './devin-chain.js';

const PROVIDER = 'devin' as const;

/**
 * Opens the shared Devin session database for read-only access.
 *
 * Returns null when Devin has never run on this account. Callers must close
 * the handle themselves — the database is shared across every Devin session,
 * never per-session storage.
 */
export function openDevinDatabase(dbPath = getDevinDatabasePath()): InstanceType<typeof Database> | null {
  if (!fsSync.existsSync(dbPath)) {
    return null;
  }

  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

type DevinMessageNodeRow = {
  node_id: number;
  parent_node_id: number | null;
  chat_message: string;
  created_at: number | null;
};

/** The update payload of one ACP `session/update` notification. */
type DevinAcpUpdate = AnyRecord & { sessionUpdate?: string };

/**
 * Devin's own session modes mapped onto the UI permission-mode vocabulary.
 * The runtime uses the same table for `session/set_mode`.
 */
export const DEVIN_PERMISSION_MODE_MAP: Record<string, string> = {
  bypassPermissions: 'bypass',
  acceptEdits: 'accept-edits',
  auto: 'smart',
  plan: 'plan',
};

export function mapPermissionModeToDevinMode(permissionMode?: string | null): string | undefined {
  if (!permissionMode || permissionMode === 'default') {
    // 'default' means "whatever Devin is configured with" — never a forced mode.
    return undefined;
  }
  return DEVIN_PERMISSION_MODE_MAP[permissionMode] ?? permissionMode;
}

/**
 * Devin tool calls arrive as ACP `tool_call`/`tool_call_update` updates whose
 * `kind` is a coarse category (read/edit/execute/fetch/think/...). The real
 * tool name travels in `_meta['cognition.ai/inferenceToolName']` (or the
 * human-readable `title` as a last resort).
 */
function readToolName(update: DevinAcpUpdate): string {
  const meta = readObjectRecord(update._meta);
  return readOptionalString(meta?.['cognition.ai/inferenceToolName'])
    ?? readOptionalString(update.title)
    ?? 'Tool';
}

function readToolCallContent(update: DevinAcpUpdate): string {
  const parts: string[] = [];
  const content = Array.isArray(update.content) ? update.content : [];
  for (const block of content) {
    const record = readObjectRecord(block);
    if (!record) {
      continue;
    }
    // ACP blocks: {type:'content', content:{type:'text',text}} or plain text.
    const text = readOptionalString(record.text)
      ?? readOptionalString((record.content as AnyRecord | undefined)?.text)
      ?? readOptionalString(record.content as string | undefined);
    if (text) {
      parts.push(text);
      continue;
    }
    // diff blocks carry {path, oldText, newText}; everything else we show raw-ish.
    if (readOptionalString(record.type) === 'diff') {
      const filePath = readOptionalString(record.path);
      if (filePath) {
        parts.push(`Diff: ${filePath}`);
      }
    }
  }
  return parts.join('\n').trim();
}

export class DevinSessionsProvider implements IProviderSessions {
  /**
   * Normalizes one ACP `session/update` payload into frontend messages.
   * Expects the notification's `params.update` object (or the whole params).
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    const update = (readObjectRecord(raw.update) ?? raw) as DevinAcpUpdate;
    const updateType = readOptionalString(update.sessionUpdate);
    const eventSessionId = readOptionalString(raw.sessionId) ?? sessionId;

    if (updateType === 'agent_message_chunk') {
      // Chunk boundaries carry real spaces — readOptionalString trims and
      // glued words together on screen; stream text must stay verbatim.
      const chunkBlock = readObjectRecord(update.content as AnyRecord | undefined);
      const text = typeof chunkBlock?.text === 'string' ? chunkBlock.text : '';
      if (!text) {
        return [];
      }
      return [createNormalizedMessage({
        sessionId: eventSessionId,
        provider: PROVIDER,
        kind: 'stream_delta',
        content: text,
      })];
    }

    if (updateType === 'agent_thought_chunk') {
      const thoughtBlock = readObjectRecord(update.content as AnyRecord | undefined);
      const text = typeof thoughtBlock?.text === 'string' ? thoughtBlock.text : '';
      // Empty chunks still count: they mark "the model is thinking" so the
      // activity indicator stops guessing phases.
      return [createNormalizedMessage({
        sessionId: eventSessionId,
        provider: PROVIDER,
        kind: 'thinking_delta',
        content: text,
      })];
    }

    if (updateType === 'tool_call') {
      // ACP шлёт текст сплошным потоком `agent_message_chunk` без границ
      // блоков (нет аналога Claude'овского content_block_stop, на котором
      // клиент закрывает живую строку). Вызов инструмента — единственная
      // жёсткая граница: накопленный перед ним текст — законченный блок.
      // Без stream_end клиент склеивал весь ход в одну живую строку:
      // статусная реплика слипалась с финальным ответом, ни с одним узлом на
      // диске такая строка не совпадала — и ответ вставал в ленту второй раз
      // под «Ходом работы» (04.10.26, снимок Егора). Лишний stream_end подряд
      // безопасен: аккумулятор пуст, финализировать нечего.
      const toolId = readOptionalString(update.toolCallId) ?? generateMessageId('devin-tool');
      return [
        createNormalizedMessage({
          sessionId: eventSessionId,
          provider: PROVIDER,
          kind: 'stream_end',
        }),
        createNormalizedMessage({
          id: toolId,
          sessionId: eventSessionId,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: readToolName(update),
          toolId,
          toolInput: update.rawInput ?? {},
        }),
      ];
    }

    if (updateType === 'tool_call_update') {
      const status = readOptionalString(update.status);
      if (status !== 'completed' && status !== 'failed') {
        return [];
      }
      const toolId = readOptionalString(update.toolCallId);
      // Frontend attaches results via `tr.content` on the whole message
      // (useChatMessages.ts) — top-level content/isError required, same as
      // claude's tool_result shape; nested toolResult kept for consumers.
      const resultText = readToolCallContent(update)
        || (typeof update.rawOutput === 'string' ? update.rawOutput : '')
        || (status === 'failed' ? 'Tool call failed' : '');
      return [createNormalizedMessage({
        sessionId: eventSessionId,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: toolId ?? undefined,
        content: resultText,
        isError: status === 'failed',
        toolResult: {
          content: resultText,
          isError: status === 'failed',
        },
      })];
    }

    if (updateType === 'usage_update') {
      const used = typeof update.used === 'number' ? update.used : null;
      const size = typeof update.size === 'number' ? update.size : null;
      // Неполное событие (только одно поле) затирало бы верный счётчик
      // нулём — отвечать можно только на пару used+size.
      if (used === null || size === null) {
        return [];
      }
      return [createNormalizedMessage({
        sessionId: eventSessionId,
        provider: PROVIDER,
        kind: 'status',
        text: 'token_budget',
        tokenBudget: {
          used,
          total: size,
        },
      })];
    }

    // session_info_update / config_option_update / current_mode_update /
    // available_commands_update / plan / user_message_chunk (echo) are control
    // traffic — the frontend needs nothing from them.
    return [];
  }

  /**
   * Loads Devin history from the shared SQLite `sessions.db`.
   *
   * `main_chain_id` points at the current context window, not the whole
   * conversation — turns that fell out of the window stay in the table as
   * detached branches. `fullDevinConversation` rebuilds the complete accepted
   * history across all context snapshots (see devin-chain.ts).
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const providerSessionId = options.providerSessionId ?? sessionId;
    const db = openDevinDatabase();
    if (!db) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    try {
      const sessionRow = db
        .prepare('SELECT main_chain_id FROM sessions WHERE id = ?')
        .get(providerSessionId) as { main_chain_id: number | null } | undefined;
      if (!sessionRow) {
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      }

      const chain: DevinMessageNodeRow[] = fullDevinConversation(db, providerSessionId)
        .map((row) => ({
          node_id: row.nodeId,
          parent_node_id: row.parentId,
          chat_message: row.chatMessage,
          created_at: row.createdAt,
        }));

      const normalized = this.normalizeHistoryChain(chain, sessionId);

      const normalizedOffset = Math.max(0, offset);
      const normalizedLimit = limit === null ? null : Math.max(0, limit);
      const total = normalized.length;
      const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

      return {
        messages: page,
        total,
        hasMore,
        offset: normalizedOffset,
        limit: normalizedLimit,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[DevinProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    } finally {
      db.close();
    }
  }

  private normalizeHistoryChain(chain: DevinMessageNodeRow[], sessionId: string): NormalizedMessage[] {
    const normalized: NormalizedMessage[] = [];
    // tool_call_id → index into `normalized` of the matching tool_use entry so
    // a later `tool` node can attach its result.
    const toolUseIndex = new Map<string, number>();

    for (const row of chain) {
      const message = readJsonRecord(row.chat_message);
      if (!message) {
        continue;
      }
      const role = readOptionalString(message.role);
      const metadata = readObjectRecord(message.metadata);
      // message.metadata.created_at is the ACP event time; the row's own
      // created_at column is the storage-time fallback (both unix seconds).
      const timestamp = normalizeProviderTimestamp(metadata?.created_at ?? row.created_at ?? null);

      if (role === 'user' && metadata?.is_user_input) {
        const content = readOptionalString(message.content);
        if (content?.trim()) {
          normalized.push(createNormalizedMessage({
            id: `devin_${row.node_id}`,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content,
          }));
        }
        continue;
      }

      if (role === 'assistant') {
        const thinking = readOptionalString(readObjectRecord(message.thinking)?.thinking);
        if (thinking?.trim()) {
          normalized.push(createNormalizedMessage({
            id: `devin_${row.node_id}_thinking`,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'thinking',
            content: thinking,
          }));
        }

        const content = readOptionalString(message.content);
        if (content?.trim()) {
          normalized.push(createNormalizedMessage({
            id: `devin_${row.node_id}`,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content,
          }));
        }

        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        for (const toolCall of toolCalls) {
          const record = readObjectRecord(toolCall);
          if (!record) {
            continue;
          }
          const toolId = readOptionalString(record.id) ?? `devin_${row.node_id}_tc${toolUseIndex.size}`;
          normalized.push(createNormalizedMessage({
            id: `devin_${row.node_id}_${toolId}`,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: readOptionalString(record.name) ?? 'Tool',
            toolId,
            toolInput: record.arguments ?? {},
          }));
          toolUseIndex.set(toolId, normalized.length - 1);
        }
        continue;
      }

      if (role === 'tool') {
        const toolCallId = readOptionalString(message.tool_call_id);
        const content = readOptionalString(message.content) ?? '';
        if (!toolCallId || !toolUseIndex.has(toolCallId)) {
          // A tool node without a matching call is service noise — skip it
          // instead of dumping raw output into the chat.
          continue;
        }
        const target = normalized[toolUseIndex.get(toolCallId)!];
        target.toolResult = { content, isError: false };
        continue;
      }
    }

    return normalized;
  }
}

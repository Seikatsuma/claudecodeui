/**
 * Message normalization utilities.
 * Converts NormalizedMessage[] from the session store into ChatMessage[] for the UI.
 */

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import type { ChatMessage, SubagentChildTool } from '../types/types';
import { formatUsageLimitText } from '../utils/chatFormatting';

function formatToolResultContent(content: unknown): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const toolUseErrorMatch = /^<tool_use_error>([\s\S]*)<\/tool_use_error>$/.exec(text.trim());
  return toolUseErrorMatch ? toolUseErrorMatch[1] : text;
}

type ParsedTaskNotification = {
  status: string;
  summary: string;
  result: string;
};

/**
 * Parses a background-agent `<task-notification>` block.
 *
 * The harness injects these as user-role messages when a background task stops.
 * Newer notifications carry extra fields (`<tool-use-id>`, `<note>`, `<usage>`,
 * and a `<result>` markdown payload) that the previous single-shot regex could
 * not match, so the whole raw XML block leaked through as plain user text.
 * Fields are extracted independently so the block renders as an assistant
 * notification plus, when present, the agent's markdown result.
 */
function parseTaskNotification(content: string): ParsedTaskNotification | null {
  if (!content.trimStart().startsWith('<task-notification>')) {
    return null;
  }

  const statusMatch = /<status>([\s\S]*?)<\/status>/.exec(content);
  const summaryMatch = /<summary>([\s\S]*?)<\/summary>/.exec(content);

  let result = '';
  const resultOpen = content.indexOf('<result>');
  if (resultOpen !== -1) {
    const afterOpen = content.slice(resultOpen + '<result>'.length);
    const closeIndex = afterOpen.indexOf('</result>');
    result =
      closeIndex === -1
        ? afterOpen.replace(/<\/task-notification>\s*$/, '').trim()
        : afterOpen.slice(0, closeIndex).trim();
  }

  return {
    status: statusMatch?.[1]?.trim() || 'completed',
    summary: summaryMatch?.[1]?.trim() || 'Background task finished',
    result,
  };
}

/**
 * Per-source-message conversion cache, keyed by NormalizedMessage object
 * identity. `MessageComponent` is wrapped in `memo()`, which only helps if
 * unchanged messages keep the same `ChatMessage` object reference across
 * renders — but this function used to rebuild every entry from scratch on
 * every call. During streaming, `updateStreaming`/`updateThinkingStreaming`
 * give the *whole* realtime array a new reference on every ~100ms batch (see
 * useSessionStore.ts), so `normalizedToChatMessages` re-ran on every tick and
 * handed every message — not just the one actually growing — a brand-new
 * object, defeating `memo()` for the entire visible list and forcing every
 * message's Markdown to re-parse in lockstep with the live one. That's O(N)
 * wasted work per tick in a long conversation, which reads as jank/"freezing"
 * exactly while a response is streaming in.
 *
 * Caching by the source message's own identity fixes this without touching
 * list-reconciliation (the intrinsic-key logic in ChatMessagesPane.tsx stays
 * as-is): a message whose NormalizedMessage reference didn't change gets the
 * exact same ChatMessage object(s) back, so `memo()` skips it. `tool_use` and
 * `tool_result` rows are the only kinds whose output depends on a *second*
 * message (the paired tool result / a set-membership check across the whole
 * list), so their cache entries also track that extra dependency and recompute
 * when it changes — everything else is a pure function of the source message
 * alone. A WeakMap means an entry disappears on its own once the source
 * message is no longer held anywhere (e.g. pruned after a session switch).
 */
type ChatMessageConversionCacheEntry = {
  trRef: NormalizedMessage['toolResult'] | NormalizedMessage | null | undefined;
  toolUseExists: boolean;
  output: ChatMessage[];
};

const conversionCache = new WeakMap<NormalizedMessage, ChatMessageConversionCacheEntry>();

/**
 * Convert NormalizedMessage[] from the session store into ChatMessage[]
 * that the existing UI components expect.
 *
 * Truly internal/system content is already filtered server-side. Some Claude
 * transcript artifacts such as local slash commands and compact summaries are
 * intentionally preserved and annotated so they can render like normal chat.
 */
export function normalizedToChatMessages(messages: NormalizedMessage[]): ChatMessage[] {
  const converted: ChatMessage[] = [];

  // First pass: collect tool results for attachment
  const toolResultMap = new Map<string, NormalizedMessage>();
  const toolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.kind === 'tool_use' && msg.toolId) {
      toolUseIds.add(msg.toolId);
    }

    if (msg.kind === 'tool_result' && msg.toolId) {
      toolResultMap.set(msg.toolId, msg);
    }
  }

  for (const msg of messages) {
    // The only two kinds whose output depends on a *second* message: a
    // tool_use's attached result, and a tool_result's set-membership check
    // against every tool_use in the list. Hoisted so both the cache-hit
    // check below and the case bodies further down use the same value.
    const trRef = msg.kind === 'tool_use'
      ? (msg.toolResult || (msg.toolId ? toolResultMap.get(msg.toolId) : null))
      : undefined;
    const toolUseExists = msg.kind === 'tool_result' && msg.toolId
      ? toolUseIds.has(msg.toolId)
      : false;

    const cached = conversionCache.get(msg);
    if (cached && cached.trRef === trRef && cached.toolUseExists === toolUseExists) {
      converted.push(...cached.output);
      continue;
    }

    const entries: ChatMessage[] = [];
    const sharedMetadata = {
      displayText: msg.displayText,
      commandName: msg.commandName,
      commandMessage: msg.commandMessage,
      commandArgs: msg.commandArgs,
      isLocalCommand: msg.isLocalCommand,
      isLocalCommandStdout: msg.isLocalCommandStdout,
      isCompactSummary: msg.isCompactSummary,
    };

    switch (msg.kind) {
      case 'text': {
        const content = msg.content || '';
        const images = Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : undefined;
        const files = Array.isArray(msg.files) && msg.files.length > 0 ? msg.files : undefined;
        if (!content.trim() && !images && !files) break;

        if (msg.role === 'user') {
          // Parse task notifications
          const taskNotif = parseTaskNotification(content);
          if (taskNotif) {
            entries.push({
              type: 'assistant',
              content: taskNotif.summary,
              timestamp: msg.timestamp,
              isTaskNotification: true,
              taskStatus: taskNotif.status,
              ...sharedMetadata,
            });
            // Render the agent's result as a normal assistant message so its
            // markdown displays correctly instead of leaking raw XML.
            if (taskNotif.result) {
              entries.push({
                type: 'assistant',
                content: formatUsageLimitText(taskNotif.result),
                timestamp: msg.timestamp,
                ...sharedMetadata,
              });
            }
          } else {
            entries.push({
              type: 'user',
              content,
              timestamp: msg.timestamp,
              images,
              files,
              ...sharedMetadata,
            });
          }
        } else {
          const text = formatUsageLimitText(content);
          entries.push({
            type: 'assistant',
            content: text,
            timestamp: msg.timestamp,
            ...sharedMetadata,
          });
        }
        break;
      }

      case 'tool_use': {
        const tr = trRef;
        const isSubagentContainer = msg.toolName === 'Task';

        // Build child tools from subagentTools
        const childTools: SubagentChildTool[] = [];
        if (isSubagentContainer && msg.subagentTools && Array.isArray(msg.subagentTools)) {
          for (const tool of msg.subagentTools as any[]) {
            childTools.push({
              toolId: tool.toolId,
              toolName: tool.toolName,
              toolInput: tool.toolInput,
              toolResult: tool.toolResult || null,
              timestamp: new Date(tool.timestamp || Date.now()),
            });
          }
        }

        const toolResult = tr
          ? {
              content: formatToolResultContent(tr.content),
              isError: Boolean(tr.isError),
              toolUseResult: (tr as any).toolUseResult,
            }
          : null;

        entries.push({
          type: 'assistant',
          content: '',
          timestamp: msg.timestamp,
          isToolUse: true,
          toolName: msg.toolName,
          toolInput: typeof msg.toolInput === 'string' ? msg.toolInput : JSON.stringify(msg.toolInput ?? '', null, 2),
          toolId: msg.toolId,
          toolResult,
          isSubagentContainer,
          subagentState: isSubagentContainer
            ? {
                childTools,
                currentToolIndex: childTools.length > 0 ? childTools.length - 1 : -1,
                isComplete: Boolean(toolResult),
              }
            : undefined,
          ...sharedMetadata,
        });
        break;
      }

      case 'thinking':
        if (msg.content?.trim()) {
          entries.push({
            type: 'assistant',
            content: msg.content,
            timestamp: msg.timestamp,
            isThinking: true,
            id: msg.id,
            thinkingDurationSeconds: typeof msg.thinkingDurationSeconds === 'number'
              ? msg.thinkingDurationSeconds
              : undefined,
            ...sharedMetadata,
          });
        }
        break;

      // Live thinking block, still accumulating — same shape as 'thinking'
      // plus isStreaming, so MessageComponent renders it with a live
      // Reasoning header ("Thinking...") instead of a finished one. `id`
      // stays the well-known `__thinking_<sessionId>` row for as long as this
      // case applies, so the row keeps a stable list key while it updates in
      // place chunk by chunk.
      case 'thinking_delta':
        if (msg.content) {
          entries.push({
            type: 'assistant',
            content: msg.content,
            timestamp: msg.timestamp,
            isThinking: true,
            isStreaming: true,
            id: msg.id,
            ...sharedMetadata,
          });
        }
        break;

      case 'error':
        entries.push({
          type: 'error',
          content: msg.content || 'Unknown error',
          timestamp: msg.timestamp,
          ...sharedMetadata,
        });
        break;

      case 'interactive_prompt':
        entries.push({
          type: 'assistant',
          content: msg.content || '',
          timestamp: msg.timestamp,
          isInteractivePrompt: true,
          ...sharedMetadata,
        });
        break;

      case 'task_notification':
        entries.push({
          type: 'assistant',
          content: msg.summary || 'Background task update',
          timestamp: msg.timestamp,
          isTaskNotification: true,
          taskStatus: msg.status || 'completed',
          ...sharedMetadata,
        });
        break;

      case 'stream_delta':
        if (msg.content) {
          entries.push({
            type: 'assistant',
            content: msg.content,
            timestamp: msg.timestamp,
            isStreaming: true,
            ...sharedMetadata,
          });
        }
        break;

      // stream_end, complete, status, permission_*, session_created
      // are control events — not rendered as messages
      case 'stream_end':
      case 'complete':
      case 'status':
      case 'permission_request':
      case 'permission_cancelled':
      case 'session_created':
        // Skip — these are handled by useChatRealtimeHandlers
        break;

      // tool_result is handled via attachment to tool_use above
      case 'tool_result': {
        if (msg.toolId && toolUseExists) {
          break;
        }

        // A result with a toolId but no matching tool_use in the loaded set is
        // almost always a tool_use/tool_result pair split across a pagination
        // boundary (older page not loaded yet). Rendering its raw content here
        // produces an unstyled dump that "fixes itself" once the older page
        // loads; skip it and let it attach to its tool_use when that arrives.
        if (msg.toolId) {
          break;
        }

        const content = formatToolResultContent(msg.content || '');
        if (!content.trim()) {
          break;
        }

        entries.push({
          type: msg.isError ? 'error' : 'assistant',
          content,
          timestamp: msg.timestamp,
          toolId: msg.toolId,
          ...sharedMetadata,
        });
        break;
      }

      default:
        break;
    }

    conversionCache.set(msg, { trRef, toolUseExists, output: entries });
    converted.push(...entries);
  }

  return converted;
}

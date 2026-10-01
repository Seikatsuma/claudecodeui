/**
 * OpenAI Codex SDK Integration
 * =============================
 *
 * This module provides integration with the OpenAI Codex SDK for non-interactive
 * chat sessions. It mirrors the Claude runtime adapter for consistency.
 *
 * ## Usage
 *
 * - codexRuntime.run(command, options, writer, context) - Execute a streamed prompt
 * - abortCodexSession(sessionId) - Cancel an active session
 * - isCodexSessionActive(sessionId) - Check if a session is running
 * - getActiveCodexSessions() - List all active sessions
 */

import {
  appendFilesInputTag,
  buildCodexInputItems,
  normalizeImageDescriptors
} from '@/shared/image-attachments.js';
import { noteSurvivorProviderSession } from '@/modules/providers/list/claude/survivor-runs.js';
import {
  followCodexWorkerEvents,
  launchCodexWorker,
  releaseCodexWorker,
  stopCodexWorker,
  waitForCodexWorkerExit,
} from '@/modules/providers/list/codex/codex-worker.provider.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import {
  createCompleteMessage,
  createNormalizedMessage,
  readCodexContextTokenUsage,
} from '@/shared/utils.js';

const activeCodexSessions = new Map();

function extractCodexTokenBudget(event) {
  const info = event?.info || event?.payload?.info || event?.usage?.info;
  return readCodexContextTokenUsage(info);
}

/**
 * Transform Codex SDK event to WebSocket message format
 * @param {object} event - SDK event
 * @returns {object} - Transformed event for WebSocket
 */
function transformCodexEvent(event) {
  // Map SDK event types to a consistent format
  switch (event.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      const item = event.item;
      if (!item) {
        return { type: event.type, item: null };
      }

      // Transform based on item type
      switch (item.type) {
        case 'agent_message':
          return {
            type: 'item',
            itemType: 'agent_message',
            // Preserve a future/extended phase field when available. Current
            // Codex CLI omits it from the live SDK stream, so queryCodex also
            // classifies every agent message except the last one as commentary.
            phase: item.phase,
            message: {
              role: 'assistant',
              content: item.text
            }
          };

        case 'reasoning':
          return {
            type: 'item',
            itemType: 'reasoning',
            message: {
              role: 'assistant',
              content: item.text,
              isReasoning: true
            }
          };

        case 'command_execution':
          return {
            type: 'item',
            itemType: 'command_execution',
            command: item.command,
            output: item.aggregated_output,
            exitCode: item.exit_code,
            status: item.status
          };

        case 'file_change':
          return {
            type: 'item',
            itemType: 'file_change',
            changes: item.changes,
            status: item.status
          };

        case 'mcp_tool_call':
          return {
            type: 'item',
            itemType: 'mcp_tool_call',
            server: item.server,
            tool: item.tool,
            arguments: item.arguments,
            result: item.result,
            error: item.error,
            status: item.status
          };

        case 'web_search':
          return {
            type: 'item',
            itemType: 'web_search',
            query: item.query
          };

        case 'todo_list':
          return {
            type: 'item',
            itemType: 'todo_list',
            items: item.items
          };

        case 'error':
          return {
            type: 'item',
            itemType: 'error',
            message: {
              role: 'error',
              content: item.message
            }
          };

        default:
          return {
            type: 'item',
            itemType: item.type,
            item: item
          };
      }

    case 'turn.started':
      return {
        type: 'turn_started'
      };

    case 'turn.completed':
      return {
        type: 'turn_complete',
        usage: event.usage
      };

    case 'turn.failed':
      return {
        type: 'turn_failed',
        error: event.error
      };

    case 'thread.started':
      return {
        type: 'thread_started',
        threadId: event.thread_id || event.id
      };

    case 'error':
      return {
        type: 'error',
        message: event.message
      };

    default:
      return {
        type: event.type,
        data: event
      };
  }
}

/**
 * Map permission mode to Codex SDK options
 * @param {string} permissionMode - 'default', 'acceptEdits', or 'bypassPermissions'
 * @returns {object} - { sandboxMode, approvalPolicy }
 */
function mapPermissionModeToCodexOptions(permissionMode) {
  switch (permissionMode) {
    case 'acceptEdits':
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never'
      };
    case 'bypassPermissions':
      return {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never'
      };
    case 'default':
    default:
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'untrusted'
      };
  }
}

/**
 * Execute a Codex query with streaming
 * @param {string} command - The prompt to send
 * @param {object} options - Options including cwd, sessionId, model, permissionMode
 * @param {WebSocket|object} ws - WebSocket connection or response writer
 */
export async function queryCodex(command, options = {}, ws, context) {
  const {
    sessionId,
    sessionSummary,
    cwd,
    projectPath,
    model,
    effort,
    images,
    files,
    permissionMode = 'default'
  } = options;

  // Callers pass the stable app session id; the SDK resumes threads with the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);

  const resolvedModel = await context.resolveResumeModel(sessionId, model);

  const workingDirectory = cwd || projectPath || process.cwd();
  const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);
  const catalog = await context.getProviderModels();
  const selectedModel = catalog.OPTIONS.find((option) => option.value === resolvedModel) || null;
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  const resolvedEffort = typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;

  let workerHandle = null;
  let workerFinished = false;
  // Provider-native thread id (starts as the resume id, or is captured from
  // the stream for brand-new sessions).
  let capturedSessionId = providerSessionId;
  let sessionCreatedSent = false;
  let terminalFailure = null;
  let failureNotified = false;
  // Session-map key: the app session id when the caller supplied one, else
  // the provider-native thread id once captured (legacy/direct API callers).
  const sessionKey = () => sessionId || capturedSessionId || null;

  try {
    const registerSession = (id) => {
      if (!id) {
        return;
      }
      const existing = activeCodexSessions.get(id);
      if (existing) {
        existing.workerPid = workerHandle?.pid || existing.workerPid;
        return;
      }
      activeCodexSessions.set(id, {
        workerPid: workerHandle?.pid || null,
        status: 'running',
        startedAt: new Date().toISOString()
      });
    };

    // The detached worker owns the SDK and CLI. The site only tails a durable
    // JSONL event journal, so a site restart cannot abort the model turn.
    const promptWithFiles = appendFilesInputTag(command, files);
    const turnInput = normalizeImageDescriptors(images).length > 0
      ? buildCodexInputItems(promptWithFiles, images, workingDirectory)
      : promptWithFiles;
    workerHandle = await launchCodexWorker({
      appSessionId: sessionId,
      providerSessionId,
      workingDirectory,
      sandboxMode,
      approvalPolicy,
      model: resolvedModel,
      effort: resolvedEffort,
      turnInput,
    });

    if (sessionKey()) {
      registerSession(sessionKey());
    }

    // Experimental JSON emits both progress commentary and the final answer
    // as `agent_message` without the transcript's `phase` field. Keep one
    // message pending: a following event proves it was progress, while
    // `turn.completed` proves the pending message is the final answer.
    let pendingAgentMessage = null;
    const emitTransformed = (transformed) => {
      const normalizedMsgs = context.normalizeMessage(transformed, capturedSessionId || sessionId || null);
      for (const msg of normalizedMsgs) {
        sendMessage(ws, msg);
      }
    };

    for await (const event of followCodexWorkerEvents(workerHandle)) {
      if (event.type === 'worker.error') {
        terminalFailure = new Error(event.message || 'Codex worker failed');
        sendMessage(ws, createNormalizedMessage({
          kind: 'error',
          content: terminalFailure.message,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'codex',
        }));
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          error: terminalFailure,
        });
        failureNotified = true;
        continue;
      }
      if (event.type === 'worker.completed') {
        workerFinished = true;
        if (event.exitCode && !terminalFailure) {
          terminalFailure = new Error('Codex worker exited with an error.');
        }
        break;
      }

      // Capture thread/session id lazily from the stream (Codex emits this asynchronously).
      if (event.type === 'thread.started') {
        const discoveredSessionId = event.thread_id || event.id || null;
        if (discoveredSessionId && !capturedSessionId) {
          capturedSessionId = discoveredSessionId;
          registerSession(sessionKey());
          noteSurvivorProviderSession(sessionId, capturedSessionId);

          if (ws.setSessionId && typeof ws.setSessionId === 'function') {
            ws.setSessionId(capturedSessionId);
          }

          if (!providerSessionId && !sessionCreatedSent) {
            sessionCreatedSent = true;
            sendMessage(ws, createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'codex' }));
          }
        }
      }

      if (sessionKey()) {
        const session = activeCodexSessions.get(sessionKey());
        if (session?.status === 'aborted') {
          continue;
        }
      }

      if (event.type === 'item.started' || event.type === 'item.updated') {
        // The next tool has started, so the pending agent message is certainly
        // progress commentary. Emit it now instead of waiting for the tool to
        // finish; this keeps the live work log genuinely live.
        if (pendingAgentMessage && event.item?.type !== 'agent_message') {
          emitTransformed({ ...pendingAgentMessage, phase: 'commentary' });
          pendingAgentMessage = null;
        }
        continue;
      }

      const transformed = transformCodexEvent(event);

      if (transformed?.type === 'item' && transformed.itemType === 'agent_message') {
        if (pendingAgentMessage) {
          emitTransformed({ ...pendingAgentMessage, phase: 'commentary' });
        }
        pendingAgentMessage = transformed;
        continue;
      }

      if (pendingAgentMessage) {
        const isFinalAnswer = event.type === 'turn.completed';
        emitTransformed(isFinalAnswer
          ? pendingAgentMessage
          : { ...pendingAgentMessage, phase: 'commentary' });
        pendingAgentMessage = null;
      }

      // Normalize the transformed event into NormalizedMessage(s) via adapter.
      emitTransformed(transformed);

      if (event.type === 'turn.failed' && !terminalFailure) {
        terminalFailure = event.error || new Error('Turn failed');
        // Notifications are app-facing, so they carry the app session id.
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          error: terminalFailure
        });
        failureNotified = true;
      }

      // Extract and send token usage if available (normalized to match Claude format)
      if (event.type === 'turn.completed') {
        const tokenBudget = extractCodexTokenBudget(event);
        if (tokenBudget) {
          sendMessage(ws, createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget, sessionId: capturedSessionId || sessionId || null, provider: 'codex' }));
        }
      }
    }

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session.
    const runSession = sessionKey() ? activeCodexSessions.get(sessionKey()) : null;
    if (!workerFinished && runSession?.status !== 'aborted') {
      terminalFailure ||= new Error('Codex worker stopped without a completion event.');
    }
    const runAborted = runSession?.status === 'aborted';
    if (!runAborted) {
      sendMessage(ws, createCompleteMessage({
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        actualSessionId: capturedSessionId || sessionId || null,
        exitCode: terminalFailure ? 1 : 0,
      }));
      if (!terminalFailure) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          stopReason: 'completed'
        });
      } else if (!failureNotified) {
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          error: terminalFailure,
        });
        failureNotified = true;
      }
    }

  } catch (error) {
    const session = sessionKey() ? activeCodexSessions.get(sessionKey()) : null;
    const wasAborted =
      session?.status === 'aborted' ||
      error?.name === 'AbortError' ||
      String(error?.message || '').toLowerCase().includes('aborted');

    if (!wasAborted) {
      console.error('[Codex] Error:', error);

      // Check if Codex SDK is available for a clearer error message
      const installed = await context.isProviderInstalled();
      const errorContent = !installed
        ? 'Codex CLI is not configured. Please set up authentication first.'
        : error.message;

      sendMessage(ws, createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'codex' }));
      sendMessage(ws, createCompleteMessage({
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        exitCode: 1,
      }));
      if (!terminalFailure) {
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          error
        });
      }
    }

  } finally {
    if (workerHandle && workerFinished) {
      releaseCodexWorker(workerHandle);
    }
    // Update session status
    if (sessionKey()) {
      const session = activeCodexSessions.get(sessionKey());
      if (session) {
        session.status = session.status === 'aborted' ? 'aborted' : 'completed';
      }
    }
  }
}

/**
 * Abort an active Codex session
 * @param {string} sessionId - Session ID to abort
 * @returns {boolean} - Whether abort was successful
 */
export async function abortCodexSession(sessionId) {
  const session = activeCodexSessions.get(sessionId);

  if (!session) {
    return false;
  }

  session.status = 'aborted';
  try {
    if (session.workerPid) {
      const signaled = stopCodexWorker(session.workerPid);
      return signaled && await waitForCodexWorkerExit(session.workerPid);
    }
  } catch (error) {
    console.warn(`[Codex] Failed to abort session ${sessionId}:`, error);
  }

  return false;
}

/**
 * Check if a session is active
 * @param {string} sessionId - Session ID to check
 * @returns {boolean} - Whether session is active
 */
export function isCodexSessionActive(sessionId) {
  const session = activeCodexSessions.get(sessionId);
  return session?.status === 'running';
}

/**
 * Get all active sessions
 * @returns {Array} - Array of active session info
 */
export function getActiveCodexSessions() {
  const sessions = [];

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status === 'running') {
      sessions.push({
        id,
        status: session.status,
        startedAt: session.startedAt
      });
    }
  }

  return sessions;
}

export const codexRuntime = {
  run: queryCodex,
  abort: abortCodexSession,
};

/**
 * Helper to send message via WebSocket or writer
 * @param {WebSocket|object} ws - WebSocket or response writer
 * @param {object} data - Data to send
 */
function sendMessage(ws, data) {
  try {
    if (ws.isSSEStreamWriter || ws.isWebSocketWriter) {
      // Writer handles stringification (SSEStreamWriter or WebSocketWriter)
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      // Raw WebSocket - stringify here
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}

// Clean up old completed sessions periodically
const completedSessionCleanupTimer = setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status !== 'running') {
      const startedAt = new Date(session.startedAt).getTime();
      if (now - startedAt > maxAge) {
        activeCodexSessions.delete(id);
      }
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes

// Runtime cleanup should not keep focused tests or one-off scripts alive after
// their provider work has completed.
completedSessionCleanupTimer.unref?.();

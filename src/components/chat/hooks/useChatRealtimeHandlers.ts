import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ServerEvent } from '../../../contexts/WebSocketContext';
import { showCompletionTitleIndicator } from '../../../utils/pageTitleNotification';
import { playChatCompletionSound, playNotificationSound } from '../../../utils/notificationSound';
import type { MarkSessionIdle, MarkSessionProcessing } from '../../../hooks/useSessionProtection';
import type { PendingPermissionRequest } from '../types/types';
import type { ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';

const isActionablePermissionRequest = (request: { toolName?: unknown } | null | undefined): boolean => {
  return request?.toolName !== 'ExitPlanMode' && request?.toolName !== 'exit_plan_mode';
};

const hasActionablePermissionRequests = (requests: Array<{ toolName?: unknown }> | null | undefined): boolean => {
  return Array.isArray(requests) && requests.some((request) => isActionablePermissionRequest(request));
};

interface UseChatRealtimeHandlersArgs {
  isActive: boolean;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  /** All five are keyed by session id — see the comment on their declaration
   *  in ChatInterface: one client can stream two sessions at once. */
  streamTimerRef: MutableRefObject<Map<string, number>>;
  accumulatedStreamRef: MutableRefObject<Map<string, string>>;
  /** Mirrors streamTimerRef/accumulatedStreamRef for the live thinking block. */
  thinkingStreamTimerRef: MutableRefObject<Map<string, number>>;
  accumulatedThinkingRef: MutableRefObject<Map<string, string>>;
  /** When the current thinking block's first delta arrived; drives the measured "Thought for Ns". */
  thinkingStartedAtRef: MutableRefObject<Map<string, number>>;
  /**
   * Highest live `seq` observed per session. Essential for reconnect catch-up:
   * `chat.subscribe` sends this value as `lastSeq` so the server replays only
   * the events this client actually missed. Written here on every sequenced
   * frame; read wherever a `chat.subscribe` is sent (session open, reconnect).
   */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  onWebSocketReconnect?: () => void;
  requestLatestMessages: (sessionId: string, allowNetwork?: boolean) => Promise<void>;
  sessionStore: SessionStore;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

/**
 * Routes server events into the session store and processing-state map.
 *
 * This is intentionally a thin reducer over the unified `kind`-based
 * protocol: every frame is keyed by the stable app session id, so there is
 * no session-id handoff, no provider branching, and no navigation here.
 * Sidebar events (`session_upserted`, `loading_progress`) are handled by
 * `useProjectsState`, not in this hook.
 */
export function useChatRealtimeHandlers({
  isActive,
  subscribe,
  provider,
  selectedSession,
  currentSessionId,
  setTokenBudget,
  pendingPermissionRequests,
  setPendingPermissionRequests,
  streamTimerRef,
  accumulatedStreamRef,
  thinkingStreamTimerRef,
  accumulatedThinkingRef,
  thinkingStartedAtRef,
  lastSeqRef,
  statusCheckSentAtRef,
  onSessionProcessing,
  onSessionIdle,
  onWebSocketReconnect,
  requestLatestMessages,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  // Session switches can send `chat.subscribe` before this effect has a chance
  // to rebind the websocket listener. Read the visible session id from a ref
  // so a fast `chat_subscribed` ack is matched against the current view, not
  // the previous render's closed-over selection.
  const activeViewSessionIdRef = useRef<string | null>(selectedSession?.id || currentSessionId || null);
  activeViewSessionIdRef.current = selectedSession?.id || currentSessionId || null;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  // Keep the latest pending-permission snapshot available to the websocket
  // listener so back-to-back permission events can dedupe and re-arm the
  // notification sound before React finishes a rerender.
  const pendingPermissionRequestsRef = useRef(pendingPermissionRequests);

  useEffect(() => {
    pendingPermissionRequestsRef.current = pendingPermissionRequests;
  }, [pendingPermissionRequests]);

  useEffect(() => {
    const handleEvent = (msg: ServerEvent) => {
      if (!msg.kind) {
        return;
      }

      const activeViewSessionId = activeViewSessionIdRef.current;
      const sid = (typeof msg.sessionId === 'string' && msg.sessionId) || activeViewSessionId;

      // Every sequenced live event carries a monotonic per-run `seq`. Track
      // the highest one seen per session so a reconnect's `chat.subscribe`
      // replays only what this client actually missed — and, just as
      // importantly, DROP a message whose `seq` this client has already
      // applied instead of only recording progress and falling through.
      //
      // Two independent effects can each send `chat.subscribe` around one
      // reconnect (ChatInterface's `handleWebSocketReconnect`, gated behind
      // an awaited REST call, and useChatSessionState's `ws`-keyed subscribe
      // effect, which fires synchronously as soon as the context's `ws`
      // reference updates). If the second one reads `lastSeqRef` before the
      // first has caught the client up, the server's `chat.subscribe` reply
      // (chat-websocket.service.ts `handleChatSubscribe`) replays a block
      // that is already in flight to the same socket via the run's normal
      // live broadcast — the same `stream_delta`/`thinking_delta` run then
      // arrives twice. Without this guard each duplicate re-runs
      // `accumulatedStreamRef.current += text` / `accumulatedThinkingRef.
      // current += text`, splicing a repeated fragment into the middle of
      // the live buffer (observed live: "I'll look at the file first."
      // replayed from partway through corrupted the buffer into "I'll
      // look'll look at the file first."), which then gets persisted as-is
      // by `finalizeStreaming`/`finalizeThinkingStreaming` — a bug no
      // content-based dedup in useSessionStore can catch, because the
      // corruption happens before the row is ever finalized. Rejecting an
      // already-seen `seq` up front makes every sequenced kind (not just
      // deltas) idempotent under duplicate delivery, matching the server's
      // own "unique monotonic seq" contract.
      if (sid && typeof msg.seq === 'number') {
        const known = lastSeqRef.current.get(sid) ?? 0;
        if (msg.seq <= known) {
          return;
        }
        lastSeqRef.current.set(sid, msg.seq);
      }

      switch (msg.kind) {
        case 'websocket_reconnected':
          onWebSocketReconnect?.();
          return;

        case 'chat_subscribed': {
          // Ack for chat.subscribe: authoritative processing state plus any
          // pending tool-permission prompts for the run.
          if (!sid) return;

          if (msg.isProcessing) {
            onSessionProcessing?.(sid);
          } else {
            // Idle ack: ignore it if a newer request started after the
            // subscribe was sent — the ack describes the older state.
            onSessionIdle?.(sid, {
              ifStartedBefore: statusCheckSentAtRef.current.get(sid),
            });
          }

          const isViewedSession = sid === activeViewSessionId;
          if (isViewedSession && Array.isArray(msg.pendingPermissions)) {
            const nextPendingPermissionRequests = msg.pendingPermissions as PendingPermissionRequest[];
            const hadActionablePermissionRequests = hasActionablePermissionRequests(pendingPermissionRequestsRef.current);
            const hasPendingActionablePermissionRequests = hasActionablePermissionRequests(nextPendingPermissionRequests);

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);

            if (hasPendingActionablePermissionRequests && !hadActionablePermissionRequests) {
              void playNotificationSound();
            }
          }
          return;
        }

        case 'protocol_error': {
          console.error('[Chat] Protocol error:', msg.code, msg.error);
          if (sid) {
            // Surface the failure in the conversation and stop the spinner —
            // the run never started (or was rejected), so no `complete` follows.
            onSessionIdle?.(sid);
            sessionStore.appendRealtime(sid, {
              id: `protocol_error_${Date.now()}`,
              sessionId: sid,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'error',
              content: String(msg.error || 'Request failed'),
            } as NormalizedMessage);
          }
          return;
        }

        // Sidebar/global events — owned by useProjectsState.
        case 'session_upserted':
        case 'loading_progress':
          return;

        default:
          break;
      }

      /* -------------------------------------------------------------- */
      /*  Provider NormalizedMessage handling                            */
      /* -------------------------------------------------------------- */

      // Flushes the live thinking accumulator into the store as a finished
      // `thinking` row, stamped with its measured duration. Called from both
      // `stream_end` (closes whichever block was streaming) and `complete`
      // (safety net for a turn that ends without content_block_stop reaching
      // here first) — a no-op when nothing thinking has accumulated.
      const flushThinking = () => {
        if (!sid) return;
        const timer = thinkingStreamTimerRef.current.get(sid);
        if (timer) {
          clearTimeout(timer);
          thinkingStreamTimerRef.current.delete(sid);
        }
        const accumulated = accumulatedThinkingRef.current.get(sid);
        if (accumulated) {
          const startedAt = thinkingStartedAtRef.current.get(sid);
          const durationSeconds = startedAt !== undefined
            ? Math.max(0, Math.round((Date.now() - startedAt) / 1000))
            : undefined;
          sessionStore.updateThinkingStreaming(sid, accumulated, provider);
          sessionStore.finalizeThinkingStreaming(sid, durationSeconds);
        }
        accumulatedThinkingRef.current.delete(sid);
        thinkingStartedAtRef.current.delete(sid);
      };

      // --- Streaming: buffer for performance ---
      if (msg.kind === 'thinking_delta') {
        const text = (msg.content as string) || '';
        if (!text || !sid) return;
        if (!accumulatedThinkingRef.current.has(sid)) {
          thinkingStartedAtRef.current.set(sid, Date.now());
        }
        accumulatedThinkingRef.current.set(sid, (accumulatedThinkingRef.current.get(sid) ?? '') + text);
        if (!thinkingStreamTimerRef.current.has(sid)) {
          thinkingStreamTimerRef.current.set(sid, window.setTimeout(() => {
            thinkingStreamTimerRef.current.delete(sid);
            const buffered = accumulatedThinkingRef.current.get(sid);
            if (buffered) {
              sessionStore.updateThinkingStreaming(sid, buffered, provider);
            }
          }, 100));
        }
        // Deltas are NOT appended to the transcript, for any session, active
        // or not. `appendRealtime` stores one message per call, so routing raw
        // deltas through it turned a single sentence into a column of
        // fragments ("Наш" / "ёл подозрительное место" / "самом деле."), each
        // with its own copy and read-aloud controls. The live row is what
        // shows streaming text; the finished message arrives on its own.
        return;
      }

      if (msg.kind === 'stream_delta') {
        const text = (msg.content as string) || '';
        if (!text || !sid) return;
        accumulatedStreamRef.current.set(sid, (accumulatedStreamRef.current.get(sid) ?? '') + text);
        if (!streamTimerRef.current.has(sid)) {
          streamTimerRef.current.set(sid, window.setTimeout(() => {
            streamTimerRef.current.delete(sid);
            const buffered = accumulatedStreamRef.current.get(sid);
            if (buffered) {
              sessionStore.updateStreaming(sid, buffered, provider);
            }
          }, 100));
        }
        // Not appended to the transcript — see the thinking_delta comment.
        return;
      }

      if (msg.kind === 'stream_end') {
        // This fires on every content_block_stop, whichever kind of block
        // just closed (thinking or text) — flush both accumulators, only
        // the one actually holding content does anything (see flushThinking
        // and the backend's stream_end comment for why that's safe).
        if (sid) {
          const timer = streamTimerRef.current.get(sid);
          if (timer) {
            clearTimeout(timer);
            streamTimerRef.current.delete(sid);
          }
          const buffered = accumulatedStreamRef.current.get(sid);
          if (buffered) {
            sessionStore.updateStreaming(sid, buffered, provider);
          }
          sessionStore.finalizeStreaming(sid);
          accumulatedStreamRef.current.delete(sid);
        }
        flushThinking();
        return;
      }

      // --- All other messages: route to store ---
      const shouldPersist =
        msg.kind !== 'complete'
        && msg.kind !== 'status'
        && msg.kind !== 'permission_request'
        && msg.kind !== 'permission_cancelled';

      if (sid && shouldPersist) {
        sessionStore.appendRealtime(sid, msg as unknown as NormalizedMessage);
      }

      // --- UI side effects for specific kinds ---
      switch (msg.kind) {
        case 'complete': {
          // Flush any remaining streaming state
          if (sid) {
            const timer = streamTimerRef.current.get(sid);
            if (timer) {
              clearTimeout(timer);
              streamTimerRef.current.delete(sid);
            }
            const buffered = accumulatedStreamRef.current.get(sid);
            if (buffered) {
              sessionStore.updateStreaming(sid, buffered, provider);
              sessionStore.finalizeStreaming(sid);
            }
            accumulatedStreamRef.current.delete(sid);
          }
          flushThinking();

          // `complete` is the unified terminal event — every provider run ends
          // with exactly one, regardless of success, failure, or abort. The
          // indicator derives from the processing map, so deleting the entry
          // hides it immediately and atomically.
          onSessionIdle?.(sid);
          if (sid === activeViewSessionId) {
            pendingPermissionRequestsRef.current = [];
            setPendingPermissionRequests([]);
          }

          if (msg.aborted) {
            // Abort was requested — the complete event confirms it. No
            // further UI action is needed beyond clearing the entry above.
            break;
          }

          // Celebrate only successful runs (failed runs end with success: false).
          if (msg.success !== false) {
            showCompletionTitleIndicator();
            void playChatCompletionSound();
          }

          // The session id is stable for the whole conversation (allocated
          // before the first send), so the only follow-up is syncing the
          // viewed conversation with the now-persisted transcript.
          if (sid && sid === activeViewSessionId) {
            void requestLatestMessages(sid, isActiveRef.current);
          }

          break;
        }

        // 'error' is an informational message row, not a terminal event —
        // providers emit it for mid-run stderr output too. Run teardown is
        // always signalled by the unified 'complete' that follows.

        case 'permission_request': {
          if (!msg.requestId) break;
          if (isActionablePermissionRequest({ toolName: msg.toolName })) {
            void playNotificationSound();
          }

          if (sid === activeViewSessionId) {
            const previousPendingPermissionRequests = pendingPermissionRequestsRef.current;
            if (!previousPendingPermissionRequests.some((request) => request.requestId === msg.requestId)) {
              const nextPendingPermissionRequests = [...previousPendingPermissionRequests, {
                requestId: msg.requestId as string,
                toolName: (msg.toolName as string) || 'UnknownTool',
                input: msg.input,
                context: msg.context,
                sessionId: sid || null,
                receivedAt: new Date(),
              }];

              pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
              setPendingPermissionRequests(nextPendingPermissionRequests);
            }
          }
          if (sid) {
            onSessionProcessing?.(sid);
          }
          break;
        }

        case 'permission_cancelled': {
          if (msg.requestId && sid === activeViewSessionId) {
            const nextPendingPermissionRequests = pendingPermissionRequestsRef.current.filter(
              (request: PendingPermissionRequest) => request.requestId !== msg.requestId,
            );

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);
          }
          break;
        }

        case 'status': {
          if (msg.text === 'token_budget' && msg.tokenBudget) {
            setTokenBudget(msg.tokenBudget as Record<string, unknown>);
          } else if (msg.text && sid) {
            onSessionProcessing?.(sid, {
              statusText: msg.text as string,
              canInterrupt: msg.canInterrupt !== false,
            });
          }
          break;
        }

        // text, tool_use, tool_result, thinking, interactive_prompt, task_notification
        // → already routed to store above, no UI side effects needed
        default:
          break;
      }
    };

    return subscribe(handleEvent);
  }, [
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    thinkingStreamTimerRef,
    accumulatedThinkingRef,
    thinkingStartedAtRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
  ]);
}

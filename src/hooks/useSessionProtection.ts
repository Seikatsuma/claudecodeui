import { useCallback, useState } from 'react';

/**
 * What the model is actually doing right now, as reported by the live stream
 * rather than guessed.
 *
 *   thinking — reasoning tokens are arriving (`thinking_delta`)
 *   writing  — answer tokens are arriving (`stream_delta`)
 *   tool     — a tool call is in flight; `detail` carries its name
 *   agents   — one or more sub-agents are running; `detail` carries how many
 *   waiting  — a request is in flight but nothing has come back yet
 *
 * The point of the enum is that every value corresponds to an event that
 * actually happened. The indicator used to rotate through invented words
 * ("Thinking… / Processing… / Analyzing…") on a four-second timer, which
 * looked identical whether the model was reasoning, stuck, or already
 * finished - the exact complaint this replaces.
 */
export type ActivityPhase = 'thinking' | 'writing' | 'tool' | 'agents' | 'waiting';

export interface SessionActivity {
  /** Provider-supplied status line; null renders the phase label instead. */
  statusText: string | null;
  /** Live phase from the stream; null until the first event arrives. */
  phase: ActivityPhase | null;
  /** Tool name for `tool`, agent count for `agents`. */
  detail: string | null;
  canInterrupt: boolean;
  /**
   * When this request was first marked as processing (client clock). Drives
   * the elapsed-time display and the stale `chat_subscribed` idle-ack guard.
   */
  startedAt: number;
}

export type SessionActivityMap = ReadonlyMap<string, SessionActivity>;

export type SessionActivitySnapshot = {
  sessionId: string;
  statusText?: string | null;
  phase?: ActivityPhase | null;
  detail?: string | null;
  canInterrupt?: boolean;
  startedAt?: number;
};

export type MarkSessionProcessing = (
  sessionId?: string | null,
  activity?: {
    statusText?: string | null;
    phase?: ActivityPhase | null;
    detail?: string | null;
    canInterrupt?: boolean;
  },
) => void;

export type MarkSessionIdle = (
  sessionId?: string | null,
  opts?: { ifStartedBefore?: number },
) => void;

export type SyncProcessingSessions = (
  sessions: readonly SessionActivitySnapshot[],
) => void;

const LOCAL_ACTIVITY_GRACE_MS = 10_000;

const sessionActivityMapsMatch = (
  left: ReadonlyMap<string, SessionActivity>,
  right: ReadonlyMap<string, SessionActivity>,
): boolean => {
  if (left.size !== right.size) {
    return false;
  }

  for (const [sessionId, leftActivity] of left) {
    const rightActivity = right.get(sessionId);
    if (
      !rightActivity
      || leftActivity.statusText !== rightActivity.statusText
      || leftActivity.phase !== rightActivity.phase
      || leftActivity.detail !== rightActivity.detail
      || leftActivity.canInterrupt !== rightActivity.canInterrupt
      || leftActivity.startedAt !== rightActivity.startedAt
    ) {
      return false;
    }
  }

  return true;
};

/**
 * Single source of truth for which sessions are actively processing a
 * request. Everything the chat UI shows (activity indicator, abort
 * availability, status text) is derived from this map; terminal events
 * (`complete`, abort, an authoritative idle subscribe ack) delete the entry
 * atomically. Session ids are always concrete (allocated before the first
 * send), so entries are keyed by real session ids only.
 */
export function useSessionProtection() {
  const [processingSessions, setProcessingSessions] = useState<Map<string, SessionActivity>>(
    new Map(),
  );

  const markSessionProcessing = useCallback<MarkSessionProcessing>((sessionId, activity) => {
    if (!sessionId) {
      return;
    }

    setProcessingSessions((prev) => {
      const existing = prev.get(sessionId);
      const next: SessionActivity = {
        statusText:
          activity?.statusText !== undefined ? activity.statusText : existing?.statusText ?? null,
        phase: activity?.phase !== undefined ? activity.phase : existing?.phase ?? null,
        detail: activity?.detail !== undefined ? activity.detail : existing?.detail ?? null,
        canInterrupt: activity?.canInterrupt ?? existing?.canInterrupt ?? true,
        startedAt: existing?.startedAt ?? Date.now(),
      };

      if (
        existing
        && existing.statusText === next.statusText
        && existing.phase === next.phase
        && existing.detail === next.detail
        && existing.canInterrupt === next.canInterrupt
      ) {
        return prev;
      }

      const updated = new Map(prev);
      updated.set(sessionId, next);
      return updated;
    });
  }, []);

  const markSessionIdle = useCallback<MarkSessionIdle>((sessionId, opts) => {
    if (!sessionId) {
      return;
    }

    setProcessingSessions((prev) => {
      const existing = prev.get(sessionId);
      if (!existing) {
        return prev;
      }

      // Guard against stale `chat_subscribed` idle acks: if a new request
      // started after the subscribe was sent, the idle ack describes the
      // older request and must not clear the newer one.
      if (opts?.ifStartedBefore !== undefined && existing.startedAt >= opts.ifStartedBefore) {
        return prev;
      }

      const updated = new Map(prev);
      updated.delete(sessionId);
      return updated;
    });
  }, []);

  const syncProcessingSessions = useCallback<SyncProcessingSessions>((sessions) => {
    const now = Date.now();

    setProcessingSessions((prev) => {
      const incoming = new Map<string, SessionActivitySnapshot>();
      for (const session of sessions) {
        if (!session.sessionId) {
          continue;
        }
        incoming.set(session.sessionId, session);
      }

      const updated = new Map<string, SessionActivity>();

      for (const [sessionId, snapshot] of incoming) {
        const existing = prev.get(sessionId);
        const snapshotStartedAt =
          typeof snapshot.startedAt === 'number' && Number.isFinite(snapshot.startedAt) && snapshot.startedAt > 0
            ? snapshot.startedAt
            : undefined;

        updated.set(sessionId, {
          statusText:
            snapshot.statusText !== undefined ? snapshot.statusText : existing?.statusText ?? null,
          // A server snapshot knows a run is in flight but not what the model
          // is doing inside it - only the live stream does. Keep whatever the
          // stream last reported instead of blanking it on every sync.
          phase: snapshot.phase !== undefined ? snapshot.phase : existing?.phase ?? null,
          detail: snapshot.detail !== undefined ? snapshot.detail : existing?.detail ?? null,
          canInterrupt: snapshot.canInterrupt ?? existing?.canInterrupt ?? true,
          startedAt: snapshotStartedAt ?? existing?.startedAt ?? now,
        });
      }

      for (const [sessionId, activity] of prev) {
        if (!incoming.has(sessionId) && now - activity.startedAt < LOCAL_ACTIVITY_GRACE_MS) {
          updated.set(sessionId, activity);
        }
      }

      return sessionActivityMapsMatch(prev, updated) ? prev : updated;
    });
  }, []);

  return {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    syncProcessingSessions,
  };
}

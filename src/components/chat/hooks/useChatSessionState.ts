import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isDetachedRun } from '../../../utils/detachedRuns';
import type { MutableRefObject } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { MarkSessionIdle, SessionActivityMap } from '../../../hooks/useSessionProtection';
import type { Project, ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';
import { SESSION_MESSAGES_PAGE_SIZE } from '../../../stores/sessionMessagePagination';
import type { ChatMessage } from '../types/types';
import { createMessageHistoryRefreshCoordinator } from '../utils/messageHistoryRefreshCoordinator';
import { reportCatchupProbe } from '../utils/catchupProbe';
import { createCachedDiffCalculator, type DiffCalculator } from '../utils/messageTransforms';

import { normalizedToChatMessages } from './useChatMessages';
import { useScrollAnchor } from './useScrollAnchor';
import { useRowPrewarm } from './useRowPrewarm';
import { useRowHeightRecorder } from './useRowHeightRecorder';
import { knownRunStartedAt } from '../utils/liveRunCursor';

/**
 * Сколько загруженных сообщений показывать сразу.
 *
 * Сотня стояла как защита от торможения: рисовать больше телефон не тянул, и
 * появлялась кнопка «показать ещё» поверх подгрузки с сервера — две разные
 * кнопки об одном и том же, что и раздражало.
 *
 * Теперь за экраном сообщения не размечаются и не рисуются вовсе (см.
 * `.chat-row` в index.css), поэтому потолок поднят до величины, до которой в
 * жизни не доходит: подгрузку по-прежнему ограничивает сервер, по двадцать
 * сообщений на прокрутку вверх.
 */
const INITIAL_VISIBLE_MESSAGES = 2000;

interface UseChatSessionStateArgs {
  isActive: boolean;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  processingSessions?: SessionActivityMap;
  onSessionIdle?: MarkSessionIdle;
  resetStreamingState: () => void;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  /** Highest live seq observed per session; sent as `lastSeq` on subscribe. */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  sessionStore: SessionStore;
}

/** Порция, прибавившая ленте меньше этого, считается невидимой. */
const EMPTY_CHAIN_MIN_GROWTH_PX = 200;
/** Столько невидимых порций подгружается подряд за одно движение. */
const EMPTY_CHAIN_MAX_ROUNDS = 8;

/**
 * За сколько до верха ленты брать следующую порцию ранних сообщений — три
 * экрана: сервер отдаёт порцию за 0,03–0,8 с, и бросок пальцем не долетает до
 * края раньше неё (Егор, 15.09.26: «не листается выше»).
 */
function topPreloadMargin(container: HTMLElement): number {
  return Math.max(1200, container.clientHeight * 3);
}

/* ------------------------------------------------------------------ */
/*  Helper: Convert a ChatMessage to a NormalizedMessage for the store */
/* ------------------------------------------------------------------ */

export function chatMessageToNormalized(
  msg: ChatMessage,
  sessionId: string,
  provider: LLMProvider,
): NormalizedMessage | null {
  const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = msg.timestamp instanceof Date
    ? msg.timestamp.toISOString()
    : typeof msg.timestamp === 'number'
      ? new Date(msg.timestamp).toISOString()
      : String(msg.timestamp);
  const base = { id, sessionId, timestamp: ts, provider };

  if (msg.isToolUse) {
    return {
      ...base,
      kind: 'tool_use',
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      toolId: msg.toolId || id,
    } as NormalizedMessage;
  }
  if (msg.isThinking) {
    return { ...base, kind: 'thinking', content: msg.content || '' } as NormalizedMessage;
  }
  if (msg.isInteractivePrompt) {
    return { ...base, kind: 'interactive_prompt', content: msg.content || '' } as NormalizedMessage;
  }
  if ((msg as any).isTaskNotification) {
    return {
      ...base,
      kind: 'task_notification',
      status: (msg as any).taskStatus || 'completed',
      summary: msg.content || '',
    } as NormalizedMessage;
  }
  if (msg.type === 'error') {
    return {
      ...base,
      kind: 'error',
      content: msg.content || '',
      clientNotice: typeof msg.clientNotice === 'string' ? msg.clientNotice : undefined,
    } as NormalizedMessage;
  }
  return {
    ...base,
    kind: 'text',
    role: msg.type === 'user' ? 'user' : 'assistant',
    content: msg.content || '',
    // Keep attachment references on the local echo so the user bubble shows
    // its files immediately, before the server-backed copy replaces it.
    images: Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : undefined,
    files: Array.isArray(msg.files) && msg.files.length > 0 ? msg.files : undefined,
  } as NormalizedMessage;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatSessionState({
  isActive,
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  externalMessageUpdate,
  newSessionTrigger,
  processingSessions,
  onSessionIdle,
  resetStreamingState,
  statusCheckSentAtRef,
  lastSeqRef,
  sessionStore,
}: UseChatSessionStateArgs) {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  // Живое значение для отложенных проверок: состояние в замыкании таймера
  // застывает на момент назначения, а нам нужно знать положение дел на момент
  // срабатывания.
  const isUserScrolledUpRef = useRef(isUserScrolledUp);
  isUserScrolledUpRef.current = isUserScrolledUp;
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [loadAllJustFinished, setLoadAllJustFinished] = useState(false);
  const [showLoadAllOverlay, setShowLoadAllOverlay] = useState(false);
  const [viewHiddenCount, setViewHiddenCount] = useState(0);
  // Запрос истории упал (обрыв связи, перезапуск сайта). Без этого признака
  // лента рисовала «Продолжить разговор», будто чат пуст (Егор, 15.09.26).
  const [historyLoadError, setHistoryLoadError] = useState(false);
  const [historyRetryTick, setHistoryRetryTick] = useState(0);
  const historyRetryAttemptsRef = useRef(0);
  // Переписка чата не сохранилась (первый ход оборвался перезапуском сайта):
  // объяснить это вместо пустого «Продолжить разговор».
  const [transcriptMissing, setTranscriptMissing] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Сторож у верха ленты (см. эффект подгрузки ранних сообщений). Состояние, а
  // не ref: элемент появляется и исчезает вместе со строкой «Показано N из M».
  const [topSentinel, setTopSentinel] = useState<HTMLDivElement | null>(null);
  const topSentinelElRef = useRef<HTMLDivElement | null>(null);
  topSentinelElRef.current = topSentinel;
  // Setting `container.scrollTop` — from `scrollToBottom`, the initial-load
  // RAF loop, pagination scroll-restore, or the tab-reactivation restore —
  // fires a native 'scroll' event asynchronously, same as a real user
  // gesture. `handleScroll` used to treat every 'scroll' event as evidence
  // of the user's own intent, so a *programmatic* scroll-to-bottom would
  // land near the bottom, `handleScroll` would read that and confirm
  // `isUserScrolledUp = false` — which then satisfied the very check that
  // gates the *next* auto-scroll-on-new-content effect. In a long streaming
  // reply, new blocks (thinking → text, tool calls, …) arrive every couple
  // of seconds; each one re-armed that feedback loop, so a user who
  // scrolled up to read earlier content kept getting pulled back to the
  // bottom every time the next chunk landed — reported as the chat
  // "постоянно скидывает вниз" while a response is streaming in.
  //
  // Fixed by recording the exact value a programmatic write just set, so
  // `handleScroll` can recognize *that specific* resulting 'scroll' event
  // and skip updating `isUserScrolledUp` for it. A plain before/after
  // boolean isn't enough here: under the main-thread load a long streaming
  // reply itself creates (markdown re-parsing, syntax highlighting), the
  // native 'scroll' event for one programmatic write can arrive late enough
  // to swallow a *real* scroll the user made in between — matching against
  // the value tells the two apart regardless of timing. `null` means no
  // programmatic write is outstanding.
  const programmaticScrollTargetRef = useRef<number | null>(null);
  const wasNearTopRef = useRef(false);
  const [searchTarget, setSearchTarget] = useState<{ timestamp?: string; uuid?: string; snippet?: string } | null>(null);
  const searchScrollActiveRef = useRef(false);
  const isLoadingSessionRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  const topLoadLockRef = useRef(false);
  // Высота ленты до последней порции ранних сообщений: видна ли прибавка.
  const growthCheckRef = useRef<number | null>(null);
  // Сколько порций подряд подгружено без видимой прибавки в ленте.
  const emptyChainRoundsRef = useRef(0);
  const loadOlderMessagesRef = useRef<((container: HTMLDivElement) => Promise<boolean>) | null>(null);
  const pendingInitialScrollRef = useRef(true);
  const messagesOffsetRef = useRef(0);
  const scrollPositionRef = useRef({ height: 0, top: 0 });
  const loadAllFinishedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadAllOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadedSessionKeyRef = useRef<string | null>(null);
  /**
   * Tracks the last processed value from `useProjectsState.newSessionTrigger`.
   *
   * The trigger itself is intentionally increment-only and routed via:
   * useProjectsState -> AppContent -> MainContent -> ChatInterface -> this hook.
   * We compare values to ensure each explicit New Session click runs exactly one
   * reset pass in this local chat state domain.
   */
  const previousNewSessionTriggerRef = useRef(newSessionTrigger ?? 0);

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

  useEffect(() => {
    const trigger = newSessionTrigger ?? 0;
    if (trigger === previousNewSessionTriggerRef.current) {
      return;
    }
    previousNewSessionTriggerRef.current = trigger;

    /**
     * Consumer-side reset for explicit New Session intent.
     *
     * Why this is essential:
     * - Chat keeps local state that is not fully derived from `selectedSession`:
     *   `currentSessionId`, `pendingUserMessage`, streaming/status flags, message
     *   pagination/scroll bookkeeping, and provider-specific sessionStorage keys.
     * - If the user clicks New Session while already on the same route with no
     *   selected session, parent state updates can be idempotent and this local
     *   state would otherwise persist, making the click appear to "do nothing".
     *
     * What this reset guarantees:
     * - A deterministic clean draft state on every New Session click.
     * - No dependence on route/tab/session-object identity changes.
     * - No coupling to unrelated external update signals.
     */
    resetStreamingState();
    setCurrentSessionId(null);
    setPendingUserMessage(null);
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    
    setTokenBudget(null);
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    setViewHiddenCount(0);
    setSearchTarget(null);
    wasNearTopRef.current = false;
    searchScrollActiveRef.current = false;
    topLoadLockRef.current = false;
    growthCheckRef.current = null;
    pendingInitialScrollRef.current = true;
    lastLoadedSessionKeyRef.current = null;

    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }
    if (loadAllFinishedTimerRef.current) {
      clearTimeout(loadAllFinishedTimerRef.current);
      loadAllFinishedTimerRef.current = null;
    }
  }, [newSessionTrigger, onSessionIdle, resetStreamingState]);

  /* ---------------------------------------------------------------- */
  /*  Derive processing state for the viewed session                  */
  /* ---------------------------------------------------------------- */

  const activeSessionId = selectedSession?.id || currentSessionId || null;

  // The activity indicator always reflects the latest status of the session
  // being viewed — never stale local UI state from the last time it was
  // open. Session ids are concrete before any send, so no pending
  // placeholder entry exists anymore.
  const sessionActivity = (activeSessionId && processingSessions?.get(activeSessionId)) || null;
  const isProcessing = sessionActivity !== null;
  const canAbortSession = isProcessing && sessionActivity.canInterrupt;

  // Ref mirror so effects can read the latest map without re-running on
  // every activity transition.
  const processingSessionsRef = useRef(processingSessions);
  processingSessionsRef.current = processingSessions;

  const isActiveRef = useRef(isActive);
  const activeSessionIdRef = useRef(activeSessionId);
  isActiveRef.current = isActive;
  activeSessionIdRef.current = activeSessionId;

  const latestRefreshExecutorRef = useRef<(sessionId: string) => Promise<boolean | 'failed' | void>>(
    async () => true,
  );
  // Почему запрошена догрузка — только для зонда: сигналы сливаются в один
  // запрос, в строку журнала идёт последний.
  const refreshReasonRef = useRef(new Map<string, string>());
  latestRefreshExecutorRef.current = async (sessionId: string) => {
    const reason = refreshReasonRef.current.get(sessionId) ?? 'other';
    refreshReasonRef.current.delete(sessionId);
    const startedAt = Date.now();
    const result = await sessionStore.refreshLatestFromServer(sessionId, {
      limit: SESSION_MESSAGES_PAGE_SIZE,
      canRequest: () => (
        isActiveRef.current
        && activeSessionIdRef.current === sessionId
      ),
    });
    const slot = result.slot;
    if (slot && activeSessionIdRef.current === sessionId) {
      setHasMoreMessages(slot.hasMore);
      setTotalMessages(slot.total);
      messagesOffsetRef.current = slot.offset;
      // Хранилище истории заводит `tokenUsage: null`, а счётчик с историей шлют
      // только Codex/OpenCode: пустое значение затирало счётчик Claude при каждой
      // догрузке сообщений («0» у идущего чата, 23.09.26). Берём только настоящее.
      if (slot.tokenUsage) {
        setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
      }
    }
    reportCatchupProbe({
      reason,
      ms: Date.now() - startedAt,
      outcome: result.failed ? 'failed' : result.unbridged ? 'unbridged' : result.deferred ? 'deferred' : result.changed ? 'changed' : 'same',
      error: result.failed ?? '',
      processing: processingSessionsRef.current?.has(sessionId) ?? false,
      visible: typeof document === 'undefined' || document.visibilityState === 'visible',
      online: typeof navigator === 'undefined' || navigator.onLine,
    });
    if (result.failed) {
      refreshReasonRef.current.set(sessionId, reason.endsWith('-retry') ? reason : `${reason}-retry`);
      return 'failed' as const;
    }
    return !result.deferred;
  };

  const refreshCoordinatorRef = useRef<ReturnType<typeof createMessageHistoryRefreshCoordinator> | null>(null);
  if (!refreshCoordinatorRef.current) {
    refreshCoordinatorRef.current = createMessageHistoryRefreshCoordinator(
      (sessionId) => latestRefreshExecutorRef.current(sessionId),
      (sessionId) => isActiveRef.current && activeSessionIdRef.current === sessionId,
    );
  }

  const requestLatestMessages = useCallback((sessionId: string, allowNetwork = isActiveRef.current, reason?: string) => {
    if (reason) refreshReasonRef.current.set(sessionId, reason);
    return refreshCoordinatorRef.current?.request(sessionId, allowNetwork) ?? Promise.resolve();
  }, []);

  // Возврат приложения на экран. Сокет после фона переподключается не сразу
  // (а на iPhone иногда числится живым, хотя мёртв), и всё, что чат сделал за
  // это время, приходило только с его сигналом. Открытый чат перечитывает
  // хвост сам — один запрос, если данные старше порога свежести.
  useEffect(() => {
    const onResume = () => {
      if (document.visibilityState !== 'visible') return;
      const sessionId = activeSessionIdRef.current;
      if (!sessionId || !isActiveRef.current) return;
      if (!sessionStore.isStale(sessionId)) return;
      void requestLatestMessages(sessionId, true, 'resume');
    };
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('pageshow', onResume);
    return () => {
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('pageshow', onResume);
    };
  }, [requestLatestMessages, sessionStore]);

  // Ход закончился, а страница перечитать не успела: событие конца ушло в
  // мёртвый сокет, и о конце страница узнала из ответа на подписку («уже не
  // работает»). Перечитываем хвост, если после конца его никто не обновил —
  // обычный конец хода уже обновил его сам по событию `complete`.
  const processingSeenRef = useRef<{ sessionId: string | null; processing: boolean }>({ sessionId: null, processing: false });
  useEffect(() => {
    const previous = processingSeenRef.current;
    processingSeenRef.current = { sessionId: activeSessionId, processing: isProcessing };
    if (!activeSessionId || previous.sessionId !== activeSessionId) return;
    if (!previous.processing || isProcessing) return;
    const endedAt = Date.now();
    const timer = window.setTimeout(() => {
      if (activeSessionIdRef.current !== activeSessionId || !isActiveRef.current) return;
      const fetchedAt = sessionStore.getSessionSlot(activeSessionId)?.fetchedAt ?? 0;
      if (fetchedAt >= endedAt) return;
      void requestLatestMessages(activeSessionId, true, 'turn-ended');
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, [activeSessionId, isProcessing, requestLatestMessages, sessionStore]);

  /* ---------------------------------------------------------------- */
  /*  Derive chatMessages from the store                              */
  /* ---------------------------------------------------------------- */
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);
  const flushedPendingUserMessageRef = useRef<ChatMessage | null>(null);

  // Hidden Chat tabs keep collecting realtime rows without re-rendering the
  // CSS-hidden tree. Activation itself renders once and reads the latest cache.
  const activeSessionForStore = isActive ? activeSessionId : null;
  const prevActiveForStoreRef = useRef<string | null>(null);
  if (activeSessionForStore !== prevActiveForStoreRef.current) {
    prevActiveForStoreRef.current = activeSessionForStore;
    sessionStore.setActiveSession(activeSessionForStore);
  }

  useEffect(() => {
    if (!pendingUserMessage) {
      flushedPendingUserMessageRef.current = null;
      return;
    }

    if (!activeSessionId) {
      return;
    }

    if (flushedPendingUserMessageRef.current === pendingUserMessage) {
      return;
    }

    const prov = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const normalized = chatMessageToNormalized(pendingUserMessage, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }

    flushedPendingUserMessageRef.current = pendingUserMessage;
    setPendingUserMessage(null);
  }, [activeSessionId, pendingUserMessage, sessionStore]);

  const storeMessages = activeSessionId ? sessionStore.getMessages(activeSessionId) : [];

  // Reset viewHiddenCount when store messages change
  const prevStoreLenRef = useRef(0);
  if (storeMessages.length !== prevStoreLenRef.current) {
    prevStoreLenRef.current = storeMessages.length;
    if (viewHiddenCount > 0) setViewHiddenCount(0);
  }

  const chatMessages = useMemo(() => {
    const all = normalizedToChatMessages(storeMessages);
    // Show pending user message when no session data exists yet (new session, pre-backend-response)
    if (pendingUserMessage && all.length === 0) {
      return [pendingUserMessage];
    }
    if (viewHiddenCount > 0 && viewHiddenCount < all.length) return all.slice(0, -viewHiddenCount);
    return all;
  }, [storeMessages, viewHiddenCount, pendingUserMessage]);

  /* ---------------------------------------------------------------- */
  /*  addMessage / clearMessages / rewindMessages                     */
  /* ---------------------------------------------------------------- */

  const addMessage = useCallback((msg: ChatMessage) => {
    if (!activeSessionId) {
      // No session yet — show as pending until the backend creates one
      setPendingUserMessage(msg);
      return;
    }
    const prov = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const normalized = chatMessageToNormalized(msg, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }
  }, [activeSessionId, sessionStore]);

  const clearMessages = useCallback(() => {
    if (!activeSessionId) return;
    sessionStore.clearRealtime(activeSessionId);
  }, [activeSessionId, sessionStore]);

  const rewindMessages = useCallback((count: number) => setViewHiddenCount(count), []);

  // Every programmatic `container.scrollTop = …` in this file should call
  // this with the exact value it's about to write, so `handleScroll` can
  // recognize the resulting 'scroll' event and skip updating
  // `isUserScrolledUp` for it — see the comment on
  // `programmaticScrollTargetRef` above.
  const markProgrammaticScroll = useCallback((targetScrollTop: number) => {
    programmaticScrollTargetRef.current = targetScrollTop;
    // Safety net: if the write doesn't actually change scrollTop (already
    // at the target), the browser never fires 'scroll' to consume this.
    requestAnimationFrame(() => {
      if (programmaticScrollTargetRef.current === targetScrollTop) {
        programmaticScrollTargetRef.current = null;
      }
    });
  }, []);

  /** Верх ленты ближе трёх экранов к краю — пора брать следующую порцию. */
  const isTopSentinelNear = useCallback((container: HTMLDivElement) => {
    const sentinel = topSentinelElRef.current;
    if (!sentinel?.isConnected) return false;
    return sentinel.getBoundingClientRect().bottom
      >= container.getBoundingClientRect().top - topPreloadMargin(container);
  }, []);

  // Место на экране при любых сдвигах над ним (порция ранних сообщений,
  // дорисовка, раскрытие) держит useScrollAnchor — там же зачем и как.
  const { clearDeferredShift, getDeferredShift } = useScrollAnchor({
    scrollContainerRef,
    enabled: isActive,
    suspendedRef: pendingInitialScrollRef,
    markProgrammaticScroll,
    onSettled: () => {
      // Пока сдвиг был отложен, верхний сторож стоял дальше от экрана и порцию
      // не просил; лента остановилась — проверяем сами.
      const container = scrollContainerRef.current;
      if (container && isTopSentinelNear(container) && emptyChainRoundsRef.current < EMPTY_CHAIN_MAX_ROUNDS) {
        void loadOlderMessagesRef.current?.(container);
      }
    },
  });

  // Строки над экраном размечаются в паузах, а не во время листания.
  useRowPrewarm({ scrollContainerRef, enabled: isActive, contentKey: chatMessages.length });

  // Реальная высота каждой размеченной строки — в кэш: при следующем открытии
  // чата строки встают сразу точной высотой, лента не пересчитывается на глазах.
  useRowHeightRecorder({ scrollContainerRef, enabled: isActive });

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    clearDeferredShift();
    const target = container.scrollHeight;
    markProgrammaticScroll(target);
    container.scrollTop = target;
  }, [clearDeferredShift, markProgrammaticScroll]);

  const scrollToBottomAndReset = useCallback(() => {
    scrollToBottom();
    if (allMessagesLoaded) {
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
    }
  }, [allMessagesLoaded, scrollToBottom]);

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return false;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  const loadOlderMessages = useCallback(
    async (container: HTMLDivElement) => {
      if (!isActive) return false;
      if (!container || isLoadingMoreRef.current || isLoadingMoreMessages) return false;
      if (allMessagesLoadedRef.current) return false;
      if (!hasMoreMessages || !selectedSession || !selectedProject) return false;

      isLoadingMoreRef.current = true;
      const heightBefore = container.scrollHeight + getDeferredShift();

      try {
        const result = await sessionStore.fetchMore(selectedSession.id, {
          limit: SESSION_MESSAGES_PAGE_SIZE,
          canRequest: () => (
            isActiveRef.current
            && activeSessionIdRef.current === selectedSession.id
          ),
        });
        const { slot, prependedCount } = result;
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.offset;
        if (slot.tokenUsage) { // см. пояснение выше: пустое не затирает счётчик
          setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
        }

        if (prependedCount === 0) {
          // Пустая порция (сервер уточнил счёт) — ещё одна попытка, пока верх
          // рядом, но не больше EMPTY_CHAIN_MAX_ROUNDS подряд.
          emptyChainRoundsRef.current += 1;
          if (slot.hasMore && emptyChainRoundsRef.current < EMPTY_CHAIN_MAX_ROUNDS) {
            const requestedSessionId = selectedSession.id;
            window.setTimeout(() => {
              if (activeSessionIdRef.current !== requestedSessionId) return;
              const current = scrollContainerRef.current;
              if (current && isTopSentinelNear(current)) void loadOlderMessagesRef.current?.(current);
            }, 100);
          }
          if (!slot.hasMore) {
            allMessagesLoadedRef.current = true;
            setAllMessagesLoaded(true);
            if (loadAllOverlayTimerRef.current) {
              clearTimeout(loadAllOverlayTimerRef.current);
              loadAllOverlayTimerRef.current = null;
            }
            setShowLoadAllOverlay(false);
          }
          return false;
        }

        // Место на экране держит useScrollAnchor; здесь только проверка после
        // отрисовки, видна ли прибавка и не пора ли следующая порция.
        growthCheckRef.current = heightBefore;
        setVisibleMessageCount((prev) => prev + SESSION_MESSAGES_PAGE_SIZE);
        if (!slot.hasMore) {
          allMessagesLoadedRef.current = true;
          setAllMessagesLoaded(true);
          if (loadAllOverlayTimerRef.current) {
            clearTimeout(loadAllOverlayTimerRef.current);
            loadAllOverlayTimerRef.current = null;
          }
          setShowLoadAllOverlay(false);
        }
        return true;
      } finally {
        isLoadingMoreRef.current = false;
      }
    },
    [getDeferredShift, hasMoreMessages, isActive, isLoadingMoreMessages, isTopSentinelNear, selectedProject, selectedSession, sessionStore],
  );

  // Подгрузка ранних сообщений — сторож у верха ленты.
  //
  // Раньше порцию просил обработчик прокрутки по порогу и защёлке, плюс
  // отдельная догрузка «пока лента короче экрана». На iPhone это рвалось:
  // лента долетала до верха по инерции, возврат позиции после подгрузки Safari
  // перебивал остатком броска, событий прокрутки больше не было — и старое не
  // грузилось (Егор, 15.09.26: «листаю вверх, остальные сообщения часто не
  // загружаются»). Сторож (IntersectionObserver — как в бесконечных лентах)
  // видит верх без событий прокрутки: пока он ближе экрана к краю, берётся
  // следующая порция, в том числе когда лента короче экрана.
  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!isActive || !hasMoreMessages || !root || !topSentinel || typeof IntersectionObserver === 'undefined') {
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      // Пока лента встаёт в низ при открытии, верх виден лишь мгновение —
      // лишняя порция не нужна; проверка повторится после первой прокрутки.
      if (pendingInitialScrollRef.current) return;
      const container = scrollContainerRef.current;
      if (container && emptyChainRoundsRef.current < EMPTY_CHAIN_MAX_ROUNDS) {
        void loadOlderMessagesRef.current?.(container);
      }
    }, { root, rootMargin: `${topPreloadMargin(root)}px 0px 0px 0px` });
    observer.observe(topSentinel);
    return () => observer.disconnect();
  }, [hasMoreMessages, isActive, topSentinel]);

  loadOlderMessagesRef.current = loadOlderMessages;

  /** Подгрузить порцию старых сообщений по нажатию на строку-счётчик. */
  const loadOlderMessagesNow = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      emptyChainRoundsRef.current = 0;
      void loadOlderMessages(container);
    }
  }, [loadOlderMessages]);

  // Recomputes `isUserScrolledUp` from the live DOM position. Called ONLY
  // from a genuine user input gesture (wheel/touchmove — see
  // `handleUserScrollGesture` below), never from the generic native
  // 'scroll' event. That event fires for every scrollTop change regardless
  // of cause, including two that have nothing to do with user intent: our
  // own programmatic writes (see `programmaticScrollTargetRef`), and —
  // this was the actual root cause of "chat keeps dragging me back down
  // while a response streams in" — a live `Reasoning` block (the
  // "Thinking…" accordion) collapsing once it finalizes (it renders
  // expanded while streaming and collapses on finalize; MessageComponent/
  // Reasoning derive `defaultOpen` from `isStreaming` at mount, and
  // finalizing swaps in a new id — see useChatMessages.ts /
  // MessageComponent.tsx). That collapse can shrink the conversation to
  // (or nearly to) fit inside the viewport, even momentarily. With little
  // or no overflow, `scrollHeight - scrollTop - clientHeight` reads as
  // "near bottom" no matter where scrollTop actually is, so treating that
  // passive reflow as a scroll-to-bottom reset `isUserScrolledUp` to false
  // even though the user had deliberately scrolled up to read something.
  // The next block (e.g. the reply text) then grows the conversation past
  // the viewport again, and the auto-scroll-on-new-content effect — now
  // honestly believing the user never left the bottom — pulled them back
  // down. Repeated on every thinking→text / tool-call transition in a long
  // reply, which is exactly "постоянно скидывает вниз". Deriving this only
  // from wheel/touchmove sidesteps the whole category: those never fire for
  // a programmatic write or a passive reflow, only for the user's own hand
  // on the wheel or the glass.
  const handleUserScrollGesture = useCallback(() => {
    if (!isActive) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    // Defense in depth: a genuine wheel/touch gesture landing at the exact
    // instant a Reasoning block collapses could still momentarily read a
    // near-zero scrollable range. Skip the update rather than trust it —
    // see the comment above.
    if (container.scrollHeight <= container.clientHeight) return;
    setIsUserScrolledUp(!isNearBottom());
  }, [isActive, isNearBottom]);

  // Догон для айфона: инерция.
  //
  // На телефоне палец делает бросок и отрывается, а лента продолжает ехать
  // сама — иногда полэкрана. Во время инерции `touchmove` уже не приходит,
  // поэтому положение, посчитанное на последнем касании, врёт: человек в тот
  // миг был ещё у низа, а доехал далеко вверх. Дальше приходит новый кусок
  // ответа, и лента, честно считая что человек внизу, утаскивает его обратно.
  // Егор: «дёргает и отправляет в самый низ, не давая листать».
  //
  // `scrollend` браузер шлёт один раз, когда движение окончательно
  // остановилось — в том числе после инерции. Собственные наши перемотки
  // отсеиваются тем же признаком, что и везде.
  const handleScrollSettled = useCallback(() => {
    if (!isActive) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    if (programmaticScrollTargetRef.current !== null) return;
    if (container.scrollHeight <= container.clientHeight) return;
    setIsUserScrolledUp(!isNearBottom());
  }, [isActive, isNearBottom]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return undefined;
    container.addEventListener('scrollend', handleScrollSettled);
    return () => container.removeEventListener('scrollend', handleScrollSettled);
  }, [handleScrollSettled]);

  const handleScroll = useCallback(async () => {
    if (!isActive) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    // A scroll event caused by our own `container.scrollTop = …` isn't
    // evidence of user intent. Only treat *this* event as self-inflicted if
    // scrollTop actually landed on the value we just set; otherwise a real
    // user scroll interleaved before the native event fired, and the
    // pagination logic below still needs to see it.
    if (programmaticScrollTargetRef.current !== null) {
      const expected = programmaticScrollTargetRef.current;
      programmaticScrollTargetRef.current = null;
      if (container.scrollTop === expected) {
        scrollPositionRef.current = {
          height: container.scrollHeight,
          top: container.scrollTop,
        };
        return;
      }
    }

    // `isUserScrolledUp` is intentionally NOT updated here — see
    // `updateIsUserScrolledUpFromGesture` above. This still runs for every
    // native 'scroll' (scrollbar drag included) for position bookkeeping
    // and the "load older messages near the top" pagination behavior.
    scrollPositionRef.current = {
      height: container.scrollHeight,
      top: container.scrollTop,
    };

    // Подгружаем не у самой кромки, а за экран до неё: пока человек долистывает
    // последний экран, старое уже приходит, и прокрутка не спотыкается.
    // Раньше порог был сто точек — старое начинало грузиться, когда листать
    // было уже некуда, и это читалось как рывок.
    const scrolledNearTop = container.scrollTop < Math.max(100, container.clientHeight);

    // "Load all" prompt: appear (with fade-in) when the user reaches the top
    if (scrolledNearTop && hasMoreMessages && !allMessagesLoadedRef.current) {
      if (!wasNearTopRef.current) {
        wasNearTopRef.current = true;
        if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);

        setShowLoadAllOverlay(true);
        loadAllOverlayTimerRef.current = setTimeout(() => {
          setShowLoadAllOverlay(false);
          loadAllOverlayTimerRef.current = null;
        }, 2500);
      }
    } else if (!scrolledNearTop) {
      wasNearTopRef.current = false;
    }

    // Главный путь подгрузки — сторож у верха. Прокрутка у верха лишь
    // подталкивает, когда сторож уже стоит в зоне и нового пересечения не
    // увидит. Защёлки больше нет: именно она залипала.
    if (!scrolledNearTop) {
      emptyChainRoundsRef.current = 0;
    } else if (!allMessagesLoadedRef.current && !isLoadingMoreRef.current
      && emptyChainRoundsRef.current < EMPTY_CHAIN_MAX_ROUNDS) {
      void loadOlderMessages(container);
    }
  }, [hasMoreMessages, isActive, loadOlderMessages]);

  const wasChatActiveRef = useRef(isActive);
  useLayoutEffect(() => {
    const becameActive = isActive && !wasChatActiveRef.current;
    wasChatActiveRef.current = isActive;
    if (!isActive || !scrollContainerRef.current) return;

    const container = scrollContainerRef.current;
    if (becameActive) {
      clearDeferredShift();
      const target = isUserScrolledUp ? scrollPositionRef.current.top : container.scrollHeight;
      markProgrammaticScroll(target);
      container.scrollTop = target;
    }
  }, [clearDeferredShift, isActive, isUserScrolledUp, markProgrammaticScroll]);

  // После отрисовки порции ранних сообщений. Порция из одних действий вливается
  // в верхний свёрнутый «Ход работы»: лента почти не растёт, и кажется, что
  // ничего не подгрузилось (замер 15.09.26) — такие берутся подряд, не больше
  // EMPTY_CHAIN_MAX_ROUNDS. Верх всё ещё рядом — сторож нового пересечения не
  // увидит, следующую порцию просим сами.
  useEffect(() => {
    const heightBefore = growthCheckRef.current;
    const container = scrollContainerRef.current;
    if (heightBefore === null || !container || !isActive) return;
    growthCheckRef.current = null;
    const grewVisibly = container.scrollHeight + getDeferredShift() - heightBefore >= EMPTY_CHAIN_MIN_GROWTH_PX;
    emptyChainRoundsRef.current = grewVisibly ? 0 : emptyChainRoundsRef.current + 1;
    if (isTopSentinelNear(container) && emptyChainRoundsRef.current < EMPTY_CHAIN_MAX_ROUNDS) {
      void loadOlderMessagesRef.current?.(container);
    }
  }, [chatMessages.length, getDeferredShift, isActive, isTopSentinelNear, visibleMessageCount]);

  // Reset scroll/pagination state on session change
  useEffect(() => {
    if (!searchScrollActiveRef.current) {
      pendingInitialScrollRef.current = true;
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    }
    topLoadLockRef.current = false;
    growthCheckRef.current = null;
    wasNearTopRef.current = false;
    emptyChainRoundsRef.current = 0;
    historyRetryAttemptsRef.current = 0;
    setHistoryLoadError(false);
    setTranscriptMissing(false);
    setIsUserScrolledUp(false);
  }, [selectedProject?.projectId, selectedSession?.id]);

  // Initial scroll to bottom — robust to lazy content reflow.
  // The previous implementation fired one scrollToBottom() at +200ms and
  // cleared the pending flag. When markdown blocks, code highlighting, or
  // images finished rendering after that window, scrollHeight grew but
  // nothing re-anchored the viewport, leaving the chat tab visually
  // "scrolled way up" with the latest assistant message off-screen.
  //
  // This version re-scrolls every animation frame while scrollHeight is
  // still growing, capped at ~1s (60 frames) or 3 consecutive stable
  // frames. Cancels cleanly on session change via the pending flag.
  useEffect(() => {
    if (!isActive) return;
    if (!pendingInitialScrollRef.current || !scrollContainerRef.current || isLoadingSessionMessages) return;
    if (chatMessages.length === 0) { pendingInitialScrollRef.current = false; return; }
    if (searchScrollActiveRef.current) { pendingInitialScrollRef.current = false; return; }

    const container = scrollContainerRef.current;
    let frame = 0;
    let lastHeight = 0;
    let stableCount = 0;
    let rafId = 0;

    const tick = () => {
      if (!pendingInitialScrollRef.current || !scrollContainerRef.current) return;
      const target = container.scrollHeight;
      markProgrammaticScroll(target);
      container.scrollTop = target;
      if (container.scrollHeight === lastHeight) {
        stableCount++;
      } else {
        stableCount = 0;
        lastHeight = container.scrollHeight;
      }
      frame++;
      if (stableCount < 3 && frame < 60) {
        rafId = requestAnimationFrame(tick);
      } else {
        pendingInitialScrollRef.current = false;
        // Лента короче экрана или верх рядом — сторож в зоне с самого начала
        // и пересечения не увидит; первую добавочную порцию просим сами.
        if (isTopSentinelNear(container)) void loadOlderMessagesRef.current?.(container);
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [chatMessages.length, isActive, isLoadingSessionMessages, isTopSentinelNear, scrollToBottom, markProgrammaticScroll]);

  // Первый кадр открытого чата — уже внизу. Строки появляются раньше, чем
  // срабатывают прокрутки в низ выше: те идут после отрисовки, а признак
  // `pendingInitialScrollRef` к этому моменту уже снят (в первый миг сообщений
  // ноль — эффект выше решает, что вставать некуда). Чат на несколько кадров
  // показывался с начала порции и потом прыгал в низ (замер 27.09.26: 150–380 мс
  // на этом сервере, на телефоне дольше). Здесь — до отрисовки, один раз на
  // чат: возврат на уже открытую вкладку место не трогает.
  const firstFrameSessionRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!isActive || !activeSessionId || searchScrollActiveRef.current) return;
    if (firstFrameSessionRef.current === activeSessionId) return;
    const container = scrollContainerRef.current;
    if (!container || chatMessages.length === 0) return;
    firstFrameSessionRef.current = activeSessionId;
    const target = container.scrollHeight;
    markProgrammaticScroll(target);
    container.scrollTop = target;
  }, [activeSessionId, chatMessages.length, isActive, markProgrammaticScroll]);

  // Session replay/subscription remains active regardless of which main tab is
  // visible. Only persisted-history HTTP traffic is visibility-gated below.
  useEffect(() => {
    if (!selectedSession || !selectedProject || !ws) return;

    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
        runStartedAt: knownRunStartedAt(selectedSession.id) ?? null,
      }],
    });
  }, [lastSeqRef, selectedProject, selectedSession, sendMessage, statusCheckSentAtRef, ws]);

  // Main session loading effect — store-based
  useEffect(() => {
    if (!selectedSession || !selectedProject) {
      // A freshly created session can be mid-run before the router has a
      // canonical selectedSession (the URL effect synthesizes one on the
      // next render). Keep the active view intact instead of wiping it.
      if (currentSessionId && processingSessionsRef.current?.has(currentSessionId)) {
        return;
      }

      resetStreamingState();
      setCurrentSessionId(null);
      messagesOffsetRef.current = 0;
      setHasMoreMessages(false);
      setTotalMessages(0);
      setTokenBudget(null);
      lastLoadedSessionKeyRef.current = null;
      return;
    }

    if (!isActive) {
      setIsLoadingSessionMessages(false);
      return;
    }

    const selectedSessionId = selectedSession.id;
    const sessionKey = `${selectedSessionId}:${selectedProject.projectId}`;

    const existingSlot = sessionStore.getSessionSlot(selectedSessionId);
    const isCurrentHydratedSession =
      lastLoadedSessionKeyRef.current === sessionKey
      && Boolean(existingSlot?.fetchedAt);

    // Returning from another tab must not reset pagination or scroll. Refresh
    // a stale hydrated session through the bounded tail path instead.
    if (isCurrentHydratedSession) {
      if (sessionStore.isStale(selectedSessionId)) {
        void requestLatestMessages(selectedSessionId);
      }
      return;
    }

    const sessionChanged = currentSessionId !== null && currentSessionId !== selectedSessionId;
    if (sessionChanged) {
      resetStreamingState();
    }

    // Reset pagination/scroll state
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    setViewHiddenCount(0);
    wasNearTopRef.current = false;
    if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
    if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);

    setCurrentSessionId(selectedSessionId);

    lastLoadedSessionKeyRef.current = sessionKey;

    // Fetch from server → store updates → chatMessages re-derives automatically
    setIsLoadingSessionMessages(true);
    sessionStore.fetchFromServer(selectedSessionId, {
      limit: SESSION_MESSAGES_PAGE_SIZE,
      offset: 0,
      canRequest: () => (
        isActiveRef.current
        && activeSessionIdRef.current === selectedSessionId
      ),
    }).then(slot => {
      if (slot) {
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.offset;
        if (slot.tokenUsage) { // см. пояснение выше: пустое не затирает счётчик
          setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
        }
      }
      if (activeSessionIdRef.current === selectedSessionId) {
        if (slot?.status === 'error') {
          setHistoryLoadError(true);
        } else if (slot) {
          historyRetryAttemptsRef.current = 0;
          setHistoryLoadError(false);
          setTranscriptMissing(slot.transcriptMissing);
        }
      }
      setIsLoadingSessionMessages(false);
    }).catch(() => {
      setIsLoadingSessionMessages(false);
    });
  }, [
    isActive,
    historyRetryTick,
    resetStreamingState,
    requestLatestMessages,
    selectedProject,
    selectedSession?.id,
    sessionStore,
  ]);

  // Упавший запрос истории повторяется сам: через 2, 5, 10, дальше каждые 20 с,
  // пока чат открыт. Раньше после обрыва связи чат оставался пустым до
  // повторного открытия.
  useEffect(() => {
    if (!historyLoadError || !isActive || isLoadingSessionMessages) return undefined;
    const delays = [2000, 5000, 10000, 20000];
    const delay = delays[Math.min(historyRetryAttemptsRef.current, delays.length - 1)];
    const timer = setTimeout(() => {
      historyRetryAttemptsRef.current += 1;
      lastLoadedSessionKeyRef.current = null;
      setHistoryRetryTick((tick) => tick + 1);
    }, delay);
    return () => clearTimeout(timer);
  }, [historyLoadError, historyRetryTick, isActive, isLoadingSessionMessages]);

  const retryHistoryLoad = useCallback(() => {
    historyRetryAttemptsRef.current = 0;
    lastLoadedSessionKeyRef.current = null;
    setHistoryRetryTick((tick) => tick + 1);
  }, []);

  // Hidden refresh signals are coalesced. An initial page load supersedes a
  // pending latest refresh for an unhydrated/loading slot; otherwise activation
  // flushes exactly one request for the selected session.
  useEffect(() => {
    if (!isActive || !activeSessionId) return;

    const slot = sessionStore.getSessionSlot(activeSessionId);
    if (!slot?.fetchedAt || slot.status === 'loading') {
      refreshCoordinatorRef.current?.discardPending(activeSessionId);
      return;
    }

    void refreshCoordinatorRef.current?.flushPending(activeSessionId);
  }, [activeSessionId, isActive, sessionStore]);

  // External message update (e.g. WebSocket reconnect, background refresh)
  useEffect(() => {
    if (!externalMessageUpdate || !selectedSession || !selectedProject) return;

    const reloadExternalMessages = async () => {
      try {
        // Skip store refresh during active streaming — кроме чата, пережившего
        // перезапуск сайта: живого потока у него нет, и без перечитывания его
        // шаги появлялись бы разом только в конце.
        if (!isProcessing || isDetachedRun(selectedSession.id)) {
          const shouldStickToBottom = isActiveRef.current && isNearBottom();
          await requestLatestMessages(selectedSession.id);

          if (shouldStickToBottom) {
            setTimeout(() => scrollToBottom(), 200);
          }
        }
      } catch (error) {
        console.error('Error reloading messages from external update:', error);
      }
    };

    reloadExternalMessages();
  }, [
    externalMessageUpdate,
    isNearBottom,
    requestLatestMessages,
    scrollToBottom,
    selectedProject,
    selectedSession,
    isProcessing,
  ]);

  // Search navigation target
  useEffect(() => {
    const session = selectedSession as Record<string, unknown> | null;
    const targetSnippet = session?.__searchTargetSnippet;
    const targetTimestamp = session?.__searchTargetTimestamp;
    if (typeof targetSnippet === 'string' && targetSnippet) {
      searchScrollActiveRef.current = true;
      setSearchTarget({
        snippet: targetSnippet,
        timestamp: typeof targetTimestamp === 'string' ? targetTimestamp : undefined,
      });
    }
  }, [selectedSession]);

  // Scroll to search target
  useEffect(() => {
    if (!isActive || !searchTarget || chatMessages.length === 0 || isLoadingSessionMessages) return;

    const target = searchTarget;
    setSearchTarget(null);

    const scrollToTarget = async () => {
      if (!allMessagesLoadedRef.current && selectedSession && selectedProject) {
          try {
            // Load all messages into the store for search navigation
            const slot = await sessionStore.fetchFromServer(selectedSession.id, {
              limit: null,
              offset: 0,
              canRequest: () => (
                isActiveRef.current
                && activeSessionIdRef.current === selectedSession.id
              ),
            });
            if (slot) {
              setHasMoreMessages(false);
              setTotalMessages(slot.total);
              messagesOffsetRef.current = slot.offset;
              setVisibleMessageCount(Infinity);
              setAllMessagesLoaded(true);
              allMessagesLoadedRef.current = true;
              await new Promise(resolve => setTimeout(resolve, 300));
            } else if (!isActiveRef.current) {
              setSearchTarget(target);
              return;
            }
          } catch {
            // Fall through and scroll in current messages
          }
      }
      setVisibleMessageCount(Infinity);

      const findAndScroll = (retriesLeft: number) => {
        const container = scrollContainerRef.current;
        if (!container) return;

        let targetElement: Element | null = null;

        if (target.snippet) {
          const cleanSnippet = target.snippet.replace(/^\.{3}/, '').replace(/\.{3}$/, '').trim();
          const searchPhrase = cleanSnippet.slice(0, 80).toLowerCase().trim();
          if (searchPhrase.length >= 10) {
            const messageElements = container.querySelectorAll('.chat-message');
            for (const el of messageElements) {
              const text = (el.textContent || '').toLowerCase();
              if (text.includes(searchPhrase)) { targetElement = el; break; }
            }
          }
        }

        if (!targetElement && target.timestamp) {
          const targetDate = new Date(target.timestamp).getTime();
          const messageElements = container.querySelectorAll('[data-message-timestamp]');
          let closestDiff = Infinity;
          for (const el of messageElements) {
            const ts = el.getAttribute('data-message-timestamp');
            if (!ts) continue;
            const diff = Math.abs(new Date(ts).getTime() - targetDate);
            if (diff < closestDiff) { closestDiff = diff; targetElement = el; }
          }
        }

        if (targetElement) {
          targetElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
          targetElement.classList.add('search-highlight-flash');
          setTimeout(() => targetElement?.classList.remove('search-highlight-flash'), 4000);
          searchScrollActiveRef.current = false;
        } else if (retriesLeft > 0) {
          setTimeout(() => findAndScroll(retriesLeft - 1), 200);
        } else {
          searchScrollActiveRef.current = false;
        }
      };

      setTimeout(() => findAndScroll(15), 150);
    };

    scrollToTarget();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages.length, isActive, isLoadingSessionMessages, searchTarget]);

  // Счётчик токенов открытого чата. Смена чата сразу убирает цифры прежнего;
  // запрос к серверу — при открытии, при возврате на вкладку и после конца
  // каждого ответа (во время ответа цифры идут живыми событиями). Раньше
  // запрос шёл только при смене чата, а обнуление в эффекте загрузки истории
  // могло сработать уже ПОСЛЕ ответа сервера — окно показывало «0» (22.09.26).
  const tokenUsageSessionId = selectedSession?.id || null;
  const tokenUsageSessionRef = useRef(tokenUsageSessionId);
  tokenUsageSessionRef.current = tokenUsageSessionId;
  useEffect(() => {
    setTokenBudget(null);
  }, [tokenUsageSessionId]);

  useEffect(() => {
    if (!tokenUsageSessionId || !isActive) {
      return undefined;
    }
    // Ответ отбрасывается, только если открыт уже другой чат: перезапуск
    // эффекта из-за смены «идёт ответ» / вкладки прежний запрос не отменяет
    // (иначе кнопка ждала второго запроса — 7 с «0 токенов», замер 23.09.26).
    const fetchTokenUsage = async () => {
      try {
        // The provider module resolves storage and provider details from the session id.
        const url = `/api/providers/sessions/${encodeURIComponent(tokenUsageSessionId)}/token-usage`;
        const response = await authenticatedFetch(url);
        if (tokenUsageSessionRef.current !== tokenUsageSessionId || !response.ok) return;
        const payload = await response.json();
        if (tokenUsageSessionRef.current === tokenUsageSessionId && payload?.data) {
          setTokenBudget(payload.data);
        }
      } catch (error) {
        console.error('Failed to fetch token usage:', error);
      }
    };
    fetchTokenUsage();
    // Конец ответа: последняя строка файла переписки может дописаться чуть
    // позже сигнала «готово» — ещё один запрос через 3 с.
    const settleTimer = isProcessing ? null : setTimeout(fetchTokenUsage, 3000);
    return () => {
      if (settleTimer) clearTimeout(settleTimer);
    };
  }, [tokenUsageSessionId, isActive, isProcessing]);

  const visibleMessages = useMemo(() => {
    if (chatMessages.length <= visibleMessageCount) return chatMessages;
    return chatMessages.slice(-visibleMessageCount);
  }, [chatMessages, visibleMessageCount]);

  useEffect(() => {
    if (!isActive) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    scrollPositionRef.current = { height: container.scrollHeight, top: container.scrollTop };
  });

  useEffect(() => {
    if (!isActive) return;
    if (!scrollContainerRef.current || chatMessages.length === 0) return;
    if (isLoadingMoreRef.current || isLoadingMoreMessages || growthCheckRef.current !== null) return;
    if (searchScrollActiveRef.current) return;

    if (isUserScrolledUp) {
      return;
    }

    // Проверка повторяется В МОМЕНТ срабатывания, а не только при назначении,
    // и таймер снимается при пересборке.
    //
    // Рывки 11.09.26: во время ответа строки появляются часто, и на каждую
    // назначался догон вниз через 50 мс. Ни отмены, ни перепроверки не было —
    // поэтому стоило начать листать вверх, как уже назначенные догоны
    // продолжали дёргать ленту вниз. Со стороны это выглядит так, будто лента
    // не листается, а только дёргается.
    const timer = setTimeout(() => {
      if (isUserScrolledUpRef.current) return;
      scrollToBottom();
    }, 50);
    return () => clearTimeout(timer);
  }, [chatMessages.length, isActive, isLoadingMoreMessages, isUserScrolledUp, scrollToBottom]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // "Load all" overlay visibility is driven by scroll-to-top in handleScroll;
  // timers are cleared on session change via the reset effect above.

  const loadAllMessages = useCallback(async () => {
    if (!isActive) return;
    if (!selectedSession || !selectedProject) return;
    if (isLoadingAllMessages) return;
    const requestSessionId = selectedSession.id;
    allMessagesLoadedRef.current = true;
    isLoadingMoreRef.current = true;
    setIsLoadingAllMessages(true);
    setShowLoadAllOverlay(true);
    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }

    try {
      const slot = await sessionStore.fetchFromServer(requestSessionId, {
        limit: null,
        offset: 0,
        canRequest: () => (
          isActiveRef.current
          && activeSessionIdRef.current === requestSessionId
        ),
      });

      if (currentSessionId !== requestSessionId) return;

      if (slot) {
        setHasMoreMessages(false);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.offset;
        setVisibleMessageCount(Infinity);
        setAllMessagesLoaded(true);

        setLoadAllJustFinished(true);
        if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
        loadAllFinishedTimerRef.current = setTimeout(() => {
          setLoadAllJustFinished(false);
          setShowLoadAllOverlay(false);
          loadAllFinishedTimerRef.current = null;
        }, 2500);
      } else {
        allMessagesLoadedRef.current = false;
        setShowLoadAllOverlay(false);
      }
    } catch (error) {
      console.error('Error loading all messages:', error);
      allMessagesLoadedRef.current = false;
      setShowLoadAllOverlay(false);
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingAllMessages(false);
    }
  }, [isActive, selectedSession, selectedProject, isLoadingAllMessages, currentSessionId, sessionStore]);

  const loadEarlierMessages = useCallback(() => {
    setVisibleMessageCount((prev) => prev + 100);
  }, []);

  return {
    chatMessages,
    addMessage,
    clearMessages,
    rewindMessages,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    isNearBottom,
    handleScroll,
    handleUserScrollGesture,
    requestLatestMessages,
    loadOlderMessagesNow,
    historyLoadError,
    retryHistoryLoad,
    transcriptMissing,
    setTopSentinel,
  };
}

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../shared/utils';
import { expireAuthSession, isAuthTokenExpired } from '../utils/api';
import { flipDoor, getDoorHost, markDoorWorked } from '../utils/doors';

import { ChatOutbox, isChatSend, SLOT_RETRY_MS, SLOT_WAIT_CODE, type OutboxEntry } from './chatOutbox';
import { decideConnectionAction } from './connectionWatchdog';

/**
 * One frame received from the chat websocket. The server guarantees every
 * frame carries a `kind` (provider message kinds plus gateway kinds such as
 * `chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`). The synthetic `websocket_reconnected` kind is injected
 * client-side when the socket re-opens after a drop, and `chat_send_failed`
 * when a chat message never got the server's receipt (see chatOutbox.ts).
 */
export type ServerEvent = {
  kind?: string;
  type?: string;
  sessionId?: string;
  seq?: number;
  /** Метка работы события — см. chat/utils/liveRunCursor. */
  runStartedAt?: number | null;
  [key: string]: unknown;
};

type ServerEventListener = (event: ServerEvent) => void;

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  /**
   * Subscribes to every websocket frame. Returns an unsubscribe function.
   *
   * This is the primary consumption API: events are dispatched synchronously
   * to every listener, so rapid back-to-back frames can never be coalesced or
   * dropped the way a single "latest message" state slot could.
   */
  subscribe: (listener: ServerEventListener) => () => void;
  /**
   * Legacy state-based access to the most recent frame.
   *
   * Kept only for low-frequency consumers (TaskMaster broadcasts). High-rate
   * chat streams must use `subscribe` — React may batch state updates, which
   * makes `latestMessage` lossy under load.
   */
  latestMessage: ServerEvent | null;
  isConnected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

/**
 * Сколько ждать расписку сервера. Сервер расписывается сразу после приёма,
 * до обращения к модели, — десятка секунд без неё значит, что связь
 * «полумёртвая»: считается открытой, а данные не ходят (iPhone после фона).
 */
const ACK_TIMEOUT_MS = 10_000;
/** Как часто проверять очередь, пока в ней что-то есть. */
const OUTBOX_CHECK_MS = 3_000;
/**
 * Соединение, не открывшееся за это время, пересоздаётся — уже через другой
 * вход (utils/doors.js). Было 15 с; 8 с хватает и для плохой мобильной связи,
 * а смена входа безвредна: оба ведут на один сервер.
 */
const CONNECT_STALL_MS = 8_000;
/**
 * Как часто сторож связи проверяет, что соединение на месте. Работает всегда,
 * а не только когда есть что отправлять: связь нужна и молчащей странице —
 * без неё не придут ни ответ работающего агента, ни события чужих вкладок.
 */
const CONNECTION_CHECK_MS = 5_000;
/** Сколько ждать от сервера сообщения о возможностях, прежде чем счесть его старым. */
const HELLO_GRACE_MS = 2_000;
/** Что умеет страница; сервер отвечает `server_capabilities` только знающим. */
const SOCKET_CAPS = 'send-ack-1';

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // `caps` — страница понимает расписки: только тогда сервер шлёт ей
  // `server_capabilities` (старая страница вывела бы его в ленту строкой).
  if (IS_PLATFORM) return `${protocol}//${getDoorHost()}/ws?caps=${SOCKET_CAPS}`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  if (isAuthTokenExpired(token)) {
    expireAuthSession();
    return null;
  }
  return `${protocol}//${getDoorHost()}/ws?token=${encodeURIComponent(token)}&caps=${SOCKET_CAPS}`; // OSS mode: Use same host:port that served the page
};

const createOutbox = (): ChatOutbox => {
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  return new ChatOutbox(storage);
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const failedAttemptsRef = useRef(0); // подряд не открывшихся соединений (для смены входа)
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  const [latestMessage, setLatestMessage] = useState<ServerEvent | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { isLoading: isAuthLoading, token, user } = useAuth();
  // Очередь сообщений чата, ждущих расписки сервера (см. chatOutbox.ts).
  const outboxRef = useRef<ChatOutbox | null>(null);
  if (!outboxRef.current) {
    outboxRef.current = createOutbox();
  }
  const outboxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectStartedAtRef = useRef(0);
  const connectRef = useRef<() => void>(() => {});
  const ensureConnectionRef = useRef<() => boolean>(() => false);
  /**
   * Умеет ли сервер этого соединения расписываться в получении. Страница может
   * оказаться новее сервера (соседняя выкатка вернула старый сервер, а вкладка
   * не перезагружалась) — 15.09.26 так страница досылала сообщение старому
   * серверу каждые 12 секунд, получала «already has a run in progress» и в
   * конце писала «не дошло», хотя агент уже работал. Досылать можно только
   * серверу, который сам сказал, что узнаёт повторы.
   */
  const ackModeRef = useRef<'unknown' | 'ack' | 'legacy'>('unknown');
  const helloTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushRef = useRef<(socket: WebSocket) => void>(() => {});

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
    setLatestMessage(event);
  }, []);

  /** Отправка сообщения из очереди; `false` — сокет не принял данные. */
  const transmit = useCallback((socket: WebSocket, entry: OutboxEntry): boolean => {
    try {
      socket.send(JSON.stringify(entry.message));
      outboxRef.current?.markSent(entry.id);
      return true;
    } catch (error) {
      console.warn('[outbox] сокет не принял сообщение:', error);
      return false;
    }
  }, []);

  /** Сказать в ленте, что сообщение не ушло, и вернуть его текст. */
  const reportFailed = useCallback((entries: OutboxEntry[]) => {
    for (const entry of entries) {
      dispatch({
        kind: 'chat_send_failed',
        sessionId: typeof entry.message.sessionId === 'string' ? entry.message.sessionId : undefined,
        clientMessageId: entry.id,
        content: entry.message.content,
        timestamp: Date.now(),
      });
    }
  }, [dispatch]);

  /** Честный отказ по сообщениям, которые больше не досылаются. */
  const reportGivenUp = useCallback(() => {
    const givenUp = outboxRef.current?.takeGivenUp(ACK_TIMEOUT_MS) ?? [];
    if (givenUp.length > 0) console.warn('[outbox] сообщения так и не получили расписку сервера', givenUp.map((e) => e.id));
    reportFailed(givenUp);
  }, [reportFailed]);

  /**
   * Бросить текущее соединение и открыть новое, не дожидаясь `onclose`: у
   * «полумёртвого» сокета на iPhone он может не прийти никогда.
   */
  const forceReconnect = useCallback((reason: string) => {
    if (unmountedRef.current) return;
    console.warn(`[outbox] пересоздаю соединение: ${reason}`);
    const stale = wsRef.current;
    if (stale) {
      stale.onopen = null;
      stale.onmessage = null;
      stale.onclose = null;
      stale.onerror = null;
      try {
        stale.close();
      } catch {
        // закрываем мёртвое — ошибка не важна
      }
    }
    wsRef.current = null;
    setIsConnected(false);
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    connectRef.current();
  }, []);

  /**
   * Довести связь до рабочего состояния, чем бы она ни была прервана.
   *
   * Раньше эта проверка жила ВНУТРИ разбора очереди и потому работала только
   * тогда, когда в очереди ждало сообщение. Пустая очередь — и страница
   * оставалась без связи сколько угодно: поймано 20.09.26 на телефоне, где
   * вкладка после сна простояла 11 минут с красным индикатором, не сделав ни
   * одной попытки подключиться (в журнале сервера — ни одного обращения к
   * `/ws`). Единственным лекарем связи был таймер на 3 секунды из `onclose`,
   * а его Chrome на Android замораживает вместе с фоновой вкладкой.
   * Связь — не свойство очереди, поэтому и следит за ней теперь отдельный
   * сторож, работающий всегда.
   *
   * `false` — связи нет и подключение уже идёт или назначено.
   */
  const ensureConnection = useCallback((): boolean => {
    if (unmountedRef.current) return false;
    const socket = wsRef.current;
    const action = decideConnectionAction({
      readyState: socket ? socket.readyState : null,
      reconnectScheduled: reconnectTimeoutRef.current !== null,
      connectingForMs: Date.now() - connectStartedAtRef.current,
      stallMs: CONNECT_STALL_MS,
    });
    switch (action) {
      case 'ok':
        return true;
      case 'connect':
        connectRef.current();
        return false;
      case 'recreate':
        if (socket && socket.readyState === WebSocket.CONNECTING) {
          flipDoor('рукопожатие чата зависло');
          failedAttemptsRef.current = 0; // на новом входе счёт неудач начинается заново
        }
        forceReconnect(
          socket && socket.readyState === WebSocket.CONNECTING
            ? 'соединение не устанавливается'
            : 'соединение закрыто без уведомления',
        );
        return false;
      default:
        return false;
    }
  }, [forceReconnect]);
  ensureConnectionRef.current = ensureConnection;

  const scheduleOutboxCheck = useCallback(() => {
    if (outboxTimerRef.current || unmountedRef.current) return;
    outboxTimerRef.current = setTimeout(() => {
      outboxTimerRef.current = null;
      const outbox = outboxRef.current;
      if (!outbox || outbox.size === 0 || unmountedRef.current) return;

      reportGivenUp();
      if (outbox.size === 0) return;

      // Состояние связи разбирает ensureConnection — здесь остаётся только то,
      // что относится к самой очереди.
      const socket = ensureConnection() ? wsRef.current! : null;
      if (socket) {
        if (ackModeRef.current === 'legacy') {
          flushRef.current(socket);
        } else if (ackModeRef.current === 'ack' && outbox.overdue(ACK_TIMEOUT_MS).length > 0) {
          forceReconnect('нет расписки сервера о получении сообщения');
        } else if (ackModeRef.current === 'ack') {
          // Сообщения, ждущие свободного места, — повтор раз в SLOT_RETRY_MS.
          for (const entry of outbox.dueSlotRetries(SLOT_RETRY_MS)) {
            if (!transmit(socket, entry)) {
              forceReconnect('сокет не принял сообщение');
              break;
            }
          }
        }
      }
      scheduleOutboxCheck();
    }, OUTBOX_CHECK_MS);
  }, [ensureConnection, forceReconnect, reportGivenUp, transmit]);

  /** Отправить очередь по открытому соединению с учётом того, что умеет сервер. */
  const flushOutbox = useCallback((socket: WebSocket) => {
    const outbox = outboxRef.current;
    if (!outbox || socket.readyState !== WebSocket.OPEN) return;
    reportGivenUp();
    const mode = ackModeRef.current;
    if (mode === 'unknown') return;
    for (const entry of outbox.pending()) {
      if (mode === 'legacy') {
        // Старый сервер: расписок не шлёт и повтор не узнает (второй раз
        // ответит «чат занят»), — отправляем один раз, как было до очереди.
        if (entry.lastSentAt === null && !transmit(socket, entry)) break;
        outbox.settle(entry.id);
      } else if (outbox.isQueuedBehindInSession(entry)) {
        // Второе ждущее сообщение чата уходит только после первого.
        continue;
      } else if (!transmit(socket, entry)) {
        break;
      }
    }
    if (outbox.size > 0) scheduleOutboxCheck();
  }, [reportGivenUp, transmit, scheduleOutboxCheck]);
  flushRef.current = flushOutbox;

  useEffect(() => {
    // The cleanup below sets unmountedRef = true. Without this reset, every
    // re-run of the effect (e.g. on token refresh) would short-circuit connect()
    // at its unmounted guard and leave the socket permanently disconnected.
    unmountedRef.current = false;
    if (!IS_PLATFORM && (isAuthLoading || !user)) {
      return undefined;
    }
    connect();
    // Сообщения, не получившие расписку до перезагрузки страницы, дошлются.
    if ((outboxRef.current?.size ?? 0) > 0) {
      scheduleOutboxCheck();
    }

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (outboxTimerRef.current) {
        clearTimeout(outboxTimerRef.current);
        outboxTimerRef.current = null;
      }
      if (helloTimerRef.current) {
        clearTimeout(helloTimerRef.current);
        helloTimerRef.current = null;
      }
      const activeSocket = wsRef.current;
      if (activeSocket) {
        // Prevent the intentionally closed, old-token socket from scheduling
        // a reconnect after the refreshed-token effect has already started.
        activeSocket.onopen = null;
        activeSocket.onmessage = null;
        activeSocket.onclose = null;
        activeSocket.onerror = null;
        activeSocket.close();
        wsRef.current = null;
      }
    };
  }, [isAuthLoading, token, user]); // reconnect after authentication or token refresh

  const connect = useCallback(() => {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    if (!IS_PLATFORM && (isAuthLoading || !user)) return;
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

      const websocket = new WebSocket(wsUrl);
      // Store connecting sockets too, so a token refresh can close them before
      // their handshake completes with stale credentials.
      wsRef.current = websocket;
      connectStartedAtRef.current = Date.now();

      let openedThisAttempt = false;
      websocket.onopen = () => {
        openedThisAttempt = true;
        failedAttemptsRef.current = 0;
        markDoorWorked();
        setIsConnected(true);
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;

        // Очередь уходит, когда сервер скажет, умеет ли он расписываться
        // (`server_capabilities` — первое, что он шлёт). Промолчал — это
        // старый сервер: отправляем один раз, без повторов.
        ackModeRef.current = 'unknown';
        if (helloTimerRef.current) clearTimeout(helloTimerRef.current);
        helloTimerRef.current = setTimeout(() => {
          helloTimerRef.current = null;
          if (wsRef.current !== websocket || ackModeRef.current !== 'unknown') return;
          console.warn('[outbox] сервер не сообщил о расписках — старая версия, отправляю без повторов');
          ackModeRef.current = 'legacy';
          flushRef.current(websocket);
        }, HELLO_GRACE_MS);
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          if (data.kind === 'server_capabilities') {
            ackModeRef.current = data.chatSendAck === true ? 'ack' : 'legacy';
            if (helloTimerRef.current) {
              clearTimeout(helloTimerRef.current);
              helloTimerRef.current = null;
            }
            flushRef.current(websocket);
            return;
          }
          if (data.kind === 'chat_send_ack') {
            ackModeRef.current = 'ack';
            if (outboxRef.current?.isWaitingForSlot(data.clientMessageId)) {
              // Ждавшее места сообщение наконец принято — отметить в ленте.
              dispatch({ kind: 'chat_send_waiting_done', sessionId: data.sessionId, clientMessageId: data.clientMessageId, timestamp: Date.now() });
            }
            outboxRef.current?.settle(data.clientMessageId);
            return;
          }
          if (data.kind === 'protocol_error') {
            const outbox = outboxRef.current;
            const waitsForSlot = data.code === SLOT_WAIT_CODE
              || (data.code === 'RUN_IN_PROGRESS' && Boolean(outbox?.isWaitingForSlot(data.clientMessageId)));
            if (data.clientMessageId && outbox && waitsForSlot) {
              // Предел одновременных чатов — не окончательный отказ: сообщение
              // остаётся в очереди и уйдёт само, когда место освободится.
              // В ленте — одно спокойное пояснение, без красной ошибки.
              if (outbox.markWaitingForSlot(data.clientMessageId)) {
                const entry = outbox.pending().find((item) => item.id === data.clientMessageId);
                dispatch({
                  kind: 'chat_send_waiting',
                  sessionId: data.sessionId,
                  clientMessageId: data.clientMessageId,
                  limit: data.limit,
                  content: entry?.message.content,
                  timestamp: Date.now(),
                });
              }
              scheduleOutboxCheck();
              return;
            }
            if (data.clientMessageId) {
              // Сервер отказал именно этому сообщению — досылать бессмысленно.
              outboxRef.current?.settle(data.clientMessageId);
            } else if (data.code === 'RUN_IN_PROGRESS' && typeof data.sessionId === 'string') {
              // «Чат уже работает» без номера — ответ старого сервера. Повтором
              // это не лечится, только множит красные ошибки в ленте.
              const dropped = outboxRef.current?.settleSession(data.sessionId) ?? [];
              // Об одном сообщении скажет сама ошибка в ленте; об остальных
              // из очереди этого чата — отдельно и с текстом, чтобы не пропали молча.
              reportFailed(dropped.slice(1));
            }
          }
          dispatch(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        if (wsRef.current !== websocket) {
          return;
        }
        setIsConnected(false);
        wsRef.current = null;

        // Не открылось два раза подряд — пробуем другой вход.
        if (!openedThisAttempt) {
          failedAttemptsRef.current += 1;
          if (failedAttemptsRef.current >= 2) {
            failedAttemptsRef.current = 0;
            flipDoor('чат дважды не открылся');
          }
        }

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = null;
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          connect();
        }, 3000);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [dispatch, isAuthLoading, token, user, reportGivenUp, reportFailed, transmit, scheduleOutboxCheck]); // reconnect with current authentication state
  connectRef.current = connect;

  // Приложение вернулось из фона или появилась сеть. Первым делом — связь, и
  // независимо от очереди: телефон, проснувшись, чаще всего держит сокет,
  // который сервер уже закрыл, а `onclose` замёрз вместе с вкладкой. Если
  // сверх того есть сообщения без расписки, связи не доверяем даже открытой:
  // на iPhone сокет после сна часто числится открытым, но мёртв, — открываем
  // новый и досылаем.
  useEffect(() => {
    const onResume = () => {
      if (document.visibilityState === 'hidden') return;
      if (!ensureConnectionRef.current()) return;
      const outbox = outboxRef.current;
      if (!outbox || outbox.size === 0) return;
      const socket = wsRef.current;
      if (socket && socket.readyState === WebSocket.OPEN && ackModeRef.current === 'ack' && outbox.overdue(0).length > 0) {
        forceReconnect('приложение вернулось из фона, сообщение ждёт расписки');
      } else {
        scheduleOutboxCheck();
      }
    };
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('pageshow', onResume);
    window.addEventListener('online', onResume);
    return () => {
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('pageshow', onResume);
      window.removeEventListener('online', onResume);
    };
  }, [forceReconnect, scheduleOutboxCheck]);

  /**
   * Сторож связи. Единственный механизм восстановления, не зависящий ни от
   * события `onclose` (его может не быть у сокета, уснувшего в фоне), ни от
   * очереди сообщений, ни от того, дошёл ли `connect()` до конца: исключение
   * при создании сокета раньше тоже оставляло страницу без связи навсегда.
   */
  useEffect(() => {
    if (!IS_PLATFORM && (isAuthLoading || !user)) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      ensureConnectionRef.current();
    }, CONNECTION_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [isAuthLoading, user]);

  const sendMessage = useCallback((message: unknown) => {
    const socket = wsRef.current;
    if (isChatSend(message)) {
      // Сообщение чата не выбрасывается никогда: оно ждёт в очереди, пока
      // сервер не распишется в получении.
      const outbox = outboxRef.current!;
      const behindWaiting = outbox.hasWaitingInSession(message.sessionId);
      const entry = outbox.add(message);
      if (behindWaiting) {
        // В этом чате уже ждёт места более раннее сообщение — новое встаёт
        // за ним, иначе ушло бы первым и перепутало порядок.
        outbox.markWaitingForSlot(entry.id);
      } else if (socket && socket.readyState === WebSocket.OPEN && ackModeRef.current !== 'unknown') {
        if (!transmit(socket, entry)) {
          forceReconnect('сокет не принял сообщение');
        } else if (ackModeRef.current === 'legacy') {
          outboxRef.current!.settle(entry.id);
        }
      } else if (socket && socket.readyState === WebSocket.OPEN) {
        // Сервер ещё не сказал, умеет ли расписываться, — уйдёт через миг.
      } else {
        console.warn('WebSocket not connected — сообщение ждёт в очереди');
      }
      scheduleOutboxCheck();
      return;
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected');
    }
  }, [forceReconnect, scheduleOutboxCheck, transmit]);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    subscribe,
    latestMessage,
    isConnected
  }), [sendMessage, subscribe, latestMessage, isConnected]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;

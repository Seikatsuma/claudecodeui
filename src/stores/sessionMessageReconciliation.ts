import type { NormalizedMessage } from './useSessionStore';

const LOCAL_USER_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const LOCAL_USER_DEDUPE_CLOCK_SKEW_MS = 10_000;
const LOCAL_ATTACHMENT_ONLY_DEDUPE_WINDOW_MS = 30_000;

type UserTurnFingerprint = {
  text: string;
  imageCount: number;
  fileCount: number;
};

function userTurnFingerprint(message: NormalizedMessage): UserTurnFingerprint | null {
  if (message.kind !== 'text' || message.role !== 'user') return null;

  const text = (message.content || '').trim();
  const imageCount = Array.isArray(message.images) ? message.images.length : 0;
  const fileCount = Array.isArray(message.files) ? message.files.length : 0;
  if (!text && imageCount === 0 && fileCount === 0) return null;

  return { text, imageCount, fileCount };
}

function userTurnFingerprintsMatch(
  local: UserTurnFingerprint,
  server: UserTurnFingerprint,
): boolean {
  return (
    local.text === server.text
    && local.imageCount === server.imageCount
    && local.fileCount === server.fileCount
  );
}

function readMessageTime(message: NormalizedMessage): number | null {
  const time = Date.parse(message.timestamp);
  return Number.isFinite(time) ? time : null;
}

function findServerEchoForLocalUser(
  localMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  claimedServerIds: Set<string>,
): NormalizedMessage | null {
  const localFingerprint = userTurnFingerprint(localMessage);
  const localTime = readMessageTime(localMessage);
  if (!localFingerprint || localTime === null) {
    return null;
  }

  const dedupeWindow = localFingerprint.text
    ? LOCAL_USER_DEDUPE_WINDOW_MS
    : LOCAL_ATTACHMENT_ONLY_DEDUPE_WINDOW_MS;
  let closestMatch: NormalizedMessage | null = null;
  let closestTimeDifference = Number.POSITIVE_INFINITY;

  for (const serverMessage of serverMessages) {
    if (claimedServerIds.has(serverMessage.id)) {
      continue;
    }

    const serverFingerprint = userTurnFingerprint(serverMessage);
    if (!serverFingerprint || !userTurnFingerprintsMatch(localFingerprint, serverFingerprint)) {
      continue;
    }

    const serverTime = readMessageTime(serverMessage);
    if (
      serverTime === null
      || serverTime < localTime - LOCAL_USER_DEDUPE_CLOCK_SKEW_MS
      || serverTime - localTime > dedupeWindow
    ) {
      continue;
    }

    const timeDifference = Math.abs(serverTime - localTime);
    if (timeDifference < closestTimeDifference) {
      closestMatch = serverMessage;
      closestTimeDifference = timeDifference;
    }
  }

  return closestMatch;
}

/** Строка сообщения человека, которую сервер разослал, отправляя его из очереди. */
function isQueuedUserEcho(message: NormalizedMessage): boolean {
  return message.id.startsWith('queued_') && message.kind === 'text' && message.role === 'user';
}

/**
 * Живая строка из серверной очереди встаёт НА МЕСТО пузыря, который вкладка
 * уже нарисовала сама.
 *
 * Стык ходов: вкладка считает ход законченным и рисует сообщение сразу, а на
 * сервере ход ещё дописывается — сообщение ложится в очередь и через секунды
 * уходит оттуда строкой `queued_…`. Без замены в ленте две копии: Егор
 * 21.09.26 — «2» в 16:53:39 и «2» в 16:53:54, «зачем дублировать?». Время
 * берём серверное: оно совпадает с записью на диске, и по нему строку потом
 * снимает removeOptimisticUserEchoes, сколько бы сообщение ни ждало очереди.
 *
 * Строка с номером, который в ленте уже есть, — та же строка, доставленная
 * второй раз: встаёт на своё место, а не второй копией. Егор 27.09.26 —
 * сообщение с картинкой из очереди дважды, обе копии `queued_…` в 17:15:38
 * (одна отправка по журналу сервера), «зачем дубль?». Путь повторной
 * доставки по коду не нашёлся — отсев по `seq` стоит везде, — поэтому
 * лента сама не принимает одну строку дважды, откуда бы та ни пришла.
 */
export function appendRealtimeWithQueuedEcho(
  realtimeMessages: NormalizedMessage[],
  incoming: NormalizedMessage,
): NormalizedMessage[] {
  const sameIdIndex = incoming.id
    ? realtimeMessages.findIndex((message) => message.id === incoming.id)
    : -1;
  if (sameIdIndex !== -1) {
    const next = realtimeMessages.slice();
    next[sameIdIndex] = incoming;
    return next;
  }

  const fingerprint = isQueuedUserEcho(incoming) ? userTurnFingerprint(incoming) : null;
  const incomingTime = readMessageTime(incoming);
  if (fingerprint && incomingTime !== null) {
    const index = realtimeMessages.findIndex((message) => {
      if (!message.id.startsWith('local_')) return false;
      const local = userTurnFingerprint(message);
      const localTime = readMessageTime(message);
      return Boolean(local)
        && userTurnFingerprintsMatch(local as UserTurnFingerprint, fingerprint)
        && localTime !== null
        && localTime <= incomingTime + LOCAL_USER_DEDUPE_CLOCK_SKEW_MS;
    });
    if (index !== -1) {
      const next = realtimeMessages.slice();
      next[index] = incoming;
      return next;
    }
  }
  return [...realtimeMessages, incoming];
}

/**
 * Removes local optimistic user rows (and rows the server sent from its queue)
 * once a corresponding persisted turn is available. Matches are one-to-one so
 * repeated sends cannot claim one row.
 */
export function removeOptimisticUserEchoes(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage[] {
  const claimedServerIds = new Set<string>();

  return realtimeMessages.filter((message) => {
    if (!message.id.startsWith('local_') && !isQueuedUserEcho(message)) {
      return true;
    }

    const serverEcho = findServerEchoForLocalUser(message, serverMessages, claimedServerIds);
    if (!serverEcho) {
      return true;
    }

    claimedServerIds.add(serverEcho.id);
    return false;
  });
}

/**
 * Длинный живой ответ, который уже лежит на диске слово в слово — где угодно
 * в загруженной части переписки, а не только «в том же ходе».
 *
 * Сверка по ходу считает ходы по сообщениям человека, а на диске бывают
 * сообщения, которых нет в живом потоке (уведомления о фоновых задачах,
 * вложения). Счёт съезжает, ход находится не тот, и живая копия остаётся:
 * 14.09.26 у Егора ответ «Как я понял задачу. Нужен документ…» встал в ленту
 * второй раз ниже, через «Ход работы» и другой ответ. Совпадение длинного
 * текста целиком случайным не бывает, поэтому здесь ход не нужен.
 */
export function isLongReplyAlreadyOnServer(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
): boolean {
  const content = (message.content || '').trim();
  if (content.length < 40) {
    return false;
  }
  return serverMessages.some((serverMessage) => (
    serverMessage.kind === 'text'
    && serverMessage.role === 'assistant'
    && (serverMessage.content || '').trim() === content
  ));
}

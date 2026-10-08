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

export function readMessageTime(message: NormalizedMessage): number | null {
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

/* ------------------------------------------------------------------------ */
/*  Склейка ленты: серверная история + живые строки                          */
/*                                                                          */
/*  Живёт здесь, а не в useSessionStore.ts: стор тянет utils/api →            */
/*  import.meta.env, и node-тесты его не загружают. Случаи с дублями          */
/*  (снимки Егора 11.09/14.09/21.09/27.09/08.10.26) прогоняются через          */
/*  computeMerged напрямую, без браузера.                                    */
/* ------------------------------------------------------------------------ */

export function compareMessagesChronologically(a: NormalizedMessage, b: NormalizedMessage): number {
  const timeA = readMessageTime(a) ?? 0;
  const timeB = readMessageTime(b) ?? 0;
  if (timeA !== timeB) {
    return timeA - timeB;
  }
  return 0;
}

/**
 * Count how many user turns precede `message` in a chronologically merged view
 * of server + realtime rows. Used to match a realtime row to the correct turn
 * on disk when several turns share identical assistant text.
 *
 * ВАЖНО: считать нужно по массиву, где оптимистичные эхо сообщений человека
 * уже сняты (reconciled realtime из pruneRealtimeSupersededByServer). Сырые
 * realtimeMessages держат queued_/local_ копию каждой отправки рядом с её
 * серверным близнецом — счётчик ходов съезжает, ход на диске не находится, и
 * сверка по ходу молча отключается: короткие живые строки оставались в ленте
 * второй копией (Егор 08.10.26 — «один текст повторяется»).
 */
function getUserTurnOrdinalBefore(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): number {
  const messageTime = readMessageTime(message);
  let userCount = 0;

  for (const candidate of [...serverMessages, ...realtimeMessages].sort(compareMessagesChronologically)) {
    if (candidate.id === message.id) {
      break;
    }

    const candidateTime = readMessageTime(candidate);
    if (
      messageTime !== null
      && candidateTime !== null
      && candidateTime > messageTime
    ) {
      break;
    }

    if (candidate.kind === 'text' && candidate.role === 'user') {
      userCount++;
    }
  }

  return Math.max(0, userCount - 1);
}

function findServerTurnRangeByOrdinal(
  serverMessages: NormalizedMessage[],
  turnOrdinal: number,
): { start: number; end: number } | null {
  let userCount = -1;
  let start = -1;

  for (let index = 0; index < serverMessages.length; index++) {
    const message = serverMessages[index];
    if (message.kind === 'text' && message.role === 'user') {
      userCount++;
      if (userCount === turnOrdinal) {
        start = index;
        break;
      }
    }
  }

  if (start < 0) {
    return null;
  }

  let end = serverMessages.length;
  for (let index = start + 1; index < serverMessages.length; index++) {
    if (serverMessages[index].kind === 'text' && serverMessages[index].role === 'user') {
      end = index;
      break;
    }
  }

  return { start, end };
}

/**
 * Shared body for `isAssistantTextEchoedInSameTurnOnServer` and
 * `isThinkingEchoedInSameTurnOnServer`: locate the same conversational turn
 * on the persisted server transcript and check whether it already carries a
 * row the given `matches` predicate accepts with identical trimmed content.
 */
function isContentEchoedInSameTurnOnServer(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  matches: (serverMessage: NormalizedMessage) => boolean,
): boolean {
  const content = (message.content || '').trim();
  if (!content) {
    return false;
  }

  const turnOrdinal = getUserTurnOrdinalBefore(message, serverMessages, realtimeMessages);
  const turnRange = findServerTurnRangeByOrdinal(serverMessages, turnOrdinal);
  if (!turnRange) {
    return false;
  }

  return serverMessages
    .slice(turnRange.start + 1, turnRange.end)
    .some((serverMessage) => matches(serverMessage) && (serverMessage.content || '').trim() === content);
}

function isAssistantTextEchoedInSameTurnOnServer(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): boolean {
  return isContentEchoedInSameTurnOnServer(
    message,
    serverMessages,
    realtimeMessages,
    (serverMessage) => serverMessage.kind === 'text' && serverMessage.role === 'assistant',
  );
}

/**
 * Живая строка ответа — всегда КУСОК того же ответа, который потом ляжет на
 * диск целиком. Поэтому сравнивать её с записью на диске по полному равенству
 * мало: при обрыве связи строка застывает на половине фразы, и рядом с ней
 * встаёт полный ответ с диска. Именно так 11.09.26 у Егора получилось
 * «с чем сравнивать.» отдельным сообщением, а следом — та же фраза целиком.
 *
 * Здесь кусок признаётся куском: если в этом же ходе на диске есть ответ,
 * внутри которого живая строка содержится, живую строку убираем. Для обычных
 * сохранённых ответов такое правило было бы опасно (короткая реплика могла бы
 * случайно оказаться внутри длинной), поэтому оно применяется ТОЛЬКО к живым
 * строкам потока и только начиная с восьми символов.
 */
function isLiveFragmentOfServerReply(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): boolean {
  const fragment = (message.content || '').trim();
  if (fragment.length < 8) {
    return false;
  }

  const turnOrdinal = getUserTurnOrdinalBefore(message, serverMessages, realtimeMessages);
  const turnRange = findServerTurnRangeByOrdinal(serverMessages, turnOrdinal);
  if (!turnRange) {
    return false;
  }

  return serverMessages
    .slice(turnRange.start + 1, turnRange.end)
    .some((serverMessage) => {
      if (serverMessage.kind !== 'text' || serverMessage.role !== 'assistant') {
        return false;
      }
      const full = (serverMessage.content || '').trim();
      return full.length >= fragment.length && full.includes(fragment);
    });
}

/**
 * Same idea as `isAssistantTextEchoedInSameTurnOnServer`, for a live thinking
 * block instead of the reply text. Persisted `thinking` rows carry no `role`.
 */
function isThinkingEchoedInSameTurnOnServer(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): boolean {
  return isContentEchoedInSameTurnOnServer(
    message,
    serverMessages,
    realtimeMessages,
    (serverMessage) => serverMessage.kind === 'thinking',
  );
}

/**
 * After `finalizeStreaming`, the client holds a synthetic assistant `text` row
 * while the sessions API soon returns the same reply with a different id.
 * Those sit back-to-back in merged order and look like duplicate bubbles until
 * A persisted-tail refresh reconciles realtime. Collapse same-text assistant rows and
 * stream_placeholder → text when content matches.
 */
function dedupeAdjacentAssistantEchoes(merged: NormalizedMessage[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const m of merged) {
    const prev = out[out.length - 1];
    if (prev) {
      if (prev.kind === 'stream_delta' && m.kind === 'text' && m.role === 'assistant') {
        const ps = (prev.content || '').trim();
        const ms = (m.content || '').trim();
        if (ps.length > 0 && ps === ms) {
          out[out.length - 1] = m;
          continue;
        }
      }
      if (prev.kind === 'thinking_delta' && m.kind === 'thinking') {
        const ps = (prev.content || '').trim();
        const ms = (m.content || '').trim();
        if (ps.length > 0 && ps === ms) {
          out[out.length - 1] = m;
          continue;
        }
      }
      if (m.kind === 'text' && m.role === 'assistant') {
        // Сравниваем не с соседом, а с ближайшим предыдущим ответом, пропуская
        // блоки размышлений.
        //
        // Дубль 11.09.26: один и тот же ответ стоял в ленте дважды, а между
        // копиями — «Думал 4 с». Сосед у второй копии был размышлением, и
        // проверка на повтор её не замечала. Разделять копии размышлением
        // естественно: живая строка закрывается и уступает место записи с
        // диска, а блок размышления встаёт между ними по времени.
        //
        // Ложное срабатывание почти исключено: совпасть должен ВЕСЬ текст
        // ответа целиком, а между копиями — только размышления и ничего
        // больше. Настоящий повтор такой формы не имеет.
        //
        // Дополнение того же дня: между копиями оказалось не только
        // размышление, но и вызов команды — «Беру сессию этого разговора» /
        // Bash / «Думал меньше секунды» / та же фраза снова. Пропускаем
        // поэтому и служебные строки вызова тоже: они сами по себе ответом не
        // являются. Планка в двадцать символов оставляет короткие реплики
        // («Готово.», «Да.») в покое — их повтор может быть настоящим.
        const ms = (m.content || '').trim();
        if (ms.length >= 20) {
          let i = out.length - 1;
          while (
            i >= 0
            && (out[i].kind === 'thinking'
              || out[i].kind === 'thinking_delta'
              || out[i].kind === 'tool_use'
              || out[i].kind === 'tool_result')
          ) {
            i -= 1;
          }
          const previousReply = i >= 0 ? out[i] : null;
          if (
            previousReply
            && previousReply.kind === 'text'
            && previousReply.role === 'assistant'
            && ms === (previousReply.content || '').trim()
          ) {
            continue;
          }
        }
      }
      if (prev.kind === 'thinking' && m.kind === 'thinking') {
        const ms = (m.content || '').trim();
        if (ms.length > 0 && ms === (prev.content || '').trim()) {
          continue;
        }
      }
    }
    out.push(m);
  }
  return out;
}

/**
 * After a server refresh, drop only the realtime rows the persisted transcript
 * already owns. Anything not yet on disk (common right after `complete`, while
 * JSONL indexing lags) stays in `realtimeMessages` so the chat pane never
 * flashes the empty "Continue your conversation" state.
 */
export function pruneRealtimeSupersededByServer(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage[] {
  if (realtimeMessages.length === 0) {
    return realtimeMessages;
  }

  const serverIds = new Set(serverMessages.map((message) => message.id));
  const reconciledRealtimeMessages = removeOptimisticUserEchoes(serverMessages, realtimeMessages);

  return reconciledRealtimeMessages.filter((message) => {
    if (serverIds.has(message.id)) {
      return false;
    }

    // Ходовые сверки считают ход по сообщениям человека — им нужен массив
    // realtime УЖЕ без снятых эхо (reconciledRealtimeMessages), иначе каждая
    // отправка считается дважды и ordinal уезжает за конец истории: ход на
    // диске «не найден», короткая живая строка остаётся дублём.
    if (message.kind === 'stream_delta' || message.id === `__streaming_${message.sessionId}`) {
      if (isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, reconciledRealtimeMessages)) {
        return false;
      }
      if (isLiveFragmentOfServerReply(message, serverMessages, reconciledRealtimeMessages)) {
        return false;
      }
      return true;
    }

    if (message.kind === 'thinking_delta' || message.id === `__thinking_${message.sessionId}`) {
      if (isThinkingEchoedInSameTurnOnServer(message, serverMessages, reconciledRealtimeMessages)) {
        return false;
      }
      return true;
    }

    if (message.kind === 'text' && message.role === 'assistant') {
      if (isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, reconciledRealtimeMessages)) {
        return false;
      }
      // Финализированная живая строка (kind уже 'text') — тот же кусок потока,
      // что и stream_delta: при обрыве сокета до stream_end доезжает только
      // часть дельт, и рядом с полным ответом с диска оставался обрубок
      // (сценарий 11.09 «с чем сравнивать.», закрытый раньше только для
      // незакрытой строки).
      if (isLiveFragmentOfServerReply(message, serverMessages, reconciledRealtimeMessages)) {
        return false;
      }
      if (isLongReplyAlreadyOnServer(message, serverMessages)) {
        return false;
      }
      return true;
    }

    if (message.kind === 'thinking') {
      if (isThinkingEchoedInSameTurnOnServer(message, serverMessages, reconciledRealtimeMessages)) {
        return false;
      }
      return true;
    }

    if (message.kind === 'text' && message.role === 'user') {
      return true;
    }

    if (message.kind === 'tool_use' && message.toolId) {
      if (serverMessages.some((serverMessage) => serverMessage.kind === 'tool_use' && serverMessage.toolId === message.toolId)) {
        return false;
      }
    }

    return true;
  });
}

// Открыта наружу нарочно: это единственный шов, на котором проверяется склейка
// ленты. Случаи из снимков Егора 11.09.26 (дубль через вызов команды и
// оборванный кусок фразы) и 08.10.26 (короткие реплики повторялись из-за
// эхо-счётчика ходов) прогоняются через неё напрямую, без браузера.
export function computeMerged(server: NormalizedMessage[], realtime: NormalizedMessage[]): NormalizedMessage[] {
  if (realtime.length === 0) {
    return dedupeAdjacentAssistantEchoes(server);
  }
  if (server.length === 0) {
    return dedupeAdjacentAssistantEchoes(realtime);
  }

  // Сверка ровно одна, общая с обновлением ленты.
  //
  // Раньше здесь стояла своя, урезанная: живая строка выбрасывалась, только
  // если её ОПОЗНАВАТЕЛЬНЫЙ НОМЕР уже встречался среди записей с диска. Но
  // диск заводит ответу собственный номер, поэтому опознать по нему нельзя
  // никогда — и живая копия оставалась. Дальше обе копии раскладывались по
  // времени, между ними вставали вызов команды и блок размышлений, и проверка
  // «повтор стоит вплотную» их уже не видела. Так у Егора 11.09.26 фраза
  // «Лента не та — там нет моих ответов» встала в ленту дважды через Bash.
  //
  // Полная сверка (та же, что применяется при обновлении с сервера) смотрит на
  // содержимое внутри одного хода, а не на номер, и снимает копию независимо
  // от того, что оказалось между ними.
  const extra = pruneRealtimeSupersededByServer(server, realtime);

  if (extra.length === 0) {
    return dedupeAdjacentAssistantEchoes(server);
  }

  // Interleave by timestamp so live rows stay with their turn instead of
  // piling up at the bottom after every refresh.
  return dedupeAdjacentAssistantEchoes(
    [...server, ...extra].sort(compareMessagesChronologically),
  );
}

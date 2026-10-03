/**
 * Очередь сообщений чата: хранение, показ всем устройствам и отправка по
 * концу хода — силами сервера.
 *
 * Егор 20.09.26: «если я запустил размышление и отправил следующее сообщение,
 * оно выложилось только тогда, когда я вошёл в сайт. Оно должно запускаться
 * сразу после того, как закончится настоящее размышление, и остальная очередь
 * тоже — она никак не зависит от моего присутствия».
 *
 * Раньше очередь жила в localStorage вкладки и отправлялась страницей: пока
 * сайт закрыт, отправлять некому. Теперь:
 * - строки лежат в базе (`chat_message_queue`) и переживают перезапуск сайта;
 * - страница только показывает очередь и правит её — источником правды она не
 *   является, поэтому телефон и компьютер видят одно и то же;
 * - по концу каждого хода сервер сам снимает первую строку и заводит запуск,
 *   даже если ни одной вкладки не открыто.
 *
 * Отправитель живёт в chat-websocket.service (там разбор настроек, вложений и
 * доступа к провайдеру); сюда он подставляется через `setQueuedChatMessageRunner`,
 * иначе два модуля ссылались бы друг на друга по кругу.
 */
import { chatMessageQueueDb, sessionsDb, type StoredQueuedChatMessage } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { broadcastRealtimeEvent } from '@/modules/websocket/services/websocket-state.service.js';
import { normalizeAttachmentDescriptors } from '@/shared/image-attachments.js';

/**
 * Что о строке очереди знает страница: текст, вложения и номер. Настройки
 * запуска (модель, права) наружу не отдаём — показывать их негде, а размер
 * рассылки они увеличивают.
 */
export type QueuedChatMessageView = {
  id: string;
  content: string;
  attachments: unknown[];
  createdAt: string;
};

/**
 * Заводит запуск по снятой с очереди строке. Возвращает `false`, если запуск
 * завести не удалось (чат уже работает, исчерпан предел одновременных чатов) —
 * тогда строка возвращается в начало очереди и ждёт следующего освобождения.
 */
export type QueuedChatMessageRunner = (message: StoredQueuedChatMessage) => Promise<boolean>;

let runQueuedMessage: QueuedChatMessageRunner | null = null;
/**
 * Обход очередей идёт по одному: несколько ходов могут закончиться разом.
 *
 * Признак — именно флаг, а не «промис обхода»: пустой обход заканчивается
 * раньше, чем промис успевает записаться в переменную, и та навсегда
 * оставалась занятой — очередь после этого не трогалась вовсе (поймано живым
 * прогоном 20.09.26).
 */
let sweeping = false;
let sweepRequested = false;

/** Вызывается при поднятии websocket-модуля: подставляет настоящего отправителя. */
export function setQueuedChatMessageRunner(runner: QueuedChatMessageRunner): void {
  runQueuedMessage = runner;
}

function toView(message: StoredQueuedChatMessage): QueuedChatMessageView {
  const options = message.options ?? {};
  const attachments = [
    ...normalizeAttachmentDescriptors(options.attachments),
    ...normalizeAttachmentDescriptors(options.images),
    ...normalizeAttachmentDescriptors(options.files),
  ];
  const unique = attachments.filter(
    (descriptor, index, all) => all.findIndex((candidate) => candidate.path === descriptor.path) === index,
  );
  return {
    id: message.id,
    content: message.content,
    attachments: unique,
    createdAt: message.createdAt,
  };
}

/** Очередь чата в том виде, в каком её показывает страница. */
export function listChatQueue(sessionId: string): QueuedChatMessageView[] {
  return chatMessageQueueDb.list(sessionId).map(toView);
}

/**
 * Рассылает очередь ВСЕМ подключённым устройствам, а не только тому, кто её
 * изменил: очередь общая, и на телефоне она должна меняться одновременно с
 * компьютером.
 */
export function broadcastChatQueue(sessionId: string): void {
  const payload = JSON.stringify({
    kind: 'chat_queue',
    sessionId,
    queue: listChatQueue(sessionId),
    timestamp: new Date().toISOString(),
  });
  broadcastRealtimeEvent(payload, sessionsDb.getSessionById(sessionId)?.provider);
}

/** Ставит сообщение в конец очереди и рассылает новый вид очереди. */
export function queueChatMessage(message: Omit<StoredQueuedChatMessage, 'createdAt'>): QueuedChatMessageView[] {
  chatMessageQueueDb.append(message);
  const queue = listChatQueue(message.sessionId);
  broadcastChatQueue(message.sessionId);
  return queue;
}

export function removeChatQueueItem(sessionId: string, id: string): void {
  chatMessageQueueDb.remove(sessionId, id);
  broadcastChatQueue(sessionId);
}

export function clearChatQueue(sessionId: string): void {
  chatMessageQueueDb.clear(sessionId);
  broadcastChatQueue(sessionId);
}

export function reorderChatQueue(sessionId: string, orderedIds: string[]): void {
  chatMessageQueueDb.reorder(sessionId, orderedIds);
  broadcastChatQueue(sessionId);
}

async function dispatchSession(sessionId: string): Promise<void> {
  const runner = runQueuedMessage;
  if (!runner) {
    return;
  }
  // Пока чат занят — ничего не снимаем. `isProcessing` учитывает и агентов,
  // переживших перезапуск сайта: их ход ещё идёт, хотя запуска в памяти нет.
  if (chatRunRegistry.isProcessing(sessionId)) {
    return;
  }

  const next = chatMessageQueueDb.takeFirst(sessionId);
  if (!next) {
    return;
  }
  broadcastChatQueue(sessionId);

  let started = false;
  try {
    started = await runner(next);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Очередь чата] не удалось отправить сообщение из очереди', { sessionId, error: message });
  }

  if (started) {
    return;
  }

  // Запуск не завёлся — возвращаем строку на место и ждём следующего
  // освобождения, иначе сообщение человека просто исчезло бы.
  chatMessageQueueDb.pushFront(next);
  broadcastChatQueue(sessionId);
}

/**
 * Обходит очереди и отправляет первое сообщение каждого свободного чата.
 *
 * Обходим ВСЕ чаты с очередью, а не только тот, чей ход закончился: сообщение
 * могло ждать не своего хода, а свободного места (предел одновременных чатов),
 * и освободилось оно именно сейчас.
 */
export function dispatchChatQueues(): void {
  sweepRequested = true;
  if (sweeping) {
    return;
  }
  sweeping = true;

  void (async () => {
    try {
      while (sweepRequested) {
        sweepRequested = false;
        for (const sessionId of chatMessageQueueDb.sessionsWithQueue()) {
          await dispatchSession(sessionId);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Очередь чата] обход очередей прервался', message);
    } finally {
      sweeping = false;
    }
  })();
}

/**
 * Страховка: обход очередей раз в минуту.
 *
 * Конец хода — основной сигнал, но он может не прийти (агент пережил
 * перезапуск сайта, запуск оборвался нештатно). Сообщение человека не должно
 * зависеть от того, случился ли ровно один нужный сигнал: раз в минуту сервер
 * сам смотрит, не освободился ли чат с очередью. Цена — один короткий запрос
 * к маленькой таблице.
 */
const QUEUE_SWEEP_INTERVAL_MS = 60_000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startChatQueueHeartbeat(): void {
  if (sweepTimer) {
    return;
  }
  sweepTimer = setInterval(() => {
    dispatchChatQueues();
  }, QUEUE_SWEEP_INTERVAL_MS);
  // Держать процесс живым ради обхода очередей не нужно.
  sweepTimer.unref?.();
}

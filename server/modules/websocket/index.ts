export { WS_OPEN_STATE, connectedClients } from './services/websocket-state.service.js';
export { createWebSocketServer } from './services/websocket-server.service.js';
export { chatRunRegistry } from './services/chat-run-registry.service.js';
// dispatchChatQueues: серверная очередь сообщений чата — вызывается из server/index.ts,
// когда закончил агент, переживший перезапуск сайта (своего конца хода у него нет).
export { dispatchChatQueues } from './services/chat-queue.service.js';
// listChatQueue / clearChatQueue: возврат к сообщению (providers/session-rewind.service)
// снимает очередь чата, чтобы конец остановленного хода не отправил её поверх обрезки.
export { clearChatQueue, listChatQueue } from './services/chat-queue.service.js';

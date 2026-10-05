import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { fullDevinConversation } from './devin-chain.js';

type TestDb = InstanceType<typeof Database>;

function createDb(): TestDb {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, main_chain_id INTEGER);
    CREATE TABLE message_nodes (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      node_id INTEGER NOT NULL,
      parent_node_id INTEGER,
      chat_message TEXT NOT NULL,
      created_at INTEGER
    );
  `);
  return db;
}

function message(messageId: string, role: string, content: string, atMs: number): string {
  return JSON.stringify({
    message_id: messageId,
    role,
    content,
    metadata: { created_at: new Date(atMs).toISOString() },
  });
}

function insertNode(
  db: TestDb,
  sessionId: string,
  nodeId: number,
  parentId: number | null,
  chatMessage: string,
): void {
  db.prepare(
    'INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(sessionId, nodeId, parentId, chatMessage, 0);
}

function keysOf(db: TestDb, sessionId: string): string[] {
  return fullDevinConversation(db, sessionId).map(
    (row) => JSON.parse(row.chatMessage).message_id as string,
  );
}

/**
 * Лес, как у реальной сессии Devin: старый ствол (выключенные из контекста
 * ходы), пересобранный контекст с копиями последних ходов, отрезанная
 * rewind'ом ветка и служебная ветка суммаризатора.
 */
function seedForest(db: TestDb): void {
  const s = 's1';
  // Ствол: ходы 1–2 (живая цепочка давно ушла дальше).
  insertNode(db, s, 1, null, message('u1', 'user', 'вопрос 1', 1000));
  insertNode(db, s, 2, 1, message('a1', 'assistant', 'ответ 1', 2000));
  insertNode(db, s, 3, 2, message('u2', 'user', 'вопрос 2', 3000));
  insertNode(db, s, 4, 3, message('a2', 'assistant', 'ответ 2', 4000));
  // Пересобранный контекст: системный узел + копии хода 2 + ход 3.
  insertNode(db, s, 5, null, message('sys1', 'system', 'контекст', 4100));
  insertNode(db, s, 6, 5, message('u2', 'user', 'вопрос 2', 3000));
  insertNode(db, s, 7, 6, message('a2', 'assistant', 'ответ 2', 4000));
  insertNode(db, s, 8, 7, message('u3', 'user', 'вопрос 3', 5000));
  insertNode(db, s, 9, 8, message('a3', 'assistant', 'ответ 3', 6000));
  // Ветка, отрезанная rewind'ом (брошенный ход).
  insertNode(db, s, 10, 9, message('u-bad', 'user', 'отменённый вопрос', 7000));
  insertNode(db, s, 11, 10, message('a-bad', 'assistant', 'отменённый ответ', 8000));
  // Новая живая цепочка: системный узел + копии хода 3 + ход 4.
  insertNode(db, s, 12, null, message('sys2', 'system', 'контекст', 8100));
  insertNode(db, s, 13, 12, message('u3', 'user', 'вопрос 3', 5000));
  insertNode(db, s, 14, 13, message('a3', 'assistant', 'ответ 3', 6000));
  insertNode(db, s, 15, 14, message('u4', 'user', 'вопрос 4', 9000));
  insertNode(db, s, 16, 15, message('a4', 'assistant', 'ответ 4', 10000));
  // Служебная ветка суммаризатора — ни к чему не привязана.
  insertNode(db, s, 17, null, message('sum-u', 'user', 'Conversation to summarize: …', 11000));
  insertNode(db, s, 18, 17, message('sum-a', 'assistant', '## 1. Request and Intent', 12000));

  db.prepare('INSERT INTO sessions (id, main_chain_id) VALUES (?, ?)').run(s, 16);
}

test('возвращает вытесненные из контекста ходы и живую цепочку', () => {
  const db = createDb();
  seedForest(db);
  const keys = keysOf(db, 's1');
  for (const key of ['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4']) {
    assert.ok(keys.includes(key), `ожидали ${key}`);
  }
});

test('отрезанная rewind ветка и суммаризатор в историю не попадают', () => {
  const db = createDb();
  seedForest(db);
  const keys = keysOf(db, 's1');
  for (const key of ['u-bad', 'a-bad', 'sum-u', 'sum-a']) {
    assert.ok(!keys.includes(key), `не должно быть ${key}`);
  }
});

test('копии одного message_id сходятся в одну запись — самую свежую по row_id', () => {
  const db = createDb();
  seedForest(db);
  const rows = fullDevinConversation(db, 's1').filter(
    (row) => JSON.parse(row.chatMessage).message_id === 'u2',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].nodeId, 6);
});

test('порядок — по metadata.created_at сообщения', () => {
  const db = createDb();
  seedForest(db);
  assert.deepEqual(keysOf(db, 's1'), [
    'u1', 'a1', 'u2', 'a2', 'sys1', 'u3', 'a3', 'sys2', 'u4', 'a4',
  ]);
});

test('последний ход листом под протоколом: отвечен — входит, откачен — нет', () => {
  // Ход человека в ACP-сессиях живёт отдельной веткой «протокол → ввод», в
  // живую цепочку не входит. Если работа после него есть — ход настоящий.
  const db = createDb();
  insertNode(db, 's2', 1, null, message('p', 'system', 'протокол', 1000));
  insertNode(db, 's2', 2, 1, message('u', 'user', 'последний вопрос', 2000));
  insertNode(db, 's2', 3, null, message('s', 'system', 'контекст', 1500));
  insertNode(db, 's2', 4, 3, message('w', 'tool', 'работа над вопросом', 3000));
  db.prepare('INSERT INTO sessions (id, main_chain_id) VALUES (?, ?)').run('s2', 4);
  assert.deepEqual(keysOf(db, 's2').sort(), ['p', 's', 'u', 'w'].sort());

  // Тот же лист, но живая цепочка заканчивается до него — откат без ответа.
  const db2 = createDb();
  insertNode(db2, 's3', 1, null, message('p', 'system', 'протокол', 1000));
  insertNode(db2, 's3', 2, 1, message('u', 'user', 'отменённый вопрос', 4000));
  insertNode(db2, 's3', 3, null, message('s', 'system', 'контекст', 1500));
  insertNode(db2, 's3', 4, 3, message('w', 'tool', 'старая работа', 3000));
  db2.prepare('INSERT INTO sessions (id, main_chain_id) VALUES (?, ?)').run('s3', 4);
  assert.ok(!keysOf(db2, 's3').includes('u'));
});

test('вершина-указатель на ветку суммаризатора её не воскрешает', () => {
  const db = createDb();
  seedForest(db);
  db.prepare('UPDATE sessions SET main_chain_id = 18 WHERE id = ?').run('s1');
  const keys = keysOf(db, 's1');
  assert.ok(!keys.includes('sum-u'));
  assert.ok(!keys.includes('sum-a'));
  assert.ok(keys.includes('u1'));
});

test('пустая база — пустая история', () => {
  const db = createDb();
  assert.deepEqual(fullDevinConversation(db, 'missing'), []);
});

/**
 * Возврат к сообщению в чате Devin: живая ветка разговора у Devin — указатель
 * `sessions.main_chain_id`, возврат — его перенос на родителя выбранной
 * реплики. Ничего не удаляется: прошлый конец и отцепленные узлы пишутся в
 * файл копии, сами узлы остаются в базе брошенной веткой.
 *
 * Проверяем на настоящей sessions.db во временной папке: указатель встаёт на
 * родителя выбранной реплики, хвост пропадает из живой цепочки, но узлы
 * остаются, копия пишется, очередь снимается, повторное нажатие отдаёт тот же
 * текст. Заодно — экспорт беседы для «Продолжить в новом чате».
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { chatMessageQueueDb, closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { exportDevinTranscript } from '@/modules/providers/index.js';
import { sessionRewindService } from '@/modules/providers/services/session-rewind.service.js';

const APP_SESSION_ID = 'devin-sess-1';
const PROVIDER_SESSION_ID = 'devin-sess-1';
const PROJECT_PATH = '/workspace/devin-rewind';

function node(id: number, parent: number | null, chatMessage: object, createdAt = 1_800_000_000 + id) {
  return { id, parent, chatMessage: JSON.stringify(chatMessage), createdAt };
}

function userNode(id: number, parent: number | null, text: string) {
  return node(id, parent, {
    message_id: `msg-${id}`,
    role: 'user',
    content: text,
    metadata: { is_user_input: true, created_at: '2026-10-04T12:00:00Z' },
  });
}

function assistantNode(id: number, parent: number | null, text: string, toolCalls: object[] = []) {
  return node(id, parent, {
    message_id: `msg-${id}`,
    role: 'assistant',
    content: text,
    tool_calls: toolCalls,
    metadata: { created_at: '2026-10-04T12:00:00Z' },
  });
}

function seedDevinDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, main_chain_id INTEGER);
    CREATE TABLE message_nodes (
      node_id INTEGER PRIMARY KEY,
      session_id TEXT,
      parent_node_id INTEGER,
      chat_message TEXT,
      created_at INTEGER
    );
  `);
  const nodes = [
    node(1, null, { message_id: 'm1', role: 'system', content: 'system prompt' }),
    userNode(2, 1, 'Сделай отчёт'),
    assistantNode(3, 2, 'Готово'),
    userNode(4, 3, 'Теперь  всем\nразошли'),
    assistantNode(5, 4, 'Разослал'),
    userNode(6, 5, 'Спасибо'),
  ];
  const insert = db.prepare(
    'INSERT INTO message_nodes (node_id, session_id, parent_node_id, chat_message, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const item of nodes) {
    insert.run(item.id, PROVIDER_SESSION_ID, item.parent, item.chatMessage, item.createdAt);
  }
  db.prepare('INSERT INTO sessions (id, main_chain_id) VALUES (?, ?)').run(PROVIDER_SESSION_ID, 6);
  db.close();
}

function liveUserTexts(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const { main_chain_id: tip } = db
      .prepare('SELECT main_chain_id FROM sessions WHERE id = ?')
      .get(PROVIDER_SESSION_ID) as { main_chain_id: number | null };
    const texts: string[] = [];
    let at = tip;
    while (at !== null) {
      const row = db
        .prepare('SELECT parent_node_id, chat_message FROM message_nodes WHERE node_id = ?')
        .get(at) as { parent_node_id: number | null; chat_message: string } | undefined;
      if (!row) break;
      const message = JSON.parse(row.chat_message);
      if (message.role === 'user' && message.metadata?.is_user_input === true) {
        texts.unshift(message.content);
      }
      at = row.parent_node_id;
    }
    return texts;
  } finally {
    db.close();
  }
}

async function withFixture(run: (dir: string, devinDbPath: string) => Promise<void>): Promise<void> {
  const previousDbPath = process.env.DATABASE_PATH;
  const previousXdg = process.env.XDG_DATA_HOME;
  const previousRunsDir = process.env.CLOUDCLI_DEVIN_RUNS_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), 'devin-rewind-'));
  const devinDbDir = path.join(dir, 'xdg', 'devin', 'cli');
  await mkdir(devinDbDir, { recursive: true });
  const devinDbPath = path.join(devinDbDir, 'sessions.db');
  seedDevinDb(devinDbPath);

  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  process.env.XDG_DATA_HOME = path.join(dir, 'xdg');
  process.env.CLOUDCLI_DEVIN_RUNS_DIR = path.join(dir, 'devin-runs');
  await initializeDatabase();
  try {
    sessionsDb.createSession(PROVIDER_SESSION_ID, 'devin', PROJECT_PATH);
    await run(dir, devinDbPath);
  } finally {
    closeConnection();
    if (previousDbPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDbPath;
    if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdg;
    if (previousRunsDir === undefined) delete process.env.CLOUDCLI_DEVIN_RUNS_DIR;
    else process.env.CLOUDCLI_DEVIN_RUNS_DIR = previousRunsDir;
    await rm(dir, { recursive: true, force: true });
  }
}

test('по номеру узла: живой конец встаёт на родителя реплики, хвост остаётся в базе', async () => {
  await withFixture(async (dir, devinDbPath) => {
    const result = await sessionRewindService.rewind({
      sessionId: APP_SESSION_ID,
      messageId: 'devin_4',
      text: null,
    });

    assert.equal(result.text, 'Теперь  всем\nразошли');
    assert.equal(result.removedLines, 3, 'отцеплены сама реплика, ответ и следующая реплика');
    assert.deepEqual(liveUserTexts(devinDbPath), ['Сделай отчёт'], 'в беседе осталось только первое сообщение');

    const backup = JSON.parse(await readFile(result.backupPath, 'utf8'));
    assert.equal(backup.previousTip, 6);
    assert.equal(backup.targetNodeId, 4);
    assert.deepEqual(backup.removedNodeIds, [6, 5, 4]);
    assert.equal(
      (await readdir(path.join(dir, 'devin-runs', 'rewind'))).length,
      1,
      'копия лежит в папке возвратов',
    );

    // Узлы не удалены: ветка остаётся в таблице, как у собственного /revert Devin.
    const db = new Database(devinDbPath, { readonly: true });
    try {
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM message_nodes').get() as { n: number }).n, 6);
    } finally {
      db.close();
    }
  });
});

test('по тексту (свежее сообщение без номера узла)', async () => {
  await withFixture(async (_dir, devinDbPath) => {
    const result = await sessionRewindService.rewind({
      sessionId: APP_SESSION_ID,
      messageId: 'local-echo-1',
      text: 'Теперь всем разошли ',
    });
    assert.equal(result.removedLines, 3);
    assert.deepEqual(liveUserTexts(devinDbPath), ['Сделай отчёт']);
  });
});

test('не найдено — указатель и копии не трогаются', async () => {
  await withFixture(async (dir, devinDbPath) => {
    await assert.rejects(
      sessionRewindService.rewind({ sessionId: APP_SESSION_ID, messageId: null, text: 'такого не было' }),
      /Не нашёл это сообщение/,
    );
    const db = new Database(devinDbPath, { readonly: true });
    try {
      assert.equal((db.prepare('SELECT main_chain_id FROM sessions WHERE id = ?').get(PROVIDER_SESSION_ID) as { main_chain_id: number }).main_chain_id, 6);
    } finally {
      db.close();
    }
    await assert.rejects(readdir(path.join(dir, 'devin-runs', 'rewind')));
  });
});

test('очередь снимается, её тексты возвращаются; повтор отдаёт тот же текст', async () => {
  await withFixture(async () => {
    chatMessageQueueDb.append({ id: 'q1', sessionId: APP_SESSION_ID, userId: null, content: 'и ещё вот это', options: {} });
    const first = await sessionRewindService.rewind({
      sessionId: APP_SESSION_ID,
      messageId: 'devin_4',
      text: null,
    });
    assert.deepEqual(first.queuedTexts, ['и ещё вот это']);
    assert.equal(chatMessageQueueDb.list(APP_SESSION_ID).length, 0);

    const again = await sessionRewindService.rewind({
      sessionId: APP_SESSION_ID,
      messageId: 'devin_4',
      text: null,
    });
    assert.equal(again.text, 'Теперь  всем\nразошли');
    assert.deepEqual(again.queuedTexts, ['и ещё вот это']);
    assert.equal(again.removedLines, 0);
    assert.equal(again.backupPath, first.backupPath);
  });
});

test('экспорт беседы: записи в форме переписки — type, sessionId, content', async () => {
  await withFixture(async (dir) => {
    const outPath = path.join(dir, 'export.jsonl');
    const written = await exportDevinTranscript(PROVIDER_SESSION_ID, outPath);
    assert.equal(written, 5, 'три реплики и два ответа; служебные узлы не выгружаются');

    // Форма, которую ждёт дайджест «Продолжить в новом чате» (handoff-digest):
    // type user/assistant, sessionId беседы, message.content строкой или блоками.
    const records = (await readFile(outPath, 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map((r) => r.type),
      ['user', 'assistant', 'user', 'assistant', 'user'],
    );
    assert.ok(records.every((r) => r.sessionId === PROVIDER_SESSION_ID));
    assert.equal(records[0].message.content, 'Сделай отчёт');
    assert.deepEqual(records[1].message.content, [{ type: 'text', text: 'Готово' }]);
  });
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { DevinSessionSynchronizer } from '@/modules/providers/list/devin/devin-session-synchronizer.provider.js';

/**
 * Isolates the sqlite session store (DATABASE_PATH) and the fake Devin data
 * dir (`XDG_DATA_HOME/devin/cli/sessions.db`) the synchronizer reads, so the
 * tests never touch the real machine's Devin history. `CLAUDE_CONFIG_DIR`
 * gets a temp dir too — indexed rows are stamped with it as the machine
 * account dir.
 */
async function withIsolatedStores(
  runTest: (devinDbPath: string) => Promise<void>,
): Promise<void> {
  const previousXdg = process.env.XDG_DATA_HOME;
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const previousDatabasePath = process.env.DATABASE_PATH;
  const xdgHome = await mkdtemp(path.join(os.tmpdir(), 'devin-sync-xdg-'));
  const claudeHome = await mkdtemp(path.join(os.tmpdir(), 'devin-sync-claude-'));
  const dbDir = await mkdtemp(path.join(os.tmpdir(), 'devin-sync-db-'));

  closeConnection();
  process.env.XDG_DATA_HOME = xdgHome;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.DATABASE_PATH = path.join(dbDir, 'auth.db');
  await initializeDatabase();

  const devinDbDir = path.join(xdgHome, 'devin', 'cli');
  await mkdir(devinDbDir, { recursive: true });
  const devinDbPath = path.join(devinDbDir, 'sessions.db');

  try {
    await runTest(devinDbPath);
  } finally {
    closeConnection();
    if (previousXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdg;
    }
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(xdgHome, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
}

type DevinRow = {
  id: string;
  working_directory?: string;
  title?: string | null;
  created_at?: number;
  last_activity_at?: number;
  hidden?: number;
};

/** Writes the columns the synchronizer's SELECT reads, no more. */
function writeDevinDb(devinDbPath: string, rows: DevinRow[]): void {
  const db = new Database(devinDbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        working_directory TEXT,
        title TEXT,
        created_at INTEGER,
        last_activity_at INTEGER,
        hidden INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS message_nodes (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        node_id INTEGER NOT NULL,
        parent_node_id INTEGER,
        chat_message TEXT NOT NULL,
        created_at INTEGER
      );
      DELETE FROM sessions;
    `);
    const insert = db.prepare(
      `INSERT INTO sessions (id, working_directory, title, created_at, last_activity_at, hidden)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      insert.run(
        row.id,
        row.working_directory ?? '/tmp/project',
        row.title ?? null,
        row.created_at ?? 1_700_000_000,
        row.last_activity_at ?? row.created_at ?? 1_700_000_000,
        row.hidden ?? 0,
      );
    }
  } finally {
    db.close();
  }
}

/** Appends user messages to a session's node forest the way Devin stores them. */
function addUserMessages(devinDbPath: string, sessionId: string, contents: string[]): void {
  const db = new Database(devinDbPath);
  try {
    const insert = db.prepare(
      `INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
       VALUES (?, ?, NULL, ?, ?)`,
    );
    for (const content of contents) {
      const nodeId = (db.prepare(
        'SELECT COALESCE(MAX(node_id), -1) + 1 AS next FROM message_nodes WHERE session_id = ?',
      ).get(sessionId) as { next: number }).next;
      insert.run(sessionId, nodeId, JSON.stringify({ role: 'user', content }), 1_700_000_000);
    }
  } finally {
    db.close();
  }
}

/** Two real user messages — the threshold at which a generated title may land. */
function seedTwoTurns(devinDbPath: string, sessionId: string, firstPrompt = 'Расскажи про очередь сообщений'): void {
  addUserMessages(devinDbPath, sessionId, [firstPrompt, 'А подробнее про ретраи?']);
}

test('generated Devin title lands as the session name with ai provenance', async () => {
  await withIsolatedStores(async (devinDbPath) => {
    writeDevinDb(devinDbPath, [
      { id: 'dev-sess-1', title: 'Разбор очереди доставки сообщений' },
    ]);
    seedTwoTurns(devinDbPath, 'dev-sess-1');

    const synchronizer = new DevinSessionSynchronizer();
    assert.equal(await synchronizer.synchronize(), 1);

    const session = sessionsDb.getSessionById('dev-sess-1');
    assert.equal(session?.custom_name, 'Разбор очереди доставки сообщений');
    assert.equal(session?.title_source, 'ai');
  });
});

test('a single-message chat keeps the prompt-derived name until the topic develops', async () => {
  await withIsolatedStores(async (devinDbPath) => {
    const appSession = sessionsDb.createAppSession(
      'app-session-early',
      'devin',
      '/tmp/project',
      'Смотри, сейчас твоя задача',
    );
    sessionsDb.assignProviderSessionId(appSession, 'dev-sess-early');

    writeDevinDb(devinDbPath, [
      { id: 'dev-sess-early', title: 'Анализ лучших ИИ-моделей для видео' },
    ]);
    addUserMessages(devinDbPath, 'dev-sess-early', ['Смотри, сейчас твоя задача — сравни модели']);

    const synchronizer = new DevinSessionSynchronizer();
    await synchronizer.synchronize();

    let session = sessionsDb.getSessionById(appSession);
    assert.equal(session?.custom_name, 'Смотри, сейчас твоя задача');
    assert.equal(session?.title_source, 'naive');

    // The second user message gives the generated title enough context —
    // the next sync pass promotes it once.
    addUserMessages(devinDbPath, 'dev-sess-early', ['А какие из них умеют в 4k?']);
    await synchronizer.synchronize();

    session = sessionsDb.getSessionById(appSession);
    assert.equal(session?.custom_name, 'Анализ лучших ИИ-моделей для видео');
    assert.equal(session?.title_source, 'ai');
  });
});

test('generated title replaces the naive first-words name of a web-created chat', async () => {
  await withIsolatedStores(async (devinDbPath) => {
    // What the sidebar does today: the app session row exists first, named
    // from the opening words of the first message.
    const appSession = sessionsDb.createAppSession(
      'app-session-uuid',
      'devin',
      '/tmp/project',
      'Смотри, сейчас твоя задача',
    );
    sessionsDb.assignProviderSessionId(appSession, 'dev-sess-2');

    writeDevinDb(devinDbPath, [
      { id: 'dev-sess-2', title: 'Анализ лучших ИИ-моделей для видео' },
    ]);
    seedTwoTurns(devinDbPath, 'dev-sess-2');

    const synchronizer = new DevinSessionSynchronizer();
    assert.equal(await synchronizer.synchronize(), 1);

    const session = sessionsDb.getSessionById(appSession);
    assert.equal(session?.custom_name, 'Анализ лучших ИИ-моделей для видео');
    assert.equal(session?.title_source, 'ai');
  });
});

test('a manual rename is never overwritten by a generated title', async () => {
  await withIsolatedStores(async (devinDbPath) => {
    const appSession = sessionsDb.createAppSession(
      'app-session-rename',
      'devin',
      '/tmp/project',
      'Смотри, сейчас твоя задача',
    );
    sessionsDb.assignProviderSessionId(appSession, 'dev-sess-3');
    sessionsDb.renameSessionByUser(appSession, 'Мой разбор квартала');

    writeDevinDb(devinDbPath, [
      { id: 'dev-sess-3', title: 'Анализ лучших ИИ-моделей для видео' },
    ]);

    const synchronizer = new DevinSessionSynchronizer();
    await synchronizer.synchronize();

    const session = sessionsDb.getSessionById(appSession);
    assert.equal(session?.custom_name, 'Мой разбор квартала');
    assert.equal(session?.title_source, 'custom');
  });
});

test('serialized tool-call titles do not replace the prompt-derived name', async () => {
  await withIsolatedStores(async (devinDbPath) => {
    const appSession = sessionsDb.createAppSession(
      'app-session-tool',
      'devin',
      '/tmp/project',
      'Сделай так чтобы работало',
    );
    sessionsDb.assignProviderSessionId(appSession, 'dev-sess-4');

    writeDevinDb(devinDbPath, [
      { id: 'dev-sess-4', title: 'functions.read_file:0{"file_path": "/home/claude/.cloudcli/assets/u1/img.png"}' },
    ]);

    const synchronizer = new DevinSessionSynchronizer();
    await synchronizer.synchronize();

    const session = sessionsDb.getSessionById(appSession);
    assert.equal(session?.custom_name, 'Сделай так чтобы работало');
    assert.equal(session?.title_source, 'naive');
  });
});

test('a title that merely echoes the first prompt is not promoted', async () => {
  await withIsolatedStores(async (devinDbPath) => {
    const appSession = sessionsDb.createAppSession(
      'app-session-echo',
      'devin',
      '/tmp/project',
      'Отвечай ТОЛЬКО JSON-объектом',
    );
    sessionsDb.assignProviderSessionId(appSession, 'dev-sess-echo');

    writeDevinDb(devinDbPath, [
      // Devin sometimes stores the prompt's own opening words as `title`.
      { id: 'dev-sess-echo', title: 'Отвечай ТОЛЬКО JSON-объектом по запрошенной схеме' },
    ]);
    addUserMessages(devinDbPath, 'dev-sess-echo', [
      'Отвечай ТОЛЬКО JSON-объектом по запрошенной схеме — без markdown-обёрток',
      'И ещё одна порция данных',
    ]);

    const synchronizer = new DevinSessionSynchronizer();
    await synchronizer.synchronize();

    const session = sessionsDb.getSessionById(appSession);
    assert.equal(session?.custom_name, 'Отвечай ТОЛЬКО JSON-объектом');
    assert.equal(session?.title_source, 'naive');
  });
});

test('once a generated title landed, the chat is never renamed again', async () => {
  await withIsolatedStores(async (devinDbPath) => {
    writeDevinDb(devinDbPath, [
      { id: 'dev-sess-5', title: 'Первое название' },
    ]);
    seedTwoTurns(devinDbPath, 'dev-sess-5');

    const synchronizer = new DevinSessionSynchronizer();
    await synchronizer.synchronize();
    assert.equal(sessionsDb.getSessionById('dev-sess-5')?.custom_name, 'Первое название');
    assert.equal(sessionsDb.getSessionById('dev-sess-5')?.title_source, 'ai');

    // Devin keeps evolving its own title — the sidebar must stay put.
    writeDevinDb(devinDbPath, [
      { id: 'dev-sess-5', title: 'Совсем другое название' },
    ]);
    await synchronizer.synchronize();

    const session = sessionsDb.getSessionById('dev-sess-5');
    assert.equal(session?.custom_name, 'Первое название');
    assert.equal(session?.title_source, 'ai');
  });
});

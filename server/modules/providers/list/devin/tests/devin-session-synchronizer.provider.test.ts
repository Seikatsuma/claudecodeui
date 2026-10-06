import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { DEVIN_MODEL_CWD } from '@/modules/providers/list/devin/devin-model.js';
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

/** Synchronizer whose name-writing model is a stub; zero retry delay so tests can replay passes. */
function testSynchronizer(ask: (prompt: string) => Promise<string>): {
  synchronizer: DevinSessionSynchronizer;
  calls: string[];
} {
  const calls: string[] = [];
  const synchronizer = new DevinSessionSynchronizer(
    async (prompt: string) => {
      calls.push(prompt);
      return ask(prompt);
    },
    { titleRetryMs: 0, titleMaxAttempts: 2 },
  );
  return { synchronizer, calls };
}

test('generated name lands as the session name with ai provenance, built from chat content', async () => {
  await withIsolatedStores(async (devinDbPath) => {
    writeDevinDb(devinDbPath, [
      { id: 'dev-sess-1', title: 'Разбор очереди доставки сообщений в деталях реализации' },
    ]);
    seedTwoTurns(devinDbPath, 'dev-sess-1');

    const { synchronizer, calls } = testSynchronizer(async () => 'Очередь доставки — ретраи');
    assert.equal(await synchronizer.synchronize(), 1);
    await synchronizer.drainTitleJobs();

    const session = sessionsDb.getSessionById('dev-sess-1');
    assert.equal(session?.custom_name, 'Очередь доставки — ретраи');
    assert.equal(session?.title_source, 'ai');
    // The model saw both the CLI draft and the chat's own words.
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? '', /очеред[а-я]+ доставки/i);
    assert.match(calls[0] ?? '', /очередь сообщений/i);
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

    const { synchronizer, calls } = testSynchronizer(async () => 'ИИ-модели видео 4K');
    await synchronizer.synchronize();
    await synchronizer.drainTitleJobs();

    let session = sessionsDb.getSessionById(appSession);
    assert.equal(session?.custom_name, 'Смотри, сейчас твоя задача');
    assert.equal(session?.title_source, 'naive');
    assert.equal(calls.length, 0);

    // The second user message gives the generated name enough context —
    // the next sync pass promotes it once.
    addUserMessages(devinDbPath, 'dev-sess-early', ['А какие из них умеют в 4k?']);
    await synchronizer.synchronize();
    await synchronizer.drainTitleJobs();

    session = sessionsDb.getSessionById(appSession);
    assert.equal(session?.custom_name, 'ИИ-модели видео 4K');
    assert.equal(session?.title_source, 'ai');
    assert.equal(calls.length, 1);
  });
});

test('generated name replaces the naive first-words name of a web-created chat', async () => {
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

    const { synchronizer } = testSynchronizer(async () => 'ИИ-модели видео 4K');
    assert.equal(await synchronizer.synchronize(), 1);
    await synchronizer.drainTitleJobs();

    const session = sessionsDb.getSessionById(appSession);
    assert.equal(session?.custom_name, 'ИИ-модели видео 4K');
    assert.equal(session?.title_source, 'ai');
  });
});

test('a manual rename is never overwritten and never even asks the model', async () => {
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
    seedTwoTurns(devinDbPath, 'dev-sess-3');

    const { synchronizer, calls } = testSynchronizer(async () => 'ИИ-модели видео 4K');
    await synchronizer.synchronize();
    await synchronizer.drainTitleJobs();

    const session = sessionsDb.getSessionById(appSession);
    assert.equal(session?.custom_name, 'Мой разбор квартала');
    assert.equal(session?.title_source, 'custom');
    assert.equal(calls.length, 0);
  });
});

test('serialized tool-call titles never surface — the naive name stays without messages', async () => {
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

    const { synchronizer, calls } = testSynchronizer(async () => 'Сгенерированное имя');
    await synchronizer.synchronize();
    await synchronizer.drainTitleJobs();

    const session = sessionsDb.getSessionById(appSession);
    assert.equal(session?.custom_name, 'Сделай так чтобы работало');
    assert.equal(session?.title_source, 'naive');
    assert.equal(calls.length, 0);
  });
});

test('a junk CLI title does not block the generated name once the chat has context', async () => {
  await withIsolatedStores(async (devinDbPath) => {
    const appSession = sessionsDb.createAppSession(
      'app-session-mixed',
      'devin',
      '/tmp/project',
      'Сделай кнопку показать ещё чаты',
    );
    sessionsDb.assignProviderSessionId(appSession, 'dev-sess-mixed');

    writeDevinDb(devinDbPath, [
      // Devin's title can start with real assistant text and still end in a
      // serialized call — the whole string is junk either way.
      { id: 'dev-sess-mixed', title: 'I need to look at the image you sent.functions.ReadImage:0{"uri": "/x"}' },
    ]);
    seedTwoTurns(devinDbPath, 'dev-sess-mixed');

    const { synchronizer, calls } = testSynchronizer(async () => 'Кнопка «показать ещё чаты»');
    await synchronizer.synchronize();
    await synchronizer.drainTitleJobs();

    const session = sessionsDb.getSessionById(appSession);
    // Junk is not shown and not passed to the model as a draft, but the chat
    // still gets its real name — from the messages themselves.
    assert.equal(session?.custom_name, 'Кнопка «показать ещё чаты»');
    assert.equal(session?.title_source, 'ai');
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0] ?? '', /functions\.ReadImage/);
  });
});

test('a generated name echoing the first prompt is rejected, keeping the row open', async () => {
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

    const { synchronizer } = testSynchronizer(
      async () => 'Отвечай ТОЛЬКО JSON-объектом по запрошенной схеме',
    );
    await synchronizer.synchronize();
    await synchronizer.drainTitleJobs();

    const session = sessionsDb.getSessionById(appSession);
    assert.equal(session?.custom_name, 'Отвечай ТОЛЬКО JSON-объектом');
    assert.equal(session?.title_source, 'naive');
  });
});

test('once a generated name landed, the chat is never renamed again', async () => {
  await withIsolatedStores(async (devinDbPath) => {
    writeDevinDb(devinDbPath, [
      { id: 'dev-sess-5', title: 'Первое название' },
    ]);
    seedTwoTurns(devinDbPath, 'dev-sess-5');

    const { synchronizer, calls } = testSynchronizer(async () => 'Первое название');
    await synchronizer.synchronize();
    await synchronizer.drainTitleJobs();
    assert.equal(sessionsDb.getSessionById('dev-sess-5')?.custom_name, 'Первое название');
    assert.equal(sessionsDb.getSessionById('dev-sess-5')?.title_source, 'ai');
    assert.equal(calls.length, 1);

    // Devin keeps evolving its own title — the sidebar must stay put and the
    // model is not even asked again.
    writeDevinDb(devinDbPath, [
      { id: 'dev-sess-5', title: 'Совсем другое название' },
    ]);
    await synchronizer.synchronize();
    await synchronizer.drainTitleJobs();

    const session = sessionsDb.getSessionById('dev-sess-5');
    assert.equal(session?.custom_name, 'Первое название');
    assert.equal(session?.title_source, 'ai');
    assert.equal(calls.length, 1);
  });
});

test('a failing model retries, then falls back to the raw CLI title', async () => {
  await withIsolatedStores(async (devinDbPath) => {
    writeDevinDb(devinDbPath, [
      { id: 'dev-sess-flaky', title: 'Сырой заголовок от CLI' },
    ]);
    seedTwoTurns(devinDbPath, 'dev-sess-flaky');

    let failures = 0;
    const { synchronizer, calls } = testSynchronizer(async () => {
      failures += 1;
      throw new Error('Devin не ответил');
    });

    // Two failed attempts (titleMaxAttempts = 2), then the next pass writes
    // the raw CLI title — better a long real name than a prompt fragment.
    await synchronizer.synchronize();
    await synchronizer.drainTitleJobs();
    await synchronizer.synchronize();
    await synchronizer.drainTitleJobs();
    assert.equal(sessionsDb.getSessionById('dev-sess-flaky')?.title_source, 'naive');

    await synchronizer.synchronize();
    await synchronizer.drainTitleJobs();
    const session = sessionsDb.getSessionById('dev-sess-flaky');
    assert.equal(session?.custom_name, 'Сырой заголовок от CLI');
    assert.equal(session?.title_source, 'ai');
    assert.equal(calls.length, 2);
    assert.equal(failures, 2);
  });
});

test('a recovered model beats the fallback on the next pass', async () => {
  await withIsolatedStores(async (devinDbPath) => {
    writeDevinDb(devinDbPath, [
      { id: 'dev-sess-recover', title: 'Сырой заголовок от CLI' },
    ]);
    seedTwoTurns(devinDbPath, 'dev-sess-recover');

    let attempt = 0;
    const { synchronizer } = testSynchronizer(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('Devin не ответил');
      }
      return 'Короткое имя от модели';
    });

    await synchronizer.synchronize();
    await synchronizer.drainTitleJobs();
    assert.equal(sessionsDb.getSessionById('dev-sess-recover')?.title_source, 'naive');

    await synchronizer.synchronize();
    await synchronizer.drainTitleJobs();
    assert.equal(sessionsDb.getSessionById('dev-sess-recover')?.custom_name, 'Короткое имя от модели');
    assert.equal(sessionsDb.getSessionById('dev-sess-recover')?.title_source, 'ai');
  });
});

test('one-shot `devin -p` helper sessions in the model cwd are never indexed', async () => {
  await withIsolatedStores(async (devinDbPath) => {
    writeDevinDb(devinDbPath, [
      { id: 'dev-sess-helper', working_directory: DEVIN_MODEL_CWD, title: 'Ответь только названием' },
      { id: 'dev-sess-real', title: 'Настоящий чат' },
    ]);

    const synchronizer = new DevinSessionSynchronizer(async () => 'Имя');
    assert.equal(await synchronizer.synchronize(), 1);
    await synchronizer.drainTitleJobs();

    assert.equal(sessionsDb.getSessionById('dev-sess-helper'), null);
    assert.ok(sessionsDb.getSessionById('dev-sess-real'));
  });
});

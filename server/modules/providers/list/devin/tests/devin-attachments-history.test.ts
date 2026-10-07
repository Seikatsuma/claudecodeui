import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { DevinSessionsProvider } from '@/modules/providers/list/devin/devin-sessions.provider.js';
import { appendFilesInputTag, appendImagesInputTag } from '@/shared/image-attachments.js';

const SESSION_ID = 'session-att';

/**
 * Минимальная изоляция: `fetchHistory` читает только Devin-хранилище
 * (`XDG_DATA_HOME/devin/cli/sessions.db`), прикладной базы не касается.
 */
async function withDevinStore(runTest: (devinDbPath: string) => Promise<void>): Promise<void> {
  const previousXdg = process.env.XDG_DATA_HOME;
  const xdgHome = await mkdtemp(path.join(os.tmpdir(), 'devin-att-xdg-'));
  process.env.XDG_DATA_HOME = xdgHome;
  const devinDbDir = path.join(xdgHome, 'devin', 'cli');
  await mkdir(devinDbDir, { recursive: true });
  const devinDbPath = path.join(devinDbDir, 'sessions.db');
  try {
    await runTest(devinDbPath);
  } finally {
    if (previousXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdg;
    }
    await rm(xdgHome, { recursive: true, force: true });
  }
}

type DevinNode = {
  node_id: number;
  parent_node_id: number | null;
  chat_message: unknown;
};

/**
 * Цепочка «вопрос → ответ» как в боевой базе: вершина `main_chain_id` —
 * ответ агента, оба узла в живой цепочке, значит оба попадут в переписку.
 */
function writeConversation(devinDbPath: string, userMessage: unknown): void {
  const nodes: DevinNode[] = [
    {
      node_id: 1,
      parent_node_id: null,
      chat_message: {
        role: 'user',
        metadata: { is_user_input: true, created_at: 1_700_000_000 },
        content: userMessage,
      },
    },
    {
      node_id: 2,
      parent_node_id: 1,
      chat_message: {
        role: 'assistant',
        metadata: { created_at: 1_700_000_010 },
        content: 'ответ агента',
      },
    },
  ];
  const db = new Database(devinDbPath);
  try {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        working_directory TEXT,
        title TEXT,
        created_at INTEGER,
        last_activity_at INTEGER,
        main_chain_id INTEGER,
        hidden INTEGER DEFAULT 0
      );
      CREATE TABLE message_nodes (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        node_id INTEGER NOT NULL,
        parent_node_id INTEGER,
        chat_message TEXT NOT NULL,
        created_at INTEGER
      );
      INSERT INTO sessions (id, working_directory, created_at, main_chain_id)
      VALUES ('${SESSION_ID}', '/tmp/project', 1700000000, 2);
    `);
    const insert = db.prepare(
      'INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const node of nodes) {
      insert.run(SESSION_ID, node.node_id, node.parent_node_id, JSON.stringify(node.chat_message), 1_700_000_000);
    }
  } finally {
    db.close();
  }
}

async function fetchUserMessage(userMessage: unknown) {
  const provider = new DevinSessionsProvider();
  const result = await provider.fetchHistory(SESSION_ID);
  assert.equal(result.total > 0, true);
  const user = result.messages.find((message) => message.role === 'user');
  assert.ok(user, 'реплика человека не дошла до ленты');
  return user!;
}

test('devin history: <images_input> tag turns into message images, text stays clean', async () => {
  await withDevinStore(async (devinDbPath) => {
    const prompt = appendImagesInputTag('что на снимке?', [
      { path: '/home/claude/.cloudcli/assets/shot.png', name: 'shot.png' },
    ]);
    writeConversation(devinDbPath, prompt);

    const user = await fetchUserMessage(prompt);
    assert.equal(user.content, 'что на снимке?');
    assert.deepEqual(user.images, [{ path: '/home/claude/.cloudcli/assets/shot.png', name: 'shot.png' }]);
    assert.equal(user.files, undefined);
  });
});

test('devin history: <files_input> tag turns into message files', async () => {
  await withDevinStore(async (devinDbPath) => {
    const prompt = appendFilesInputTag('сделай выжимку', [
      { path: '/home/claude/.cloudcli/assets/brief.pdf', name: 'brief.pdf' },
    ]);
    writeConversation(devinDbPath, prompt);

    const user = await fetchUserMessage(prompt);
    assert.equal(user.content, 'сделай выжимку');
    assert.deepEqual(user.files, [{ path: '/home/claude/.cloudcli/assets/brief.pdf', name: 'brief.pdf' }]);
    assert.equal(user.images, undefined);
  });
});

test('devin history: array content with image blocks becomes data-url images', async () => {
  await withDevinStore(async (devinDbPath) => {
    const content = [
      { type: 'text', text: 'посмотри' },
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    ];
    writeConversation(devinDbPath, content);

    const user = await fetchUserMessage(content);
    assert.equal(user.content, 'посмотри');
    assert.deepEqual(user.images, [{ data: 'data:image/png;base64,QUJD' }]);
  });
});

test('devin history: plain text user turn carries no images/files', async () => {
  await withDevinStore(async (devinDbPath) => {
    writeConversation(devinDbPath, 'обычный вопрос');

    const user = await fetchUserMessage('обычный вопрос');
    assert.equal(user.content, 'обычный вопрос');
    assert.equal(user.images, undefined);
    assert.equal(user.files, undefined);
  });
});

test('devin history: {type:content} wrapper unwraps inner block', async () => {
  await withDevinStore(async (devinDbPath) => {
    const content = [
      { type: 'content', content: { type: 'text', text: 'привет из обёртки' } },
      { type: 'content', content: { type: 'image', data: 'QUJD', mimeType: 'image/png' } },
    ];
    writeConversation(devinDbPath, content);

    const user = await fetchUserMessage(content);
    assert.equal(user.content, 'привет из обёртки');
    assert.deepEqual(user.images, [{ data: 'data:image/png;base64,QUJD' }]);
  });
});

test('devin history: typed array text strips input tags into images/files', async () => {
  await withDevinStore(async (devinDbPath) => {
    const textWithTags = appendImagesInputTag(
      appendFilesInputTag('что в файле и на снимке?', [
        { path: '/home/claude/.cloudcli/assets/brief.pdf', name: 'brief.pdf' },
      ]),
      [{ path: '/home/claude/.cloudcli/assets/shot.png', name: 'shot.png' }],
    );
    const content = [{ type: 'text', text: textWithTags }];
    writeConversation(devinDbPath, content);

    const user = await fetchUserMessage(content);
    assert.equal(user.content, 'что в файле и на снимке?');
    assert.deepEqual(user.images, [{ path: '/home/claude/.cloudcli/assets/shot.png', name: 'shot.png' }]);
    assert.deepEqual(user.files, [{ path: '/home/claude/.cloudcli/assets/brief.pdf', name: 'brief.pdf' }]);
  });
});

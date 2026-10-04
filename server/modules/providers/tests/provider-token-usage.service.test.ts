import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { readDevinTokenUsage, resetDevinTokenUsageScans } from '@/modules/providers/list/devin/devin-usage.js';
import { createProviderTokenUsageService } from '@/modules/providers/services/provider-token-usage.service.js';
import { AppError, readCodexContextTokenUsage } from '@/shared/utils.js';

function createSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'app-session',
    provider: 'claude',
    provider_session_id: 'provider-session',
    project_path: null,
    jsonl_path: null,
    custom_name: null,
    title_source: 'naive' as const,
    model: null,
    effort: null,
    group_id: null,
    group_label: null,
    isArchived: 0,
    server_scope: 'main' as const,
    is_flagged: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('token usage lookup requires only the app-facing session id for Claude', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-'));
  const sessionFilePath = path.join(tempDirectory, 'provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
            output_tokens: 30,
          },
        },
      }),
      '{incomplete',
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ jsonl_path: sessionFilePath }),
      getClaudeContextWindow: () => '180000',
    });

    // Заполненность — только вход (input + cache_read + cache_creation), как у Claude Code.
    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 125,
      total: 180_000,
      inputTokens: 125,
      outputTokens: 30,
      cacheReadTokens: 20,
      cacheCreationTokens: 5,
      cacheTokens: 25,
      breakdown: { input: 125, output: 30 },
      contextTokens: 125,
      contextWindow: 180_000,
      contextPercent: 0.1,
      model: null,
      session: {
        inputTokens: 125,
        outputTokens: 30,
        freshInputTokens: 100,
        cacheReadTokens: 20,
        cacheCreationTokens: 5,
        totalTokens: 155,
        requests: 1,
      },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex token usage uses the current context instead of cumulative session spend', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-codex-'));
  const sessionFilePath = path.join(tempDirectory, 'rollout-provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
            last_token_usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
            model_context_window: 100_000,
          },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 2_000_000, output_tokens: 90_000, total_tokens: 2_090_000 },
            last_token_usage: { input_tokens: 40, output_tokens: 9, total_tokens: 49 },
            model_context_window: 250_000,
          },
        },
      }),
    ].join('\n'));

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({
        provider: 'codex',
        jsonl_path: sessionFilePath,
      }),
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 49,
      total: 250_000,
      inputTokens: 40,
      outputTokens: 9,
      breakdown: { input: 40, output: 9 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex token usage keeps older transcripts working when no current-context field exists', () => {
  assert.deepEqual(readCodexContextTokenUsage({
    total_token_usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 },
    model_context_window: 200_000,
  }), {
    used: 35,
    total: 200_000,
    inputTokens: 30,
    outputTokens: 5,
    breakdown: { input: 30, output: 5 },
  });
});

test('OpenCode token usage resolves its provider-native id from the session row', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-opencode-'));
  const databasePath = path.join(tempDirectory, 'opencode.db');
  const database = new Database(databasePath);

  try {
    database.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_reasoning INTEGER,
        tokens_cache_read INTEGER,
        tokens_cache_write INTEGER
      )
    `);
    database.prepare(`
      INSERT INTO session (
        id,
        tokens_input,
        tokens_output,
        tokens_reasoning,
        tokens_cache_read,
        tokens_cache_write
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('provider-session', 12, 7, 3, 5, 2);
  } finally {
    database.close();
  }

  try {
    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ provider: 'opencode' }),
      getOpenCodeDatabasePath: () => databasePath,
    });

    assert.deepEqual(await service.getSessionTokenUsage('app-session'), {
      used: 29,
      inputTokens: 17,
      outputTokens: 7,
      breakdown: { input: 17, output: 7 },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Cursor returns an explicit unsupported token usage result', async () => {
  const service = createProviderTokenUsageService({
    getSessionById: () => createSessionRow({ provider: 'cursor' }),
  });

  const result = await service.getSessionTokenUsage('app-session');

  assert.equal(result.unsupported, true);
  assert.equal(result.used, 0);
  assert.equal(result.total, 0);
});

test('token usage reports SESSION_NOT_FOUND for an unknown app session id', async () => {
  const service = createProviderTokenUsageService({ getSessionById: () => null });

  await assert.rejects(
    () => service.getSessionTokenUsage('missing-session'),
    (error: unknown) => (
      error instanceof AppError
      && error.code === 'SESSION_NOT_FOUND'
      && error.statusCode === 404
    ),
  );
});

test('Claude: счётчик находится, даже если после него в стенограмме больше мегабайта других строк', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-tail-'));
  const sessionFilePath = path.join(tempDirectory, 'provider-session.jsonl');

  try {
    const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2000) } });
    await writeFile(sessionFilePath, [
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1, output_tokens: 1 } } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 700, output_tokens: 40 } } }),
      ...Array.from({ length: 700 }, () => filler),
    ].join('\n') + '\n');

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ jsonl_path: sessionFilePath }),
      getClaudeContextWindow: () => '180000',
    });

    const usage = await service.getSessionTokenUsage('app-session');
    assert.equal(usage.inputTokens, 700);
    assert.equal(usage.outputTokens, 40);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});


function assistantLine(usage: Record<string, number>, extra: Record<string, unknown> = {}, message: Record<string, unknown> = {}) {
  return JSON.stringify({ type: 'assistant', ...extra, message: { model: 'claude-opus-5-5', ...message, usage } });
}

test('Claude: помощники и пустые <synthetic> не сбивают заполненность, повторы одного ответа склеиваются по максимуму', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-rules-'));
  const sessionFilePath = path.join(tempDirectory, 'session.jsonl');
  try {
    await writeFile(sessionFilePath, [
      // Один ответ тремя строками: ранние несут недописанный вывод.
      assistantLine({ input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: 1 }, { requestId: 'r1' }, { id: 'm1' }),
      assistantLine({ input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: 7 }, { requestId: 'r1' }, { id: 'm1' }),
      assistantLine({ input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: 90 }, { requestId: 'r1' }, { id: 'm1' }),
      assistantLine({ input_tokens: 5, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, output_tokens: 40 }, { requestId: 'r2' }, { id: 'm2' }),
      // Помощник: в полный расход входит, в заполненность — нет.
      assistantLine({ input_tokens: 3, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 11 }, { requestId: 'r3', isSidechain: true }, { id: 'm3' }),
      // Прерывание: нулевой счёт.
      assistantLine({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }, {}, { model: '<synthetic>', id: 'm4' }),
    ].join('\n') + '\n');

    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ jsonl_path: sessionFilePath }),
      getClaudeContextWindow: () => undefined,
      resolveClaudeContextWindow: () => 200_000,
    });
    const usage = await service.getSessionTokenUsage('app-session');
    assert.equal(usage.used, 2005);
    assert.equal(usage.contextTokens, 2005);
    assert.equal(usage.outputTokens, 40);
    assert.equal(usage.model, 'claude-opus-5-5');
    assert.deepEqual(usage.session, {
      inputTokens: 1060 + 2005 + 9003,
      outputTokens: 90 + 40 + 11,
      freshInputTokens: 18,
      cacheReadTokens: 12000,
      cacheCreationTokens: 50,
      totalTokens: 1060 + 2005 + 9003 + 141,
      requests: 3,
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Claude: после сжатия разговора заполненность — «стало» из compact_boundary до первого нового ответа; файл дочитывается', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-compact-'));
  const sessionFilePath = path.join(tempDirectory, 'session.jsonl');
  try {
    await writeFile(sessionFilePath, [
      assistantLine({ input_tokens: 1, cache_read_input_tokens: 950_000, cache_creation_input_tokens: 0, output_tokens: 5 }, { requestId: 'r1' }, { id: 'm1' }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 964_535, postTokens: 21_496 } }),
    ].join('\n') + '\n');
    const seenObserved: number[] = [];
    const service = createProviderTokenUsageService({
      getSessionById: () => createSessionRow({ jsonl_path: sessionFilePath }),
      getClaudeContextWindow: () => undefined,
      resolveClaudeContextWindow: (input) => {
        seenObserved.push(input.maxObservedContext ?? 0);
        return 1_000_000;
      },
    });
    const afterCompact = await service.getSessionTokenUsage('app-session');
    assert.equal(afterCompact.contextTokens, 21_496);
    assert.equal(afterCompact.contextPercent, 2.1);
    assert.equal(seenObserved[0], 964_535);

    await writeFile(sessionFilePath, [
      assistantLine({ input_tokens: 1, cache_read_input_tokens: 950_000, cache_creation_input_tokens: 0, output_tokens: 5 }, { requestId: 'r1' }, { id: 'm1' }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 964_535, postTokens: 21_496 } }),
      assistantLine({ input_tokens: 2, cache_read_input_tokens: 25_000, cache_creation_input_tokens: 100, output_tokens: 8 }, { requestId: 'r2' }, { id: 'm2' }),
    ].join('\n') + '\n');
    const next = await service.getSessionTokenUsage('app-session');
    assert.equal(next.contextTokens, 25_102);
    assert.equal(next.session?.requests, 2);
    assert.equal(next.session?.outputTokens, 13);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Devin: сервис отдаёт снимок из базы Devin, model уходит подсказкой', async () => {
  const snapshot = {
    used: 250,
    total: 262_000,
    inputTokens: 250,
    outputTokens: 40,
    cacheReadTokens: 50,
    cacheCreationTokens: 0,
    cacheTokens: 50,
    breakdown: { input: 250, output: 40 },
    contextTokens: 250,
    contextWindow: 262_000,
    contextPercent: 0.1,
    model: 'swe-2-max',
    session: {
      inputTokens: 1374,
      outputTokens: 79,
      freshInputTokens: 1299,
      cacheReadTokens: 70,
      cacheCreationTokens: 5,
      totalTokens: 1453,
      requests: 3,
    },
  };
  const seen: Array<{ id: string; modelHint?: string | null }> = [];
  const service = createProviderTokenUsageService({
    getSessionById: () => createSessionRow({ provider: 'devin', model: 'swe-2-max' }),
    readDevinTokenUsage: (id: string, options?: { modelHint?: string | null }) => {
      seen.push({ id, modelHint: options?.modelHint });
      return snapshot;
    },
  });

  assert.deepEqual(await service.getSessionTokenUsage('app-session'), snapshot);
  assert.deepEqual(seen, [{ id: 'provider-session', modelHint: 'swe-2-max' }]);
});

test('Devin: заполненность — последний ответ живой цепи, расход — все ответы с дедупом по request_id', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'devin-usage-'));
  const previousXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = tempDirectory;
  resetDevinTokenUsageScans();

  const databaseDir = path.join(tempDirectory, 'devin', 'cli');
  await mkdir(databaseDir, { recursive: true });
  const database = new Database(path.join(databaseDir, 'sessions.db'));

  const assistant = (metrics: Record<string, unknown>) => JSON.stringify({
    role: 'assistant',
    content: 'text',
    metadata: { metrics },
  });

  try {
    database.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, main_chain_id INTEGER);
      CREATE TABLE message_nodes (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        node_id INTEGER NOT NULL,
        parent_node_id INTEGER,
        chat_message TEXT NOT NULL,
        created_at INTEGER
      );
      INSERT INTO sessions (id, model, main_chain_id) VALUES ('devin-chat', 'swe-2-max', 5);
    `);
    const insert = database.prepare(
      'INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message) VALUES (?, ?, ?, ?)',
    );
    const run = (nodeId: number, parentId: number | null, message: string) =>
      insert.run('devin-chat', nodeId, parentId, message);

    run(1, null, JSON.stringify({ role: 'user', content: 'hi' }));
    // Один ответ — двумя узлами с одним request_id (как в живой базе).
    run(2, 1, assistant({ input_tokens: 100, output_tokens: 30, cache_read_tokens: 20, cache_creation_tokens: 5, request_id: 'r1' }));
    run(3, 2, assistant({ input_tokens: 100, output_tokens: 30, cache_read_tokens: 20, cache_creation_tokens: 5, request_id: 'r1' }));
    run(4, 3, JSON.stringify({ role: 'user', content: 'next' }));
    run(5, 4, assistant({ input_tokens: 200, output_tokens: 40, cache_read_tokens: 50, cache_creation_tokens: 0, request_id: 'r2' }));
    // Заброшенная ветка: в расход входит, в заполненность — нет.
    run(6, 1, assistant({ input_tokens: 999, output_tokens: 9, cache_read_tokens: 0, cache_creation_tokens: 0, request_id: 'rX' }));
  } finally {
    database.close();
  }

  try {
    const usage = readDevinTokenUsage('devin-chat');
    assert.ok(usage);
    assert.equal(usage.used, 250);
    assert.equal(usage.contextTokens, 250);
    assert.equal(usage.contextWindow, 262_000);
    assert.equal(usage.model, 'swe-2-max');
    assert.deepEqual(usage.session, {
      inputTokens: 100 + 20 + 5 + 200 + 50 + 999,
      outputTokens: 30 + 40 + 9,
      freshInputTokens: 100 + 200 + 999,
      cacheReadTokens: 70,
      cacheCreationTokens: 5,
      totalTokens: 100 + 20 + 5 + 200 + 50 + 999 + 79,
      requests: 3,
    });

    // Новые строки дочитываются без повторного разбора старых.
    const database2 = new Database(path.join(databaseDir, 'sessions.db'));
    database2.prepare(
      'INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message) VALUES (?, ?, ?, ?)',
    ).run('devin-chat', 7, 5, assistant({ input_tokens: 10, output_tokens: 4, cache_read_tokens: 300, cache_creation_tokens: 0, request_id: 'r3' }));
    database2.prepare('UPDATE sessions SET main_chain_id = 7 WHERE id = ?').run('devin-chat');
    database2.close();

    const next = readDevinTokenUsage('devin-chat');
    assert.equal(next?.contextTokens, 310);
    assert.equal(next?.session?.requests, 4);
  } finally {
    if (previousXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdg;
    }
    resetDevinTokenUsageScans();
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Devin: беседы нет в базе — null, не ноль с враньём', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'devin-usage-missing-'));
  const previousXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = tempDirectory;
  resetDevinTokenUsageScans();

  const databaseDir = path.join(tempDirectory, 'devin', 'cli');
  await mkdir(databaseDir, { recursive: true });
  const database = new Database(path.join(databaseDir, 'sessions.db'));
  database.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, main_chain_id INTEGER)');
  database.close();

  try {
    assert.equal(readDevinTokenUsage('missing'), null);
  } finally {
    if (previousXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdg;
    }
    resetDevinTokenUsageScans();
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Claude: чат находится и по номеру у Claude, если страница ещё не знает номер сайта', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-token-usage-claude-provider-id-'));
  const sessionFilePath = path.join(tempDirectory, 'session.jsonl');
  try {
    await writeFile(sessionFilePath, assistantLine({ input_tokens: 7, output_tokens: 1 }) + '\n');
    const service = createProviderTokenUsageService({
      getSessionById: () => null,
      getSessionByProviderSessionId: (id) => (id === 'provider-session' ? createSessionRow({ jsonl_path: sessionFilePath }) : null),
      getClaudeContextWindow: () => undefined,
      resolveClaudeContextWindow: () => 200_000,
    });
    assert.equal((await service.getSessionTokenUsage('provider-session')).contextTokens, 7);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

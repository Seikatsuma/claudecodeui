import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { createProviderTokenUsageService } from '@/modules/providers/services/provider-token-usage.service.js';
import { AppError } from '@/shared/utils.js';

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

test('Codex token usage uses the latest token_count snapshot', async () => {
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
            model_context_window: 100_000,
          },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 40, output_tokens: 9, total_tokens: 49 },
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

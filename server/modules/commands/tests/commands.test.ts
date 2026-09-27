import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createCommandsRouter } from '../commands.routes.js';

/**
 * Stands in for `providerModelsService`. `resolveSessionModel` mirrors the real
 * precedence closely enough for the command handlers: a model recorded for the
 * session wins, otherwise the client's requested model, otherwise the catalog
 * default.
 */
function createModelsService(sessionModels: Record<string, string> = {}) {
  return {
    getProviderModels: async () => ({
      OPTIONS: [{ value: 'default', label: 'Default' }],
      DEFAULT: 'default',
    }),
    getCurrentActiveModel: async () => ({ model: 'default' }),
    setSessionModel: () => null,
    resolveSessionModel: async (
      provider: string,
      options: { sessionId?: string | null; requestedModel?: string | null } = {},
    ) => {
      const recorded = options.sessionId ? sessionModels[options.sessionId] : undefined;
      const model = recorded || options.requestedModel || 'default';
      return {
        provider,
        sessionId: options.sessionId ?? null,
        model,
        source: model === 'default' ? 'default' : 'session',
      };
    },
    resolveResumeModel: async () => undefined,
  };
}

async function executeCommand(
  commandName: string,
  context: Record<string, unknown>,
  sessionModels: Record<string, string> = {},
  tokenUsage?: { getSessionTokenUsage(sessionId: string): Promise<Record<string, any>> },
): Promise<Record<string, unknown>> {
  const router = createCommandsRouter({
    ...(tokenUsage ? { tokenUsage } : {}),
    fileSystem: {
      readFile: async () => JSON.stringify({ name: 'claude-code-ui', version: '0.0.0-test' }),
    } as unknown as typeof import('node:fs/promises'),
    homeDirectory: () => '/home/test',
    appRoot: '/app',
    models: createModelsService(sessionModels) as never,
    runtime: {
      uptime: () => 0,
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
      version: 'v22', platform: 'linux', pid: 1,
    },
  });
  const app = express().use(express.json()).use('/api/commands', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/commands/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandName, context }),
    });
    assert.equal(response.status, 200);
    return await response.json() as Record<string, unknown>;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('models command returns models only for the active provider using injected catalog', async () => {
  const result = await executeCommand('/models', { provider: 'codex' });
  const data = result.data as Record<string, unknown>;
  assert.deepEqual(Object.keys(data.available as object), ['codex']);
});

test('models command falls back to claude for unsupported providers', async () => {
  const result = await executeCommand('/models', { provider: 'unknown-provider' });
  const data = result.data as { current: { provider: string } };
  assert.equal(data.current.provider, 'claude');
});

test('models command reports the model recorded for the session', async () => {
  const result = await executeCommand(
    '/models',
    { provider: 'claude', sessionId: 'session-1', model: 'sonnet' },
    { 'session-1': 'haiku' },
  );

  const data = result.data as { current: { model: string } };
  assert.equal(data.current.model, 'haiku');
});

test('models command reports the composer model for a chat with no session yet', async () => {
  const result = await executeCommand('/models', { provider: 'claude', model: 'haiku' });

  const data = result.data as { current: { model: string } };
  assert.equal(data.current.model, 'haiku');
});

test('cost and status commands report the same resolved model as /models', async () => {
  const context = { provider: 'claude', sessionId: 'session-1', model: 'sonnet' };
  const sessionModels = { 'session-1': 'haiku' };

  const cost = await executeCommand('/cost', context, sessionModels);
  const status = await executeCommand('/status', context, sessionModels);

  assert.equal((cost.data as { model: string }).model, 'haiku');
  assert.equal((status.data as { model: string }).model, 'haiku');
});

test('окно «Token Usage» берёт цифры с сервера в момент нажатия, а не присланный браузером ноль', async () => {
  const asked: string[] = [];
  const tokenUsage = {
    getSessionTokenUsage: async (sessionId: string) => {
      asked.push(sessionId);
      return {
        used: 152_041,
        total: 1_000_000,
        contextTokens: 152_041,
        contextWindow: 1_000_000,
        contextPercent: 15.2,
        model: 'claude-opus-5-5',
        session: { inputTokens: 9_000_000, outputTokens: 40_000, totalTokens: 9_040_000 },
      };
    },
  };
  const cost = await executeCommand('/cost', { provider: 'claude', sessionId: 'session-1', tokenUsage: null }, {}, tokenUsage);
  assert.deepEqual(asked, ['session-1']);
  assert.deepEqual(cost.data, {
    tokenUsage: { used: 9_040_000, total: 1_000_000, contextUsed: 152_041, contextPercent: 15.2 },
    tokenBreakdown: { input: 9_000_000, output: 40_000 },
    provider: 'claude',
    model: 'claude-opus-5-5 · 1M context',
  });
});

test('окно «Token Usage»: сервер не нашёл чат — остаются цифры браузера', async () => {
  const tokenUsage = { getSessionTokenUsage: async () => { throw new Error('not found'); } };
  const cost = await executeCommand('/cost', {
    provider: 'claude', sessionId: 'session-1', model: 'sonnet',
    tokenUsage: { used: 10, total: 200_000, inputTokens: 7, outputTokens: 3 },
  }, {}, tokenUsage);
  const data = cost.data as { tokenUsage: { used: number; total: number } };
  assert.equal(data.tokenUsage.used, 10);
  assert.equal(data.tokenUsage.total, 200_000);
});

async function listCommands(body: Record<string, unknown>): Promise<Record<string, any>> {
  const router = createCommandsRouter({
    fileSystem: {
      access: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    } as unknown as typeof import('node:fs/promises'),
    homeDirectory: () => '/home/test',
    appRoot: '/app',
    models: createModelsService() as never,
    nativeCommands: {
      listCommands: async () => [
        { name: '/context', description: 'Context usage', argumentHint: '' },
        { name: '/config', description: 'CLI config', argumentHint: 'key=value' },
        { name: '/clear', description: 'CLI clear', argumentHint: '' },
      ],
    },
    runtime: {
      uptime: () => 0,
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
      version: 'v22', platform: 'linux', pid: 1,
    },
  });
  const app = express().use(express.json()).use('/api/commands', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/commands/list`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return await response.json() as Record<string, any>;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('список команд несёт команды самого Claude, кроме тех, что делает интерфейс', async () => {
  const data = await listCommands({ projectPath: '/tmp/none', provider: 'claude' });
  assert.deepEqual(data.native.map((command: { name: string }) => command.name), ['/context']);
  assert.equal(data.native[0].namespace, 'claude');
  assert.ok(data.builtIn.some((command: { name: string }) => command.name === '/clear'));
});

test('команды Claude не показываются в чатах других агентов', async () => {
  const data = await listCommands({ projectPath: '/tmp/none', provider: 'codex' });
  assert.deepEqual(data.native, []);
});

test('/clear отдаёт интерфейсу действие «новый чат», а не уходит Claude', async () => {
  const result = await executeCommand('/clear', { provider: 'claude' });
  assert.equal(result.type, 'builtin');
  assert.equal(result.action, 'clear');
});

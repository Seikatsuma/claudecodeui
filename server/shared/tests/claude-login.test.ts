import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  hasOwnClaudeAccess,
  readClaudeLoginFromConfigDir,
  withoutInheritedClaudeAuth,
} from '@/shared/claude-login.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

async function withConfigDir(
  files: Record<string, unknown>,
  check: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-login-test-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
    }
    await check(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const oauth = (fields: Record<string, unknown>) => ({
  '.credentials.json': { claudeAiOauth: { accessToken: 'test-access', ...fields } },
});

test('вход в командной строке только что — вошёл', async () => {
  await withConfigDir(oauth({ refreshToken: 'test-refresh', expiresAt: NOW + HOUR }), async (dir) => {
    const status = await readClaudeLoginFromConfigDir(dir, NOW);
    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'credentials_file');
  });
});

test('короткий ключ истёк, ключ продления жив — вошёл (CLI продлит сам)', async () => {
  await withConfigDir(oauth({ refreshToken: 'test-refresh', expiresAt: NOW - HOUR }), async (dir) => {
    assert.equal((await readClaudeLoginFromConfigDir(dir, NOW)).authenticated, true);
  });
});

test('короткий ключ истёк, продления нет — вход истёк', async () => {
  await withConfigDir(oauth({ expiresAt: NOW - HOUR }), async (dir) => {
    const status = await readClaudeLoginFromConfigDir(dir, NOW);
    assert.equal(status.authenticated, false);
    assert.match(status.error ?? '', /expired/);
  });
});

test('истёк и ключ продления — вход истёк', async () => {
  await withConfigDir(
    oauth({ refreshToken: 'test-refresh', expiresAt: NOW - HOUR, refreshTokenExpiresAt: NOW - 1 }),
    async (dir) => {
      assert.equal((await readClaudeLoginFromConfigDir(dir, NOW)).authenticated, false);
    },
  );
});

test('пустая папка нового человека — не вошёл', async () => {
  await withConfigDir({}, async (dir) => {
    const status = await readClaudeLoginFromConfigDir(dir, NOW);
    assert.equal(status.authenticated, false);
    assert.match(status.error ?? '', /not authenticated/);
  });
});

test('битый файл входа — не вошёл, с понятной ошибкой', async () => {
  await withConfigDir({ '.credentials.json': '{oops' }, async (dir) => {
    const status = await readClaudeLoginFromConfigDir(dir, NOW);
    assert.equal(status.authenticated, false);
    assert.match(status.error ?? '', /unreadable/);
  });
});

test('ключ API в settings.json своей папки — вошёл', async () => {
  await withConfigDir({ 'settings.json': { env: { ANTHROPIC_API_KEY: 'test-key' } } }, async (dir) => {
    const status = await readClaudeLoginFromConfigDir(dir, NOW);
    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'api_key');
  });
});

test('чат: гость, вошедший в командной строке без ключа API, — доступ есть', async () => {
  await withConfigDir(oauth({ refreshToken: 'test-refresh', expiresAt: Date.now() + HOUR }), async (dir) => {
    assert.equal(
      await hasOwnClaudeAccess({ claudeConfigDir: dir, anthropicApiKey: null, isolateInheritedClaudeAuth: true }),
      true,
    );
  });
});

test('чат: гость без входа и без ключа — доступа нет', async () => {
  await withConfigDir({}, async (dir) => {
    assert.equal(
      await hasOwnClaudeAccess({ claudeConfigDir: dir, anthropicApiKey: null, isolateInheritedClaudeAuth: true }),
      false,
    );
  });
});

test('чат: ключ API в настройках сайта — доступ есть и без входа', async () => {
  assert.equal(
    await hasOwnClaudeAccess({ claudeConfigDir: null, anthropicApiKey: 'test-key', isolateInheritedClaudeAuth: true }),
    true,
  );
});

test('гостю ключи Claude сервера не передаются, остальное окружение — да', () => {
  const env = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'owner-key',
    ANTHROPIC_AUTH_TOKEN: 'owner-token',
    CLAUDE_CODE_OAUTH_TOKEN: 'owner-oauth',
    ANTHROPIC_BASE_URL: 'https://example.test',
  };
  const guest = withoutInheritedClaudeAuth(env, { claudeConfigDir: '/x', anthropicApiKey: null, isolateInheritedClaudeAuth: true });
  assert.deepEqual(guest, { PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'https://example.test' });
  assert.equal(env.ANTHROPIC_API_KEY, 'owner-key', 'окружение сервера не портится');
});

test('владельцу и одноаккаунтной установке окружение отдаётся как есть', () => {
  const env = { ANTHROPIC_API_KEY: 'owner-key' };
  assert.equal(
    withoutInheritedClaudeAuth(env, { claudeConfigDir: null, anthropicApiKey: null, isolateInheritedClaudeAuth: false }),
    env,
  );
});

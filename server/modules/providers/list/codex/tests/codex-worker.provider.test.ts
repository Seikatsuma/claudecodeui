import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCodexCliEnvironment } from '../codex-worker.provider.js';

test('marks a UI Codex turn with its app session and exact database', () => {
  const environment = buildCodexCliEnvironment(' app-session-7 ', {
    HOME: '/home/example',
    DATABASE_PATH: '/srv/cloudcli/auth.db',
    PATH: '/usr/bin',
  });

  assert.equal(environment.CLOUDCLI_CODEX_NOTIFY, 'cloudcli-chat');
  assert.equal(environment.CLOUDCLI_CODEX_NOTIFY_SESSION_ID, 'app-session-7');
  assert.equal(environment.CLOUDCLI_CODEX_NOTIFY_DATABASE_PATH, '/srv/cloudcli/auth.db');
  assert.equal(environment.PATH, '/usr/bin');
});

test('fails closed for a launch without an app session', () => {
  const environment = buildCodexCliEnvironment('', {
    HOME: '/home/example',
    CLOUDCLI_CODEX_NOTIFY: 'cloudcli-chat',
    CLOUDCLI_CODEX_NOTIFY_SESSION_ID: 'foreign-session',
    CLOUDCLI_CODEX_NOTIFY_DATABASE_PATH: '/srv/foreign/auth.db',
  });

  assert.equal(environment.CLOUDCLI_CODEX_NOTIFY, undefined);
  assert.equal(environment.CLOUDCLI_CODEX_NOTIFY_SESSION_ID, undefined);
  assert.equal(environment.CLOUDCLI_CODEX_NOTIFY_DATABASE_PATH, undefined);
});

test('uses the instance default database when DATABASE_PATH is absent', () => {
  const environment = buildCodexCliEnvironment('app-session-8', {
    HOME: '/home/example',
  });

  assert.equal(environment.CLOUDCLI_CODEX_NOTIFY_DATABASE_PATH, '/home/example/.cloudcli/auth.db');
});

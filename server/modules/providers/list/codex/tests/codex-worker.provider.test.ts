import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCodexCliEnvironment } from '../codex-worker.provider.js';

test('marks internal Codex callbacks as worker progress, not completed UI runs', () => {
  const environment = buildCodexCliEnvironment(' app-session-7 ', {
    HOME: '/home/example',
    DATABASE_PATH: '/srv/cloudcli/auth.db',
    PATH: '/usr/bin',
  }, '/srv/cloudcli/live-runs/run-7.result-notified');

  assert.equal(environment.CLOUDCLI_CODEX_NOTIFY, 'cloudcli-worker');
  assert.equal(environment.CLOUDCLI_CODEX_NOTIFY_SESSION_ID, 'app-session-7');
  assert.equal(environment.CLOUDCLI_CODEX_NOTIFY_DATABASE_PATH, '/srv/cloudcli/auth.db');
  assert.equal(environment.CLOUDCLI_CODEX_NOTIFY_CLAIM_PATH, '/srv/cloudcli/live-runs/run-7.result-notified');
  assert.equal(environment.PATH, '/usr/bin');
});

test('fails closed for a launch without an app session', () => {
  const environment = buildCodexCliEnvironment('', {
    HOME: '/home/example',
    CLOUDCLI_CODEX_NOTIFY: 'cloudcli-chat',
    CLOUDCLI_CODEX_NOTIFY_SESSION_ID: 'foreign-session',
    CLOUDCLI_CODEX_NOTIFY_DATABASE_PATH: '/srv/foreign/auth.db',
    CLOUDCLI_CODEX_NOTIFY_CLAIM_PATH: '/srv/foreign/result-notified',
  });

  assert.equal(environment.CLOUDCLI_CODEX_NOTIFY, undefined);
  assert.equal(environment.CLOUDCLI_CODEX_NOTIFY_SESSION_ID, undefined);
  assert.equal(environment.CLOUDCLI_CODEX_NOTIFY_DATABASE_PATH, undefined);
  assert.equal(environment.CLOUDCLI_CODEX_NOTIFY_CLAIM_PATH, undefined);
});

test('uses the instance default database when DATABASE_PATH is absent', () => {
  const environment = buildCodexCliEnvironment('app-session-8', {
    HOME: '/home/example',
  });

  assert.equal(environment.CLOUDCLI_CODEX_NOTIFY_DATABASE_PATH, '/home/example/.cloudcli/auth.db');
});

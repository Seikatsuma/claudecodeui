import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDevinAuthStatus } from '@/modules/providers/services/devin-account.service.js';

test('parseDevinAuthStatus: logged in → name only, no paths or tokens in the record', () => {
  const account = parseDevinAuthStatus([
    'Logged in (via Devin).',
    '',
    'Credentials:',
    '  File:              /home/claude/.local/share/devin/credentials.toml',
    '  API server:        https://server.codeium.com',
    '',
    'User:',
    '  Name:              mywork_account_djn22',
  ].join('\n'));
  assert.equal(account.available, true);
  assert.equal(account.name, 'mywork_account_djn22');
  assert.equal(account.models, 'SWE-2');
  assert.ok(!JSON.stringify(account).includes('credentials'));
});

test('parseDevinAuthStatus: not logged in → unavailable', () => {
  const account = parseDevinAuthStatus('Not logged in.\n  Credentials path: /x/credentials.toml\nRun `devin auth login` to authenticate.');
  assert.equal(account.available, false);
  assert.equal(account.name, null);
});

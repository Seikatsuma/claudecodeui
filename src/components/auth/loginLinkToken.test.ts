import assert from 'node:assert/strict';
import test from 'node:test';

import { extractLoginLinkToken } from './loginLinkToken';

test('extracts a token from a complete login link', () => {
  assert.equal(
    extractLoginLinkToken('https://cc.example.ru/enter/nMsKcj_ooYAWE4bhfdzm8A'),
    'nMsKcj_ooYAWE4bhfdzm8A',
  );
});

test('accepts an explicit login path copied without an origin', () => {
  assert.equal(extractLoginLinkToken('/enter/nMsKcj_ooYAWE4bhfdzm8A'), 'nMsKcj_ooYAWE4bhfdzm8A');
});

test('accepts a bare token only for deliberate manual entry', () => {
  assert.equal(extractLoginLinkToken('  nMsKcj_ooYAWE4bhfdzm8A  '), null);
  assert.equal(extractLoginLinkToken('  nMsKcj_ooYAWE4bhfdzm8A  ', true), 'nMsKcj_ooYAWE4bhfdzm8A');
});

test('rejects prefixes, foreign URLs and other token-like clipboard text', () => {
  assert.equal(extractLoginLinkToken('ordinary clipboard text'), null);
  assert.equal(extractLoginLinkToken('/enter/short'), null);
  assert.equal(extractLoginLinkToken('prefix /enter/nMsKcj_ooYAWE4bhfdzm8A'), null);
  assert.equal(extractLoginLinkToken('https://bank.example/reset/abcdefghijk'), null);
  assert.equal(extractLoginLinkToken('api secret sk-ant-abcdef1234567890'), null);
  assert.equal(extractLoginLinkToken('order 12345678'), null);
});

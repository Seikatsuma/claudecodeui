import assert from 'node:assert/strict';
import test from 'node:test';

import { createSettingsService } from '../settings.service.js';

type Dependencies = Parameters<typeof createSettingsService>[0];

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    apiKeys: { list: () => [], create: () => ({}), remove: () => false, toggle: () => false },
    credentials: {
      list: () => [],
      create: () => ({}),
      remove: () => false,
      toggle: () => false,
      listWithPreview: () => [],
      getMeta: () => null,
      countByType: () => 0,
      activateExclusive: () => false,
    },
    notifications: {
      getPreferences: () => undefined,
      updatePreferences: () => ({}),
      createEnabledEvent: () => ({}),
      notifyUser: () => undefined,
    },
    pushSubscriptions: { save: () => undefined, remove: () => undefined },
    getVapidPublicKey: () => null,
    ...overrides,
  };
}

test('listApiKeys redacts secret values through the service boundary', () => {
  const service = createSettingsService(dependencies({
    apiKeys: {
      list: () => [{ id: 1, api_key: '1234567890-secret' }],
      create: () => ({}), remove: () => false, toggle: () => false,
    },
  }));
  assert.equal(service.listApiKeys(1).apiKeys[0]?.api_key, '1234567890...');
});

test('subscribeToPush persists the subscription and enables Web Push', () => {
  const operations: string[] = [];
  const service = createSettingsService(dependencies({
    pushSubscriptions: {
      save: (_id, endpoint) => operations.push(`save:${endpoint}`),
      remove: () => undefined,
    },
    notifications: {
      getPreferences: () => ({ channels: { webPush: false } }),
      updatePreferences: () => { operations.push('preferences'); return {}; },
      createEnabledEvent: () => ({ code: 'push.enabled' }),
      notifyUser: () => { operations.push('notify'); },
    },
  }));

  service.subscribeToPush(1, {
    endpoint: 'https://push.example.test',
    keys: { p256dh: 'key', auth: 'auth' },
  });
  assert.deepEqual(operations, ['save:https://push.example.test', 'preferences', 'notify']);
});

test('createAnthropicApiKey activates the first connection but not the second', () => {
  const created: Array<{ isActive: boolean | undefined }> = [];
  let count = 0;
  const service = createSettingsService(dependencies({
    credentials: {
      list: () => [], remove: () => false, toggle: () => false,
      listWithPreview: () => [], getMeta: () => null,
      countByType: () => count,
      activateExclusive: () => false,
      create: (_userId, _name, _type, _value, _description, isActive) => {
        created.push({ isActive });
        return { id: created.length };
      },
    },
  }));

  count = 0;
  service.createAnthropicApiKey(1, { label: 'Personal', apiKey: 'sk-ant-first' });
  count = 1;
  service.createAnthropicApiKey(1, { label: 'Work', apiKey: 'sk-ant-second' });

  assert.deepEqual(created, [{ isActive: true }, { isActive: false }]);
});

test('createAnthropicApiKey rejects a third connection', () => {
  const service = createSettingsService(dependencies({
    credentials: {
      list: () => [], remove: () => false, toggle: () => false,
      listWithPreview: () => [], getMeta: () => null,
      countByType: () => 2,
      activateExclusive: () => false,
      create: () => ({ id: 3 }),
    },
  }));

  assert.throws(
    () => service.createAnthropicApiKey(1, { label: 'Third', apiKey: 'sk-ant-third' }),
    (error: any) => error.code === 'ANTHROPIC_API_KEY_LIMIT_REACHED',
  );
});

test('createAnthropicApiKey defaults the label to "Connection N" when none is given', () => {
  const labels: string[] = [];
  const service = createSettingsService(dependencies({
    credentials: {
      list: () => [], remove: () => false, toggle: () => false,
      listWithPreview: () => [], getMeta: () => null,
      countByType: () => 1,
      activateExclusive: () => false,
      create: (_userId, name) => { labels.push(name); return { id: 2 }; },
    },
  }));

  service.createAnthropicApiKey(1, { apiKey: 'sk-ant-second' });
  assert.deepEqual(labels, ['Connection 2']);
});

test('activateAnthropicApiKey switches the exclusive-active slot', () => {
  const activations: Array<{ credentialId: number; type: string }> = [];
  const service = createSettingsService(dependencies({
    credentials: {
      list: () => [], create: () => ({}), remove: () => false, toggle: () => false,
      listWithPreview: () => [],
      getMeta: (_userId, credentialId) => ({ id: credentialId, credential_type: 'anthropic_api_key', is_active: 0 }),
      countByType: () => 2,
      activateExclusive: (_userId, credentialId, type) => {
        activations.push({ credentialId, type });
        return true;
      },
    },
  }));

  service.activateAnthropicApiKey(1, 42);
  assert.deepEqual(activations, [{ credentialId: 42, type: 'anthropic_api_key' }]);
});

test('activateAnthropicApiKey rejects a credential that is not an Anthropic key', () => {
  const service = createSettingsService(dependencies({
    credentials: {
      list: () => [], create: () => ({}), remove: () => false, toggle: () => false,
      listWithPreview: () => [],
      getMeta: () => ({ id: 42, credential_type: 'github_token', is_active: 1 }),
      countByType: () => 0,
      activateExclusive: () => false,
    },
  }));

  assert.throws(
    () => service.activateAnthropicApiKey(1, 42),
    (error: any) => error.code === 'ANTHROPIC_API_KEY_NOT_FOUND',
  );
});

test('deleteAnthropicApiKey reactivates the remaining connection when the active one is removed', () => {
  const activations: number[] = [];
  const removed: number[] = [];
  const service = createSettingsService(dependencies({
    credentials: {
      list: () => [], create: () => ({}), toggle: () => false,
      getMeta: (_userId, credentialId) => ({ id: credentialId, credential_type: 'anthropic_api_key', is_active: 1 }),
      remove: (_userId, credentialId) => { removed.push(credentialId); return true; },
      listWithPreview: () => [{ id: 2, is_active: 0 }],
      countByType: () => 1,
      activateExclusive: (_userId, credentialId) => { activations.push(credentialId); return true; },
    },
  }));

  service.deleteAnthropicApiKey(1, 1);
  assert.deepEqual(removed, [1]);
  assert.deepEqual(activations, [2]);
});

test('deleteAnthropicApiKey does not touch activation when the removed connection was inactive', () => {
  const activations: number[] = [];
  const service = createSettingsService(dependencies({
    credentials: {
      list: () => [], create: () => ({}), toggle: () => false,
      getMeta: (_userId, credentialId) => ({ id: credentialId, credential_type: 'anthropic_api_key', is_active: 0 }),
      remove: () => true,
      listWithPreview: () => [{ id: 1, is_active: 1 }],
      countByType: () => 1,
      activateExclusive: (_userId, credentialId) => { activations.push(credentialId); return true; },
    },
  }));

  service.deleteAnthropicApiKey(1, 2);
  assert.deepEqual(activations, []);
});

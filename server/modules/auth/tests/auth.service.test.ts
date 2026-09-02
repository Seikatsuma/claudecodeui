import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createAuthService } from '../auth.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];

// A one-level-deeper Partial than the built-in `Partial<T>`: lets individual
// tests override just the users/transaction/rateLimiter fields they care
// about (e.g. only hasUsers/createUser) without also having to restate every
// other method on those nested dependency objects at every call site.
type TestDependencyOverrides = Partial<Omit<AuthDependencies, 'users' | 'transaction' | 'rateLimiter'>> & {
  users?: Partial<AuthDependencies['users']>;
  transaction?: Partial<AuthDependencies['transaction']>;
  rateLimiter?: Partial<AuthDependencies['rateLimiter']>;
};

function createDependencies(overrides: TestDependencyOverrides = {}): AuthDependencies {
  const { users, transaction, rateLimiter, ...restOverrides } = overrides;

  return {
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => ({ id: 1, username, password_hash: passwordHash }),
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
      // Open-registration-only methods: stubbed here so tests that replace
      // `users` wholesale (to control hasUsers/createUser/etc.) do not also
      // have to repeat these on every call site.
      createUserWithLoginToken: (username, passwordHash) => ({ id: 1, username, password_hash: passwordHash }),
      getUserByLoginToken: () => undefined,
      setLoginToken: () => undefined,
      getLoginToken: () => null,
      ...users,
    },
    transaction: {
      begin: () => undefined,
      commit: () => undefined,
      rollback: () => undefined,
      ...transaction,
    },
    rateLimiter: {
      getRetryAfterSeconds: () => 0,
      recordFailure: () => undefined,
      reset: () => undefined,
      ...rateLimiter,
    },
    hashPassword: async () => 'hashed-password',
    comparePassword: async () => false,
    generateToken: () => 'signed-token',
    generateLoginToken: () => 'login-token',
    provisionWorkspace: async () => undefined,
    openRegistration: false,
    ...restOverrides,
  };
}

test('register hashes credentials and commits through injected dependencies', async () => {
  const operations: string[] = [];
  const service = createAuthService(createDependencies({
    transaction: {
      begin: () => operations.push('begin'),
      commit: () => operations.push('commit'),
      rollback: () => operations.push('rollback'),
    },
    hashPassword: async (password) => {
      operations.push(`hash:${password}`);
      return 'hash';
    },
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => {
        operations.push(`create:${username}:${passwordHash}`);
        return { id: 1, username, password_hash: passwordHash };
      },
      getUserByUsername: () => undefined,
      updateLastLogin: (userId) => operations.push(`login:${userId}`),
    },
  }));

  const result = await service.register('alice', 'secret12');

  assert.equal(result.token, 'signed-token');
  assert.deepEqual(operations, ['begin', 'hash:secret12', 'create:alice:hash', 'commit', 'login:1']);
});

test('login rejects an invalid password without issuing a token', async () => {
  let tokenIssued = false;
  let failureRecorded: [string, string] | undefined;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: 'alice', password_hash: 'hash' }),
      updateLastLogin: () => undefined,
    },
    rateLimiter: {
      getRetryAfterSeconds: () => 0,
      recordFailure: (ip, username) => { failureRecorded = [ip, username]; },
      reset: () => undefined,
    },
    comparePassword: async () => false,
    generateToken: () => {
      tokenIssued = true;
      return 'token';
    },
  }));

  await assert.rejects(
    service.login('alice', 'wrong-password', '127.0.0.1'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
  assert.equal(tokenIssued, false);
  assert.deepEqual(failureRecorded, ['127.0.0.1', 'alice']);
});

test('login rejects with 429 once the rate limiter reports a lockout, without touching bcrypt', async () => {
  let comparePasswordCalled = false;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: 'alice', password_hash: 'hash' }),
      updateLastLogin: () => undefined,
    },
    rateLimiter: {
      getRetryAfterSeconds: () => 42,
      recordFailure: () => undefined,
      reset: () => undefined,
    },
    comparePassword: async () => {
      comparePasswordCalled = true;
      return true;
    },
  }));

  await assert.rejects(
    service.login('alice', 'whatever', '127.0.0.1'),
    (error: unknown) => (
      error instanceof AppError
      && error.code === 'AUTH_RATE_LIMITED'
      && error.statusCode === 429
      && (error.details as { retryAfterSeconds?: number })?.retryAfterSeconds === 42
    ),
  );
  assert.equal(comparePasswordCalled, false);
});

test('login resets the rate limiter for the key on success', async () => {
  let resetKey: [string, string] | undefined;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => ({ id: 1, username: 'alice', password_hash: 'hash' }),
      updateLastLogin: () => undefined,
    },
    rateLimiter: {
      getRetryAfterSeconds: () => 0,
      recordFailure: () => undefined,
      reset: (ip, username) => { resetKey = [ip, username]; },
    },
    comparePassword: async () => true,
    generateToken: () => 'token',
  }));

  await service.login('alice', 'correct-password', '127.0.0.1');

  assert.deepEqual(resetKey, ['127.0.0.1', 'alice']);
});

test('registerOpen is rejected on an instance that does not enable open registration', async () => {
  const service = createAuthService(createDependencies({ openRegistration: false }));

  await assert.rejects(
    service.registerOpen('alice'),
    (error: unknown) => error instanceof AppError && error.code === 'OPEN_REGISTRATION_DISABLED',
  );
});

test('registerOpen creates a passwordless account, provisions its workspace, and returns a login link token', async () => {
  const operations: string[] = [];
  const service = createAuthService(createDependencies({
    openRegistration: true,
    generateLoginToken: (() => {
      let call = 0;
      return () => (call++ === 0 ? 'throwaway-password' : 'the-login-token');
    })(),
    users: {
      hasUsers: () => true, // open registration ignores this - many accounts may already exist
      createUserWithLoginToken: (username, passwordHash, loginToken) => {
        operations.push(`create:${username}:${passwordHash}:${loginToken}`);
        return { id: 42, username };
      },
      updateLastLogin: (userId) => operations.push(`login:${userId}`),
    },
    provisionWorkspace: async (userId) => { operations.push(`provision:${userId}`); },
  }));

  const result = await service.registerOpen('bob');

  assert.equal(result.success, true);
  assert.equal(result.user.username, 'bob');
  assert.equal(result.loginToken, 'the-login-token');
  assert.deepEqual(operations, [
    'create:bob:hashed-password:the-login-token',
    'login:42',
    'provision:42',
  ]);
});

test('enterWithLoginToken signs a session for the token owner without a password', async () => {
  const service = createAuthService(createDependencies({
    openRegistration: true,
    users: {
      getUserByLoginToken: (token) => (token === 'valid-token' ? { id: 7, username: 'carol' } : undefined),
    },
    generateToken: (user) => `token-for-${user.username}`,
  }));

  const result = await service.enterWithLoginToken('valid-token');

  assert.equal(result.token, 'token-for-carol');
  assert.deepEqual(result.user, { id: 7, username: 'carol' });
});

test('enterWithLoginToken rejects an unknown or revoked token', async () => {
  const service = createAuthService(createDependencies({
    openRegistration: true,
    users: { getUserByLoginToken: () => undefined },
  }));

  await assert.rejects(
    service.enterWithLoginToken('does-not-exist'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_LOGIN_TOKEN_INVALID',
  );
});

test('regenerateLoginLink replaces the stored token and returns the new one', () => {
  let stored: { userId: number; token: string } | undefined;
  const service = createAuthService(createDependencies({
    openRegistration: true,
    generateLoginToken: () => 'fresh-token',
    users: {
      setLoginToken: (userId, token) => { stored = { userId, token }; },
    },
  }));

  const result = service.regenerateLoginLink({ id: 9, username: 'dave' });

  assert.equal(result.loginToken, 'fresh-token');
  assert.deepEqual(stored, { userId: 9, token: 'fresh-token' });
});

test('refreshSession issues a replacement token for the authenticated user', () => {
  let tokenUser: { id: number | bigint; username: string } | undefined;
  const service = createAuthService(createDependencies({
    generateToken: (user) => {
      tokenUser = user;
      return 'replacement-token';
    },
  }));

  const result = service.refreshSession({ id: 7, username: 'alice' });

  assert.deepEqual(result, { token: 'replacement-token' });
  assert.deepEqual(tokenUser, { id: 7, username: 'alice' });
});

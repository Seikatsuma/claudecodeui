import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createAuthService } from '../auth.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];

function createDependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => ({ id: 1, username, password_hash: passwordHash }),
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
    },
    transaction: {
      begin: () => undefined,
      commit: () => undefined,
      rollback: () => undefined,
    },
    rateLimiter: {
      getRetryAfterSeconds: () => 0,
      recordFailure: () => undefined,
      reset: () => undefined,
    },
    hashPassword: async () => 'hashed-password',
    comparePassword: async () => false,
    generateToken: () => 'signed-token',
    ...overrides,
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

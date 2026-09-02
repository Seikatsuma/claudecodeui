import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createAuthService } from '../auth.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];

// A one-level-deeper Partial than the built-in `Partial<T>`: lets individual
// tests override just the users/transaction/rateLimiter fields they care
// about (e.g. only hasUsers/createUser) without also having to restate every
// other method on those nested dependency objects at every call site.
type TestDependencyOverrides = Partial<Omit<AuthDependencies, 'users' | 'transaction' | 'rateLimiter' | 'invites'>> & {
  users?: Partial<AuthDependencies['users']>;
  transaction?: Partial<AuthDependencies['transaction']>;
  rateLimiter?: Partial<AuthDependencies['rateLimiter']>;
  invites?: Partial<AuthDependencies['invites']>;
};

// Default stand-in for an already-valid, unused invite - most registerOpen
// tests are not testing the invite gate itself, so they get a token that
// always checks out unless a test explicitly overrides `invites`.
const DEFAULT_INVITE_TOKEN = 'valid-invite-token';

function createDependencies(overrides: TestDependencyOverrides = {}): AuthDependencies {
  const { users, transaction, rateLimiter, invites, ...restOverrides } = overrides;

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
    invites: {
      createInvite: (token, createdByUserId, label) => ({
        token,
        created_by_user_id: createdByUserId,
        label,
        created_at: '2026-01-01T00:00:00.000Z',
        used_at: null,
      }),
      getInviteByToken: (token) => (
        token === DEFAULT_INVITE_TOKEN
          ? { token, label: null, created_at: '2026-01-01T00:00:00.000Z', used_at: null }
          : undefined
      ),
      claimInvite: () => true,
      listInvitesByCreator: () => [],
      ...invites,
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
    service.registerOpen('alice', DEFAULT_INVITE_TOKEN),
    (error: unknown) => error instanceof AppError && error.code === 'OPEN_REGISTRATION_DISABLED',
  );
});

test('registerOpen rejects with no invite token at all', async () => {
  const service = createAuthService(createDependencies({ openRegistration: true }));

  await assert.rejects(
    service.registerOpen('alice', ''),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVITE_REQUIRED' && error.statusCode === 400,
  );
});

test('registerOpen rejects an invite token that does not exist', async () => {
  const service = createAuthService(createDependencies({ openRegistration: true }));

  await assert.rejects(
    service.registerOpen('alice', 'no-such-token'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVITE_INVALID' && error.statusCode === 404,
  );
});

test('registerOpen rejects an invite token that was already used', async () => {
  const service = createAuthService(createDependencies({
    openRegistration: true,
    invites: {
      getInviteByToken: (token) => (
        token === 'spent-token'
          ? { token, label: null, created_at: '2026-01-01T00:00:00.000Z', used_at: '2026-01-02T00:00:00.000Z' }
          : undefined
      ),
    },
  }));

  await assert.rejects(
    service.registerOpen('alice', 'spent-token'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVITE_ALREADY_USED' && error.statusCode === 410,
  );
});

test('registerOpen creates a passwordless account, provisions its workspace, claims the invite, and returns a login link token', async () => {
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
    invites: {
      claimInvite: (token, usedByUserId) => {
        operations.push(`claim:${token}:${usedByUserId}`);
        return true;
      },
    },
    provisionWorkspace: async (userId) => { operations.push(`provision:${userId}`); },
  }));

  const result = await service.registerOpen('bob', DEFAULT_INVITE_TOKEN);

  assert.equal(result.success, true);
  assert.equal(result.user.username, 'bob');
  assert.equal(result.loginToken, 'the-login-token');
  assert.deepEqual(operations, [
    'create:bob:hashed-password:the-login-token',
    `claim:${DEFAULT_INVITE_TOKEN}:42`,
    'login:42',
    'provision:42',
  ]);
});

test('registerOpen rejects when the invite loses the race to claimInvite (double-submit)', async () => {
  const service = createAuthService(createDependencies({
    openRegistration: true,
    invites: { claimInvite: () => false },
  }));

  await assert.rejects(
    service.registerOpen('bob', DEFAULT_INVITE_TOKEN),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVITE_ALREADY_USED',
  );
});

test('createInvite mints a token for the authenticated caller and rejects an over-long label', async () => {
  const created: unknown[] = [];
  const service = createAuthService(createDependencies({
    openRegistration: true,
    generateLoginToken: () => 'fresh-invite-token',
    invites: {
      createInvite: (token, createdByUserId, label) => {
        created.push({ token, createdByUserId, label });
        return { token, label, created_at: '2026-01-01T00:00:00.000Z', used_at: null };
      },
    },
  }));

  const result = service.createInvite({ id: 3, username: 'alice' }, 'for Ivanov');
  assert.equal(result.success, true);
  assert.deepEqual(result.invite, {
    token: 'fresh-invite-token',
    label: 'for Ivanov',
    createdAt: '2026-01-01T00:00:00.000Z',
    usedAt: null,
    usedByUsername: null,
  });
  assert.deepEqual(created, [{ token: 'fresh-invite-token', createdByUserId: 3, label: 'for Ivanov' }]);

  assert.throws(
    () => service.createInvite({ id: 3, username: 'alice' }, 'x'.repeat(201)),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVITE_LABEL_TOO_LONG',
  );
});

test('getInviteStatus reports valid for an unused token and invalid for unknown/used ones', () => {
  const service = createAuthService(createDependencies({
    openRegistration: true,
    invites: {
      getInviteByToken: (token) => {
        if (token === 'unused') return { token, label: 'note', created_at: 'x', used_at: null };
        if (token === 'used') return { token, label: null, created_at: 'x', used_at: 'y' };
        return undefined;
      },
    },
  }));

  assert.deepEqual(service.getInviteStatus('unused'), { valid: true, label: 'note' });
  assert.deepEqual(service.getInviteStatus('used'), { valid: false, label: null });
  assert.deepEqual(service.getInviteStatus('missing'), { valid: false, label: null });
  assert.deepEqual(service.getInviteStatus(''), { valid: false, label: null });
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

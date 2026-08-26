import assert from 'node:assert/strict';
import test from 'node:test';

import { createLoginRateLimiter } from '../login-rate-limiter.js';

test('allows attempts under the configured max and blocks once the max is reached', () => {
  const limiter = createLoginRateLimiter({ windowMs: 60_000, maxAttempts: 3 });

  assert.equal(limiter.getRetryAfterSeconds('1.2.3.4', 'alice'), 0);
  limiter.recordFailure('1.2.3.4', 'alice');
  assert.equal(limiter.getRetryAfterSeconds('1.2.3.4', 'alice'), 0);
  limiter.recordFailure('1.2.3.4', 'alice');
  assert.equal(limiter.getRetryAfterSeconds('1.2.3.4', 'alice'), 0);
  limiter.recordFailure('1.2.3.4', 'alice');

  const retryAfter = limiter.getRetryAfterSeconds('1.2.3.4', 'alice');
  assert.ok(retryAfter > 0 && retryAfter <= 60, `expected 0 < retryAfter <= 60, got ${retryAfter}`);

  limiter.stop();
});

test('keys are scoped per IP + username (case-insensitive username), not shared globally', () => {
  const limiter = createLoginRateLimiter({ windowMs: 60_000, maxAttempts: 1 });

  limiter.recordFailure('1.2.3.4', 'alice');
  assert.ok(limiter.getRetryAfterSeconds('1.2.3.4', 'alice') > 0);
  // Same username, different IP: not blocked.
  assert.equal(limiter.getRetryAfterSeconds('9.9.9.9', 'alice'), 0);
  // Same IP, different username: not blocked.
  assert.equal(limiter.getRetryAfterSeconds('1.2.3.4', 'bob'), 0);
  // Same IP + username, different case: still blocked (case-insensitive key).
  assert.ok(limiter.getRetryAfterSeconds('1.2.3.4', 'ALICE') > 0);

  limiter.stop();
});

test('reset clears a lockout immediately (successful login unblocks the key)', () => {
  const limiter = createLoginRateLimiter({ windowMs: 60_000, maxAttempts: 1 });

  limiter.recordFailure('1.2.3.4', 'alice');
  assert.ok(limiter.getRetryAfterSeconds('1.2.3.4', 'alice') > 0);

  limiter.reset('1.2.3.4', 'alice');
  assert.equal(limiter.getRetryAfterSeconds('1.2.3.4', 'alice'), 0);

  limiter.stop();
});

test('lockout expires on its own once the window elapses', async () => {
  const limiter = createLoginRateLimiter({ windowMs: 50, maxAttempts: 1 });

  limiter.recordFailure('1.2.3.4', 'alice');
  assert.ok(limiter.getRetryAfterSeconds('1.2.3.4', 'alice') > 0);

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(limiter.getRetryAfterSeconds('1.2.3.4', 'alice'), 0);

  limiter.stop();
});

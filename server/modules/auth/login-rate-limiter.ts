/**
 * In-memory login rate limiter.
 *
 * Tracks failed login attempts per (IP + username) key to slow down
 * brute-force / credential-stuffing attempts against the login endpoint.
 * State is process-local and intentionally not persisted to the database:
 * a server restart clears all lockouts, which is an acceptable trade-off
 * for a personal, single-instance deployment and keeps this dependency-free.
 */

const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_MAX_ATTEMPTS = 5;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // periodic cleanup of stale entries

type Attempt = {
  count: number;
  firstAttemptAt: number;
};

export type LoginRateLimiter = ReturnType<typeof createLoginRateLimiter>;

/**
 * Creates a login rate limiter. Used by `auth.module.ts` to build the
 * `rateLimiter` dependency injected into `createAuthService`, which guards
 * `POST /api/auth/login` against brute-force credential guessing.
 * `windowMs`/`maxAttempts` are overridable for tests; production code should
 * use the defaults (5 attempts / 15 minutes).
 */
export function createLoginRateLimiter(
  options: { windowMs?: number; maxAttempts?: number } = {},
) {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const attempts = new Map<string, Attempt>();

  function makeKey(ip: string, username: string): string {
    return `${ip}:${username.toLowerCase()}`;
  }

  function sweep(now: number): void {
    for (const [key, attempt] of attempts) {
      if (now - attempt.firstAttemptAt > windowMs) {
        attempts.delete(key);
      }
    }
  }

  // Periodic cleanup so memory does not grow unbounded from scanners trying
  // many usernames. unref() keeps this timer from holding the process (or
  // test runner) open.
  const sweepTimer = setInterval(() => sweep(Date.now()), SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  return {
    /** Returns remaining lockout seconds for the key, or 0 if not blocked. */
    getRetryAfterSeconds(ip: string, username: string): number {
      const key = makeKey(ip, username);
      const attempt = attempts.get(key);
      if (!attempt) return 0;

      const now = Date.now();
      const elapsed = now - attempt.firstAttemptAt;
      if (elapsed > windowMs) {
        attempts.delete(key);
        return 0;
      }
      if (attempt.count < maxAttempts) return 0;

      return Math.ceil((windowMs - elapsed) / 1000);
    },

    /** Records a failed login attempt for the key. */
    recordFailure(ip: string, username: string): void {
      const key = makeKey(ip, username);
      const now = Date.now();
      const attempt = attempts.get(key);
      if (!attempt || now - attempt.firstAttemptAt > windowMs) {
        attempts.set(key, { count: 1, firstAttemptAt: now });
        return;
      }
      attempt.count += 1;
    },

    /** Clears any recorded failures for the key (call on successful login). */
    reset(ip: string, username: string): void {
      attempts.delete(makeKey(ip, username));
    },

    /** Stops the background sweep timer (tests / graceful shutdown). */
    stop(): void {
      clearInterval(sweepTimer);
    },
  };
}

import { AppError } from '@/shared/utils.js';

type AuthUser = {
  id: number | bigint;
  username: string;
};

type AuthLoginUser = AuthUser & { password_hash: string };

type InviteRecord = {
  token: string;
  label: string | null;
  created_at: string;
  used_at: string | null;
  used_by_username?: string | null;
};

type AuthDependencies = {
  users: {
    hasUsers(): boolean;
    createUser(username: string, passwordHash: string): AuthUser;
    getUserByUsername(username: string): AuthLoginUser | undefined;
    updateLastLogin(userId: number): void;
    createUserWithLoginToken(username: string, passwordHash: string, loginToken: string): AuthUser;
    getUserByLoginToken(loginToken: string): AuthUser | undefined;
    setLoginToken(userId: number, loginToken: string): void;
    getLoginToken(userId: number): string | null;
  };
  /**
   * Invite-only registration gate (OPEN_REGISTRATION instances only - see
   * `openRegistration` below). Any logged-in user can mint a token; only
   * `registerOpen()` below consumes one, exactly once, via `claimInvite()`.
   */
  invites: {
    createInvite(token: string, createdByUserId: number, label: string | null): InviteRecord;
    getInviteByToken(token: string): InviteRecord | undefined;
    /** Atomically marks the token used iff it was still unused. See repository docstring. */
    claimInvite(token: string, usedByUserId: number): boolean;
    listInvitesByCreator(createdByUserId: number): InviteRecord[];
  };
  transaction: {
    begin(): void;
    commit(): void;
    rollback(): void;
  };
  // Brute-force guard for `login`, keyed by caller IP + username. Injected
  // so the service stays unit-testable without a real clock/timer.
  rateLimiter: {
    getRetryAfterSeconds(ip: string, username: string): number;
    recordFailure(ip: string, username: string): void;
    reset(ip: string, username: string): void;
  };
  hashPassword(password: string): Promise<string>;
  comparePassword(password: string, passwordHash: string): Promise<boolean>;
  generateToken(user: AuthUser): string;
  /** Generates a persistent, unguessable login-link token (see auth.module.ts). */
  generateLoginToken(): string;
  /**
   * Creates this brand-new user's isolated workspace (their own
   * CLAUDE_CONFIG_DIR + project browsing root - see web-user-paths.ts).
   * Only ever called from registerOpen(); a no-op function is injected on
   * installs that never enable open registration.
   */
  provisionWorkspace(userId: number): Promise<void>;
  /**
   * Gates the whole open-registration/magic-link surface. False on every
   * install that does not explicitly set OPEN_REGISTRATION=true (Account 1/2
   * included) - register()/login() below are completely unaffected by it.
   */
  openRegistration: boolean;
};

function numericUserId(userId: number | bigint): number {
  return Number(userId);
}

/** Narrows an `authenticateToken`-populated `req.user` value, or throws. */
function requireAuthenticatedUser(user: unknown): AuthUser {
  if (
    typeof user !== 'object'
    || user === null
    || !('id' in user)
    || !('username' in user)
    || (typeof (user as { id: unknown }).id !== 'number' && typeof (user as { id: unknown }).id !== 'bigint')
    || typeof (user as { username: unknown }).username !== 'string'
  ) {
    throw new AppError('Authenticated user is required', {
      code: 'AUTH_USER_REQUIRED',
      statusCode: 401,
    });
  }

  return user as AuthUser;
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/** Shapes a DB invite record (snake_case) into the camelCase wire format. */
function formatInvite(invite: InviteRecord) {
  return {
    token: invite.token,
    label: invite.label,
    createdAt: invite.created_at,
    usedAt: invite.used_at,
    usedByUsername: invite.used_by_username ?? null,
  };
}

// Shown to a visitor whose token does not exist or was already redeemed.
// Deliberately identical text for both cases (see auth.routes.ts /invite
// endpoints) - and deliberately distinct from AUTH_LOGIN_TOKEN_INVALID's
// "session expired"-flavored copy, since these are different situations.
const INVITE_INVALID_MESSAGE = 'This invitation link is no longer valid.';

/**
 * Creates the Auth application service around explicit persistence, crypto,
 * transaction, and token dependencies.
 */
export function createAuthService(dependencies: AuthDependencies) {
  return {
    getStatus() {
      return {
        // Outside OPEN_REGISTRATION, this is the original single-user gate:
        // the setup screen only ever shows once, before the first (and only)
        // account exists. On an open-registration instance there is no such
        // thing as "already set up" - any number of independent accounts can
        // register - so the frontend uses `openRegistration` instead of this
        // flag to decide which auth screen to render.
        needsSetup: !dependencies.openRegistration && !dependencies.users.hasUsers(),
        isAuthenticated: false,
        openRegistration: dependencies.openRegistration,
      };
    },

    async register(usernameInput: unknown, passwordInput: unknown) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';

      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }
      if (username.length < 3 || password.length < 6) {
        throw new AppError(
          'Username must be at least 3 characters, password at least 6 characters',
          { code: 'AUTH_CREDENTIALS_TOO_SHORT', statusCode: 400 },
        );
      }

      dependencies.transaction.begin();
      try {
        if (!dependencies.openRegistration && dependencies.users.hasUsers()) {
          throw new AppError('User already exists. This is a single-user system.', {
            code: 'AUTH_USER_ALREADY_CONFIGURED',
            statusCode: 403,
          });
        }

        const passwordHash = await dependencies.hashPassword(password);
        const user = dependencies.users.createUser(username, passwordHash);
        const token = dependencies.generateToken(user);
        dependencies.transaction.commit();
        dependencies.users.updateLastLogin(numericUserId(user.id));

        return {
          success: true,
          user: { id: user.id, username: user.username },
          token,
        };
      } catch (error) {
        dependencies.transaction.rollback();
        if (isUniqueConstraintError(error)) {
          throw new AppError('Username already exists', {
            code: 'AUTH_USERNAME_CONFLICT',
            statusCode: 409,
          });
        }
        throw error;
      }
    },

    /**
     * Invite-gated self-service registration: no password, and no account can
     * be created without a valid, unused invite token minted by an existing
     * user (see createInvite() below) - the bare `/register-open` surface
     * with no token is refused just like an unknown one. A random,
     * never-shown password hash still fills the NOT NULL password_hash
     * column (password login stays technically possible but is never
     * offered by the UI in this mode); the account's real credential is the
     * persistent login-link token returned here for one-time display by the
     * caller.
     */
    async registerOpen(usernameInput: unknown, inviteTokenInput: unknown) {
      if (!dependencies.openRegistration) {
        throw new AppError('Open registration is not enabled on this instance', {
          code: 'OPEN_REGISTRATION_DISABLED',
          statusCode: 403,
        });
      }

      const inviteToken = typeof inviteTokenInput === 'string' ? inviteTokenInput.trim() : '';
      if (!inviteToken) {
        throw new AppError('An invitation link is required to create an account.', {
          code: 'AUTH_INVITE_REQUIRED',
          statusCode: 400,
        });
      }

      // Fail fast on an obviously bad/used token before doing any hashing or
      // touching the users table. The real, race-safe guarantee that a token
      // is spent at most once is the claimInvite() call further down, inside
      // the same transaction as user creation - this check only exists to
      // give a normal (non-racing) caller a clean rejection early.
      const precheckInvite = dependencies.invites.getInviteByToken(inviteToken);
      if (!precheckInvite) {
        throw new AppError(INVITE_INVALID_MESSAGE, { code: 'AUTH_INVITE_INVALID', statusCode: 404 });
      }
      if (precheckInvite.used_at) {
        throw new AppError(INVITE_INVALID_MESSAGE, { code: 'AUTH_INVITE_ALREADY_USED', statusCode: 410 });
      }

      const trimmedUsername = typeof usernameInput === 'string' ? usernameInput.trim() : '';
      const username = trimmedUsername.length >= 3
        ? trimmedUsername
        : `user-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

      dependencies.transaction.begin();
      try {
        const randomPassword = dependencies.generateLoginToken();
        const passwordHash = await dependencies.hashPassword(randomPassword);
        const loginToken = dependencies.generateLoginToken();
        const user = dependencies.users.createUserWithLoginToken(username, passwordHash, loginToken);

        // The actual single-use guarantee: this UPDATE only succeeds if the
        // token was still unused at this exact moment, so two registrations
        // racing on the same token can never both pass.
        const claimed = dependencies.invites.claimInvite(inviteToken, numericUserId(user.id));
        if (!claimed) {
          throw new AppError(INVITE_INVALID_MESSAGE, { code: 'AUTH_INVITE_ALREADY_USED', statusCode: 410 });
        }

        const token = dependencies.generateToken(user);
        dependencies.transaction.commit();
        dependencies.users.updateLastLogin(numericUserId(user.id));
        await dependencies.provisionWorkspace(numericUserId(user.id));

        return {
          success: true,
          user: { id: user.id, username: user.username },
          token,
          loginToken,
        };
      } catch (error) {
        dependencies.transaction.rollback();
        if (isUniqueConstraintError(error)) {
          throw new AppError('Username already exists', {
            code: 'AUTH_USERNAME_CONFLICT',
            statusCode: 409,
          });
        }
        throw error;
      }
    },

    /**
     * Mints a fresh, unused invite token owned by the caller. Any logged-in
     * user on an OPEN_REGISTRATION instance can do this - there is no
     * separate "admin" role (see auth.routes.ts).
     */
    createInvite(user: unknown, labelInput: unknown) {
      if (!dependencies.openRegistration) {
        throw new AppError('Open registration is not enabled on this instance', {
          code: 'OPEN_REGISTRATION_DISABLED',
          statusCode: 403,
        });
      }

      const userId = numericUserId(requireAuthenticatedUser(user).id);

      const trimmedLabel = typeof labelInput === 'string' ? labelInput.trim() : '';
      if (trimmedLabel.length > 200) {
        throw new AppError('Label is too long (200 characters max).', {
          code: 'AUTH_INVITE_LABEL_TOO_LONG',
          statusCode: 400,
        });
      }

      const token = dependencies.generateLoginToken();
      const invite = dependencies.invites.createInvite(token, userId, trimmedLabel || null);

      return { success: true, invite: formatInvite(invite) };
    },

    /** Lists every invite the caller has created, most recent first. */
    listInvites(user: unknown) {
      if (!dependencies.openRegistration) {
        throw new AppError('Open registration is not enabled on this instance', {
          code: 'OPEN_REGISTRATION_DISABLED',
          statusCode: 403,
        });
      }

      const userId = numericUserId(requireAuthenticatedUser(user).id);
      return { invites: dependencies.invites.listInvitesByCreator(userId).map(formatInvite) };
    },

    /**
     * Public check used by the `/invite/<token>` screen before it shows the
     * registration form, so an unknown or already-used link renders a clear
     * message immediately instead of only failing on submit.
     */
    getInviteStatus(tokenInput: unknown) {
      if (!dependencies.openRegistration) {
        throw new AppError('Open registration is not enabled on this instance', {
          code: 'OPEN_REGISTRATION_DISABLED',
          statusCode: 403,
        });
      }

      const token = typeof tokenInput === 'string' ? tokenInput.trim() : '';
      if (!token) {
        return { valid: false, label: null };
      }

      const invite = dependencies.invites.getInviteByToken(token);
      if (!invite || invite.used_at) {
        return { valid: false, label: null };
      }

      return { valid: true, label: invite.label };
    },

    /** Instant login via a previously issued persistent login-link token. */
    async enterWithLoginToken(tokenInput: unknown) {
      if (!dependencies.openRegistration) {
        throw new AppError('Open registration is not enabled on this instance', {
          code: 'OPEN_REGISTRATION_DISABLED',
          statusCode: 403,
        });
      }

      const loginTokenValue = typeof tokenInput === 'string' ? tokenInput.trim() : '';
      if (!loginTokenValue) {
        throw new AppError('Login link token is required', {
          code: 'AUTH_LOGIN_TOKEN_REQUIRED',
          statusCode: 400,
        });
      }

      const user = dependencies.users.getUserByLoginToken(loginTokenValue);
      if (!user) {
        throw new AppError('This login link is invalid or no longer works.', {
          code: 'AUTH_LOGIN_TOKEN_INVALID',
          statusCode: 401,
        });
      }

      dependencies.users.updateLastLogin(numericUserId(user.id));
      return {
        success: true,
        user: { id: user.id, username: user.username },
        token: dependencies.generateToken(user),
      };
    },

    /** Returns the caller's current login-link token so Settings can show/copy it again. */
    getLoginLink(user: unknown) {
      if (!dependencies.openRegistration) {
        throw new AppError('Open registration is not enabled on this instance', {
          code: 'OPEN_REGISTRATION_DISABLED',
          statusCode: 403,
        });
      }

      const userId = numericUserId(requireAuthenticatedUser(user).id);
      return { loginToken: dependencies.users.getLoginToken(userId) };
    },

    /** Issues a brand-new login-link token, invalidating the previous one. */
    regenerateLoginLink(user: unknown) {
      if (!dependencies.openRegistration) {
        throw new AppError('Open registration is not enabled on this instance', {
          code: 'OPEN_REGISTRATION_DISABLED',
          statusCode: 403,
        });
      }

      const userId = numericUserId(requireAuthenticatedUser(user).id);
      const loginToken = dependencies.generateLoginToken();
      dependencies.users.setLoginToken(userId, loginToken);
      return { loginToken };
    },

    async login(usernameInput: unknown, passwordInput: unknown, ip: string) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }

      // Checked before touching the DB/bcrypt so a locked-out caller cannot
      // use the login endpoint to keep burning CPU on hash comparisons.
      const retryAfterSeconds = dependencies.rateLimiter.getRetryAfterSeconds(ip, username);
      if (retryAfterSeconds > 0) {
        throw new AppError('Too many failed login attempts. Please try again later.', {
          code: 'AUTH_RATE_LIMITED',
          statusCode: 429,
          details: { retryAfterSeconds },
        });
      }

      const user = dependencies.users.getUserByUsername(username);
      const validPassword = user
        ? await dependencies.comparePassword(password, user.password_hash)
        : false;
      if (!user || !validPassword) {
        dependencies.rateLimiter.recordFailure(ip, username);
        throw new AppError('Invalid username or password', {
          code: 'AUTH_INVALID_CREDENTIALS',
          statusCode: 401,
        });
      }

      dependencies.rateLimiter.reset(ip, username);
      dependencies.users.updateLastLogin(numericUserId(user.id));
      return {
        success: true,
        user: { id: user.id, username: user.username },
        token: dependencies.generateToken(user),
      };
    },

    getCurrentUser(user: unknown) {
      return { user };
    },

    refreshSession(user: unknown) {
      return { token: dependencies.generateToken(requireAuthenticatedUser(user)) };
    },

    logout() {
      return { success: true, message: 'Logged out successfully' };
    },
  };
}

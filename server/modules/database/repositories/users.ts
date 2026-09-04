/**
 * User repository.
 *
 * Provides typed CRUD operations for the `users` table.
 * This is a single-user system, but the schema supports multiple
 * users for forward compatibility.
 */

import { getConnection } from '@/modules/database/connection.js';

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
  last_login: string | null;
  is_active: number;
  git_name: string | null;
  git_email: string | null;
  has_completed_onboarding: number;
};

type UserPublicRow = Pick<UserRow, 'id' | 'username' | 'created_at' | 'last_login'>;

type UserGitConfig = {
  git_name: string | null;
  git_email: string | null;
};

type CreateUserResult = {
  id: number | bigint;
  username: string;
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const userDb = {
  /** Returns true if at least one user exists in the database. */
  hasUsers(): boolean {
    const db = getConnection();
    const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as {
      count: number;
    };
    return row.count > 0;
  },

  /** Inserts a new user and returns the created ID + username. */
  createUser(username: string, passwordHash: string): CreateUserResult {
    const db = getConnection();
    const result = db
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(username, passwordHash);
    return { id: result.lastInsertRowid, username };
  },

  /**
   * Looks up an active user by username.
   * Returns the full row (including password hash) for auth verification.
   */
  getUserByUsername(username: string): UserRow | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT * FROM users WHERE username = ? AND is_active = 1')
      .get(username) as UserRow | undefined;
  },

  /** Updates the last_login timestamp. Non-fatal — logs but does not throw. */
  updateLastLogin(userId: number): void {
    try {
      const db = getConnection();
      db.prepare(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to update last login', { error: message });
    }
  },

  /** Returns public user fields by ID (no password hash). */
  getUserById(userId: number): UserPublicRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        'SELECT id, username, created_at, last_login FROM users WHERE id = ? AND is_active = 1'
      )
      .get(userId) as UserPublicRow | undefined;
  },

  /** Returns the first active user. Used for single-user mode lookups. */
  getFirstUser(): UserPublicRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        'SELECT id, username, created_at, last_login FROM users WHERE is_active = 1 LIMIT 1'
      )
      .get() as UserPublicRow | undefined;
  },

  /** Stores the user's preferred git name and email. */
  updateGitConfig(
    userId: number,
    gitName: string,
    gitEmail: string
  ): void {
    const db = getConnection();
    db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?').run(
      gitName,
      gitEmail,
      userId
    );
  },

  /** Retrieves the user's git identity (name + email). */
  getGitConfig(userId: number): UserGitConfig | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT git_name, git_email FROM users WHERE id = ?')
      .get(userId) as UserGitConfig | undefined;
  },

  /** Marks onboarding as complete for the given user. */
  completeOnboarding(userId: number): void {
    const db = getConnection();
    db.prepare(
      'UPDATE users SET has_completed_onboarding = 1 WHERE id = ?'
    ).run(userId);
  },

  /** Returns true if the user has finished the onboarding flow. */
  hasCompletedOnboarding(userId: number): boolean {
    const db = getConnection();
    const row = db
      .prepare('SELECT has_completed_onboarding FROM users WHERE id = ?')
      .get(userId) as { has_completed_onboarding: number } | undefined;
    return row?.has_completed_onboarding === 1;
  },

  // -------------------------------------------------------------------------
  // OPEN_REGISTRATION magic-link support (see server/modules/auth/auth.service.ts).
  // Unused on installs that never set OPEN_REGISTRATION=true - every row's
  // login_token stays NULL there, exactly like today.
  // -------------------------------------------------------------------------

  /** Inserts a new user with a password hash AND a persistent login-link token. */
  createUserWithLoginToken(
    username: string,
    passwordHash: string,
    loginToken: string
  ): CreateUserResult {
    const db = getConnection();
    const result = db
      .prepare('INSERT INTO users (username, password_hash, login_token) VALUES (?, ?, ?)')
      .run(username, passwordHash, loginToken);
    return { id: result.lastInsertRowid, username };
  },

  /** Looks up an active user by their persistent login-link token. */
  getUserByLoginToken(loginToken: string): UserRow | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT * FROM users WHERE login_token = ? AND is_active = 1')
      .get(loginToken) as UserRow | undefined;
  },

  /** Replaces a user's login-link token (used to invalidate a leaked link). */
  setLoginToken(userId: number, loginToken: string): void {
    const db = getConnection();
    db.prepare('UPDATE users SET login_token = ? WHERE id = ?').run(loginToken, userId);
  },

  /** Returns the user's current login-link token, or null if none is set. */
  getLoginToken(userId: number): string | null {
    const db = getConnection();
    const row = db
      .prepare('SELECT login_token FROM users WHERE id = ?')
      .get(userId) as { login_token: string | null } | undefined;
    return row?.login_token ?? null;
  },

  // -------------------------------------------------------------------------
  // Platform-owner account slot (see PLATFORM_OWNER_WEB_USER_IDS in utils.ts).
  // Only meaningful for the platform owner who has symlinked multiple
  // ~/.claude-webuser-<id>-account* directories. Ignored for all other users.
  // -------------------------------------------------------------------------

  /** Returns which Claude OAuth slot (1 or 2) the platform owner is using. Defaults to 1. */
  getActiveOwnerAccountSlot(userId: number): number {
    const db = getConnection();
    const row = db
      .prepare('SELECT active_owner_account_slot FROM users WHERE id = ?')
      .get(userId) as { active_owner_account_slot: number } | undefined;
    return row?.active_owner_account_slot ?? 1;
  },

  /** Persists the platform owner's chosen account slot (1 or 2). */
  setActiveOwnerAccountSlot(userId: number, slot: number): void {
    const db = getConnection();
    db.prepare('UPDATE users SET active_owner_account_slot = ? WHERE id = ?').run(slot, userId);
  },
};

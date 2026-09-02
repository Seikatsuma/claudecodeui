/**
 * User credentials repository.
 *
 * Manages external service tokens (GitHub, GitLab, Bitbucket, etc.)
 * stored per-user. Each credential has a type discriminator so multiple
 * credential kinds can coexist in the same table.
 */

import { getConnection } from '@/modules/database/connection.js';
import type {
  CreateCredentialResult,
  CredentialMetaRow,
  CredentialPreviewRow,
  CredentialPublicRow,
} from '@/shared/types.js';

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const credentialsDb = {
  /**
   * Stores a new credential and returns a safe (no raw value) result.
   * `isActive` defaults to true (matching the column's own DEFAULT 1), so
   * every existing call site that doesn't pass it keeps behaving exactly as
   * before. Callers that manage an exclusive-active slot per type (see
   * `activateCredentialExclusive`) pass `false` for a newly added row that
   * should not immediately displace the current active one.
   */
  createCredential(
    userId: number,
    credentialName: string,
    credentialType: string,
    credentialValue: string,
    description: string | null = null,
    isActive: boolean = true
  ): CreateCredentialResult {
    const db = getConnection();
    const result = db
      .prepare(
        'INSERT INTO user_credentials (user_id, credential_name, credential_type, credential_value, description, is_active) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(userId, credentialName, credentialType, credentialValue, description, isActive ? 1 : 0);
    return {
      id: result.lastInsertRowid,
      credentialName,
      credentialType,
    };
  },

  /** Counts a user's credentials of a given type - used to enforce per-type caps. */
  countCredentialsByType(userId: number, credentialType: string): number {
    const db = getConnection();
    const row = db
      .prepare(
        'SELECT COUNT(*) as count FROM user_credentials WHERE user_id = ? AND credential_type = ?'
      )
      .get(userId, credentialType) as { count: number };
    return row.count;
  },

  /**
   * Lists credentials for a user of one type, each with a masked preview of
   * the value (first 10 characters + ellipsis) instead of the value itself -
   * the same truncation `listApiKeys` already applies to app API keys. Never
   * returns the full secret.
   */
  getCredentialsWithPreview(userId: number, credentialType: string): CredentialPreviewRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        'SELECT id, credential_name, credential_type, description, created_at, is_active, credential_value FROM user_credentials WHERE user_id = ? AND credential_type = ? ORDER BY created_at ASC'
      )
      .all(userId, credentialType) as (CredentialPublicRow & { credential_value: string })[];
    return rows.map(({ credential_value, ...row }) => ({
      ...row,
      value_preview: `${credential_value.slice(0, 10)}...`,
    }));
  },

  /** Ownership + business-rule metadata for one credential row (no secret value). */
  getCredentialMeta(userId: number, credentialId: number): CredentialMetaRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        'SELECT id, credential_type, is_active FROM user_credentials WHERE id = ? AND user_id = ?'
      )
      .get(credentialId, userId) as CredentialMetaRow | undefined;
    return row ?? null;
  },

  /**
   * Activates exactly one credential of a type for a user, deactivating every
   * other credential of that same type/user in the same transaction. This is
   * how an exclusive-active-slot invariant (e.g. "exactly one Anthropic API
   * key active at a time") is enforced regardless of how many rows of that
   * type exist. Returns false if the target row doesn't exist / isn't owned
   * by this user / isn't of the expected type.
   */
  activateCredentialExclusive(
    userId: number,
    credentialId: number,
    credentialType: string
  ): boolean {
    const db = getConnection();
    const target = db
      .prepare(
        'SELECT id FROM user_credentials WHERE id = ? AND user_id = ? AND credential_type = ?'
      )
      .get(credentialId, userId, credentialType);
    if (!target) return false;

    const activateExclusive = db.transaction(() => {
      db.prepare(
        'UPDATE user_credentials SET is_active = 0 WHERE user_id = ? AND credential_type = ?'
      ).run(userId, credentialType);
      db.prepare('UPDATE user_credentials SET is_active = 1 WHERE id = ?').run(credentialId);
    });
    activateExclusive();
    return true;
  },

  /**
   * Lists credentials for a user (excluding raw values).
   * Optionally filters by credential type (e.g. 'github_token').
   */
  getCredentials(
    userId: number,
    credentialType: string | null = null
  ): CredentialPublicRow[] {
    const db = getConnection();

    if (credentialType) {
      return db
        .prepare(
          'SELECT id, credential_name, credential_type, description, created_at, is_active FROM user_credentials WHERE user_id = ? AND credential_type = ? ORDER BY created_at DESC'
        )
        .all(userId, credentialType) as CredentialPublicRow[];
    }

    return db
      .prepare(
        'SELECT id, credential_name, credential_type, description, created_at, is_active FROM user_credentials WHERE user_id = ? ORDER BY created_at DESC'
      )
      .all(userId) as CredentialPublicRow[];
  },

  /**
   * Returns the raw credential value for the most recent active
   * credential of the given type, or null if none exists.
   */
  getActiveCredential(
    userId: number,
    credentialType: string
  ): string | null {
    const db = getConnection();
    const row = db
      .prepare(
        'SELECT credential_value FROM user_credentials WHERE user_id = ? AND credential_type = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1'
      )
      .get(userId, credentialType) as { credential_value: string } | undefined;
    return row?.credential_value ?? null;
  },

  /** Permanently removes a credential. Returns true if a row was deleted. */
  deleteCredential(userId: number, credentialId: number): boolean {
    const db = getConnection();
    const result = db
      .prepare('DELETE FROM user_credentials WHERE id = ? AND user_id = ?')
      .run(credentialId, userId);
    return result.changes > 0;
  },

  /** Enables or disables a credential without deleting it. */
  toggleCredential(
    userId: number,
    credentialId: number,
    isActive: boolean
  ): boolean {
    const db = getConnection();
    const result = db
      .prepare(
        'UPDATE user_credentials SET is_active = ? WHERE id = ? AND user_id = ?'
      )
      .run(isActive ? 1 : 0, credentialId, userId);
    return result.changes > 0;
  },
};

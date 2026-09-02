/**
 * Invite tokens repository.
 *
 * Backs the invite-only registration gate on OPEN_REGISTRATION instances:
 * any logged-in user can mint a token from Settings, and only someone
 * holding that exact `/invite/<token>` link can create an account. Each
 * token is single-use - see `claimInvite()`, which atomically enforces that
 * at the SQL layer rather than relying on an earlier read-then-write check.
 */

import { getConnection } from '@/modules/database/connection.js';

type InviteRow = {
  token: string;
  created_by_user_id: number;
  label: string | null;
  created_at: string;
  used_at: string | null;
  used_by_user_id: number | null;
};

type InviteListRow = InviteRow & { used_by_username: string | null };

export const invitesDb = {
  /** Inserts a new, unused invite token owned by the given user. */
  createInvite(token: string, createdByUserId: number, label: string | null): InviteRow {
    const db = getConnection();
    db.prepare(
      'INSERT INTO invite_tokens (token, created_by_user_id, label) VALUES (?, ?, ?)'
    ).run(token, createdByUserId, label);
    return {
      token,
      created_by_user_id: createdByUserId,
      label,
      created_at: new Date().toISOString(),
      used_at: null,
      used_by_user_id: null,
    };
  },

  /** Looks up an invite by its token, regardless of used/unused state. */
  getInviteByToken(token: string): InviteRow | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT * FROM invite_tokens WHERE token = ?')
      .get(token) as InviteRow | undefined;
  },

  /**
   * Marks an invite used by the given user, but only if it is still unused.
   * The `used_at IS NULL` guard makes this a single atomic check-and-set, so
   * two near-simultaneous registrations through the same token can never
   * both succeed - the second call's `changes` count comes back 0. Returns
   * true iff this call is the one that claimed the token.
   */
  claimInvite(token: string, usedByUserId: number): boolean {
    const db = getConnection();
    const result = db
      .prepare(
        'UPDATE invite_tokens SET used_at = CURRENT_TIMESTAMP, used_by_user_id = ? WHERE token = ? AND used_at IS NULL'
      )
      .run(usedByUserId, token);
    return result.changes > 0;
  },

  /** Lists every invite a user has created, most recent first, with the claimer's username if used. */
  listInvitesByCreator(createdByUserId: number): InviteListRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT it.*, u.username AS used_by_username
         FROM invite_tokens it
         LEFT JOIN users u ON u.id = it.used_by_user_id
         WHERE it.created_by_user_id = ?
         ORDER BY it.created_at DESC`
      )
      .all(createdByUserId) as InviteListRow[];
  },
};

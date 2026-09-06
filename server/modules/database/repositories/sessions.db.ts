import { getConnection } from '@/modules/database/connection.js';
import { appConfigDb } from '@/modules/database/repositories/app-config.js';
import { getActiveAccountDir, type SessionOrigin } from '@/shared/session-scope.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import type { SessionTitleSource } from '@/shared/types.js';
import { normalizeProjectPath } from '@/shared/utils.js';

const TITLE_SOURCE_RANK: Record<SessionTitleSource, number> = {
  naive: 0,
  ai: 1,
  custom: 2,
};

type SessionRow = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  project_path: string | null;
  jsonl_path: string | null;
  custom_name: string | null;
  title_source: SessionTitleSource;
  /** Model this session runs with; NULL until the app records one for it. */
  model: string | null;
  /** Reasoning effort this session runs with; NULL until the app records one. */
  effort: string | null;
  /** Topic group this session was placed in (manual or auto); NULL = ungrouped. */
  group_id: string | null;
  group_label: string | null;
  isArchived: number;
  created_at: string;
  updated_at: string;
};

type RecentSessionsPage = {
  sessions: SessionRow[];
  total: number;
};

const SESSION_ROW_COLUMNS =
  'session_id, provider, provider_session_id, project_path, jsonl_path, custom_name, title_source, model, effort, group_id, group_label, isArchived, created_at, updated_at';

/**
 * Decides whether a freshly-derived title candidate should replace the
 * row's current one, based on provenance tier rather than presence alone.
 *
 * Ties at the 'ai' or 'custom' tier resolve in the candidate's favor: both
 * mean "a real title was just re-read off disk", and the disk copy is the
 * source of truth, so the freshest read wins. A tie at the 'naive' tier (or
 * no existing name at all) also takes the candidate - there is nothing
 * better to protect. Returns `undefined` fields when nothing should change,
 * so callers can `COALESCE` them against the existing column value.
 */
function resolveTitleUpdate(
  existingName: string | null | undefined,
  existingSource: SessionTitleSource | null | undefined,
  candidateName: string | null | undefined,
  candidateSource: SessionTitleSource | undefined,
): { name?: string; source?: SessionTitleSource } {
  if (candidateSource === undefined || !candidateName) {
    return {};
  }

  const hasExistingName = Boolean(existingName && existingName.trim());
  if (!hasExistingName) {
    return { name: candidateName, source: candidateSource };
  }

  const existingRank = existingSource ? TITLE_SOURCE_RANK[existingSource] : -1;
  const candidateRank = TITLE_SOURCE_RANK[candidateSource];

  if (candidateRank < existingRank) {
    return {};
  }
  if (candidateRank === existingRank && candidateRank === TITLE_SOURCE_RANK.naive) {
    // Both naive: keep whichever naive title is already in place instead of
    // re-deriving on every sync pass (matches the pre-tiering behavior).
    return {};
  }

  return { name: candidateName, source: candidateSource };
}

const SQLITE_UTC_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function normalizeTimestamp(value?: string): string | null {
  if (!value) return null;

  // SQLite CURRENT_TIMESTAMP is stored as UTC without a timezone suffix.
  // Normalize it here so every session reader returns canonical ISO strings
  // and the sidebar never interprets fresh rows as local-time "hours old".
  const normalizedValue = SQLITE_UTC_TIMESTAMP_REGEX.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;

  const parsed = new Date(normalizedValue);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function normalizeSessionRow<T extends SessionRow | null | undefined>(row: T): T {
  if (!row) {
    return row;
  }

  return {
    ...row,
    created_at: normalizeTimestamp(row.created_at) ?? row.created_at,
    updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,
  };
}

function normalizeSessionRows(rows: SessionRow[]): SessionRow[] {
  return rows.map((row) => normalizeSessionRow(row) as SessionRow);
}

function normalizeProjectPathForProvider(provider: string, projectPath: string): string {
  void provider;
  return normalizeProjectPath(projectPath);
}

/**
 * SQL fragment scoping a session query to the Claude account the current
 * request represents.
 *
 * `account_dir IS NULL` is deliberately let through. A chat started in the web
 * UI gets its row before any transcript exists, and rows that predate this
 * column are only backfilled once their transcript is seen - excluding NULLs
 * would make a brand-new chat vanish from the sidebar the moment it is
 * created. Every row that HAS a transcript carries its account, which is the
 * case that actually caused one account's history to show up under another.
 */
const ACCOUNT_SCOPE_SQL = ' AND (account_dir IS NULL OR account_dir = ?)';

export const sessionsDb = {
  /**
   * Upserts one session row discovered on disk by a provider synchronizer.
   *
   * The given id is the provider-native session id. Rows are keyed by
   * `provider_session_id` so a session that was first created by the app
   * (with an app-allocated `session_id`) is updated in place once its
   * transcript shows up on disk, instead of producing a duplicate row. An
   * app-created row keeps its existing name; synchronizer names only update
   * rows that were themselves created by indexing provider storage.
   */
  /**
   * `titleSource` is opt-in: callers that know how to classify their
   * candidate title (currently only the Claude synchronizer) pass it and get
   * the tiered naive/ai/custom comparison from `resolveTitleUpdate()`.
   * Callers that omit it (cursor/codex/opencode synchronizers) keep the
   * original "freeze once any custom_name exists" behavior unchanged, so
   * this fix stays scoped to the provider it was reported for.
   */
  createSession(
    providerSessionId: string,
    provider: string,
    projectPath: string,
    customName?: string,
    createdAt?: string,
    updatedAt?: string,
    jsonlPath?: string | null,
    titleSource?: SessionTitleSource,
    scope?: { accountDir?: string | null; origin?: SessionOrigin | null }
  ): string {
    const db = getConnection();
    const createdAtValue = normalizeTimestamp(createdAt);
    const updatedAtValue = normalizeTimestamp(updatedAt);
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    // First, ensure the project path is recorded in the projects table,
    // since it's a foreign key in the sessions table.
    projectsDb.createProjectPath(normalizedProjectPath);

    const existing = db
      .prepare(
        `SELECT session_id, custom_name, title_source FROM sessions
         WHERE provider_session_id = ? AND provider = ?
         LIMIT 1`
      )
      .get(providerSessionId, provider) as
      | { session_id: string; custom_name: string | null; title_source: SessionTitleSource }
      | undefined;

    if (existing) {
      if (titleSource !== undefined) {
        const resolved = resolveTitleUpdate(existing.custom_name, existing.title_source, customName, titleSource);
        db.prepare(
          `UPDATE sessions SET
             provider = ?,
             updated_at = COALESCE(?, CURRENT_TIMESTAMP),
             project_path = ?,
             jsonl_path = ?,
             account_dir = COALESCE(?, account_dir),
             origin = COALESCE(origin, ?),
             custom_name = COALESCE(?, custom_name),
             title_source = COALESCE(?, title_source)
           WHERE session_id = ?`
        ).run(
          provider,
          updatedAtValue,
          normalizedProjectPath,
          jsonlPath ?? null,
          scope?.accountDir ?? null,
          scope?.origin ?? null,
          resolved.name ?? null,
          resolved.source ?? null,
          existing.session_id
        );
      } else {
        db.prepare(
          `UPDATE sessions SET
             provider = ?,
             updated_at = COALESCE(?, CURRENT_TIMESTAMP),
             project_path = ?,
             jsonl_path = ?,
             account_dir = COALESCE(?, account_dir),
             origin = COALESCE(origin, ?),
             custom_name = CASE
               WHEN session_id <> provider_session_id AND custom_name IS NOT NULL THEN custom_name
               ELSE COALESCE(?, custom_name)
             END
           WHERE session_id = ?`
        ).run(
          provider,
          updatedAtValue,
          normalizedProjectPath,
          jsonlPath ?? null,
          scope?.accountDir ?? null,
          scope?.origin ?? null,
          customName ?? null,
          existing.session_id
        );
      }

      return existing.session_id;
    }

    // Sessions created outside the app (directly via the provider CLI) are
    // keyed by the provider-native id for both columns. The ON CONFLICT path
    // covers legacy rows that predate the provider_session_id mapping.
    db.prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, title_source, project_path, jsonl_path, account_dir, origin, isArchived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))
       ON CONFLICT(session_id) DO UPDATE SET
         provider = excluded.provider,
         provider_session_id = excluded.provider_session_id,
         updated_at = excluded.updated_at,
         project_path = excluded.project_path,
         jsonl_path = excluded.jsonl_path,
         account_dir = COALESCE(excluded.account_dir, sessions.account_dir),
         origin = COALESCE(sessions.origin, excluded.origin),
         custom_name = CASE
           WHEN sessions.session_id <> sessions.provider_session_id AND sessions.custom_name IS NOT NULL
             THEN sessions.custom_name
           ELSE COALESCE(excluded.custom_name, sessions.custom_name)
         END,
         title_source = COALESCE(excluded.title_source, sessions.title_source)`
    ).run(
      providerSessionId,
      provider,
      providerSessionId,
      customName ?? null,
      titleSource ?? 'naive',
      normalizedProjectPath,
      jsonlPath ?? null,
      scope?.accountDir ?? null,
      scope?.origin ?? null,
      scope?.origin === 'auto' ? 1 : 0,
      createdAtValue,
      updatedAtValue
    );

    return providerSessionId;
  },

  /**
   * Inserts one app-allocated session row before any provider run happens.
   *
   * The session gateway uses this when the frontend starts a brand-new chat:
   * `session_id` is the stable app-facing id, while `provider_session_id`
   * stays NULL until the provider runtime announces its own id and
   * `assignProviderSessionId` records the mapping. `customName` is derived
   * from the first visible CloudCLI message by the sessions service.
   */
  createAppSession(
    sessionId: string,
    provider: string,
    projectPath: string,
    customName?: string,
  ): string {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    projectsDb.createProjectPath(normalizedProjectPath);

    db.prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, title_source, project_path, jsonl_path, account_dir, origin, isArchived, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'naive', ?, NULL, ?, 'web', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(sessionId, provider, customName ?? null, normalizedProjectPath, getActiveAccountDir());

    return sessionId;
  },

  /**
   * Records the provider-native session id for one app-allocated session.
   *
   * If the filesystem watcher indexed the provider transcript before this
   * mapping was recorded (a duplicate row keyed by the provider id exists),
   * the duplicate is merged into the app row: its transcript path and name
   * are adopted and the duplicate row is removed. Runs in a transaction so
   * the sidebar can never observe both rows at once.
   */
  assignProviderSessionId(sessionId: string, providerSessionId: string): void {
    const db = getConnection();

    const merge = db.transaction(() => {
      const duplicate = db
        .prepare(
          `SELECT ${SESSION_ROW_COLUMNS} FROM sessions
           WHERE (session_id = ? OR provider_session_id = ?)
             AND session_id <> ?
           LIMIT 1`
        )
        .get(providerSessionId, providerSessionId, sessionId) as SessionRow | undefined;

      if (duplicate) {
        db.prepare('DELETE FROM sessions WHERE session_id = ?').run(duplicate.session_id);
        db.prepare(
          `UPDATE sessions SET
             provider_session_id = ?,
             jsonl_path = COALESCE(jsonl_path, ?),
             custom_name = COALESCE(custom_name, ?),
             updated_at = CURRENT_TIMESTAMP
           WHERE session_id = ?`
        ).run(providerSessionId, duplicate.jsonl_path, duplicate.custom_name, sessionId);
        return;
      }

      db.prepare(
        `UPDATE sessions SET
           provider_session_id = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ?`
      ).run(providerSessionId, sessionId);
    });

    merge();
  },

  /**
   * Records the model one session runs with.
   *
   * Called both when the user picks a model for the session and on every send,
   * so the row always reflects what the session last ran with and reopening it
   * restores that model instead of a catalog default.
   */
  setSessionModel(sessionId: string, model: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET model = ?
       WHERE session_id = ?`
    ).run(model, sessionId);
  },

  /**
   * Records the reasoning effort one session runs with.
   *
   * `default` is stored as an explicit choice rather than NULL so reopening
   * the session does not inherit a later per-provider effort preference.
   */
  setSessionEffort(sessionId: string, effort: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET effort = ?
       WHERE session_id = ?`
    ).run(effort, sessionId);
  },

  updateSessionCustomName(sessionId: string, customName: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET custom_name = ?
       WHERE session_id = ?`
    ).run(customName, sessionId);
  },

  /**
   * Renames a session on the user's explicit instruction (the web rename
   * action), tagging it 'custom' tier. Deliberately separate from
   * `updateSessionCustomName` - that method is also called by the codex
   * synchronizer for its own auto-derived names, which must NOT be tagged
   * as a manual rename or they would be frozen against future improvement.
   * A 'custom' tier row is the top of `resolveTitleUpdate()`'s ranking, so
   * once this runs, no later sync can silently replace the user's title.
   */
  renameSessionByUser(sessionId: string, customName: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET custom_name = ?, title_source = 'custom'
       WHERE session_id = ?`
    ).run(customName, sessionId);
  },

  /**
   * Assigns a topic group (manual or auto) to one session. Passing
   * `groupId: null` clears the session back to ungrouped.
   */
  setSessionGroup(sessionId: string, groupId: string | null, groupLabel: string | null): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET group_id = ?, group_label = ?
       WHERE session_id = ?`
    ).run(groupId, groupLabel, sessionId);
  },

  /**
   * Applies many group assignments atomically, so the sidebar never
   * observes a project half-regrouped mid-broadcast.
   */
  assignSessionGroups(assignments: Array<{ sessionId: string; groupId: string; groupLabel: string }>): void {
    if (assignments.length === 0) {
      return;
    }

    const db = getConnection();
    const stmt = db.prepare(
      `UPDATE sessions
       SET group_id = ?, group_label = ?
       WHERE session_id = ?`
    );
    const applyAll = db.transaction((rows: typeof assignments) => {
      for (const row of rows) {
        stmt.run(row.groupId, row.groupLabel, row.sessionId);
      }
    });
    applyAll(assignments);
  },

  /**
   * Active (non-archived) sessions for a project that have no topic group
   * yet, newest first - the candidate pool for "Organize by topic".
   */
  getUngroupedSessionsByProjectPath(projectPath: string, limit: number): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0
           AND group_id IS NULL
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT ?`
      )
      .all(normalizedProjectPath, limit) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  getSessionById(sessionId: string): SessionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(sessionId) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * Resolves one session row through the provider-native id.
   *
   * The filesystem watcher only knows provider ids (they come from transcript
   * file names), so it uses this lookup to translate disk artifacts back to
   * the app-facing session row before broadcasting sidebar updates.
   */
  getSessionByProviderSessionId(providerSessionId: string): SessionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE provider_session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(providerSessionId) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * Finds the newest app-created session for a project that is still waiting
   * for its provider-native id to be recorded.
   *
   * Primary intention: OpenCode can expose a new session in its shared
   * `opencode.db` before the websocket runtime reports that same provider id
   * back to our app. At that moment the sidebar already has an optimistic
   * app-owned session row, but the watcher only knows the provider-native id.
   *
   * Without this lookup, the synchronizer would insert a second row keyed by
   * the provider id, then `assignProviderSessionId()` would merge it a moment
   * later. That eventually self-heals, but on slow networks the user can still
   * briefly see two sidebar sessions for the same conversation.
   *
   * This helper lets the synchronizer claim the pending app row first, so the
   * provider id is attached before any watcher-created row exists. The result
   * is simpler than frontend dedupe and keeps the race resolved at the source.
   */
  findLatestPendingAppSession(provider: string, projectPath: string): SessionRow | null {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE provider = ?
           AND project_path = ?
           AND provider_session_id IS NULL
           AND isArchived = 0
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT 1`
      )
      .get(provider, normalizedProjectPath) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  getAllSessions(): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 0` + ACCOUNT_SCOPE_SQL
      )
      .all(getActiveAccountDir()) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Returns one globally ordered page of visible conversations.
   *
   * Pagination happens after archived sessions and sessions belonging to an
   * archived project have been excluded. This keeps the sidebar feed complete
   * and correctly ordered across projects instead of flattening only the
   * per-project slices already loaded by the client.
   */
  getRecentSessionsPage(limit: number, offset: number): RecentSessionsPage {
    const db = getConnection();
    const visibilityClause = `
      sessions.isArchived = 0
      AND (projects.isArchived IS NULL OR projects.isArchived = 0)
      AND (sessions.account_dir IS NULL OR sessions.account_dir = ?)
    `;
    const accountDir = getActiveAccountDir();
    const rows = db
      .prepare(
        `SELECT sessions.*
         FROM sessions
         LEFT JOIN projects ON projects.project_path = sessions.project_path
         WHERE ${visibilityClause}
         ORDER BY julianday(COALESCE(sessions.updated_at, sessions.created_at)) DESC,
                  sessions.session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(accountDir, limit, offset) as SessionRow[];
    const countRow = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         LEFT JOIN projects ON projects.project_path = sessions.project_path
         WHERE ${visibilityClause}`
      )
      .get(accountDir) as { count: number } | undefined;

    return {
      sessions: normalizeSessionRows(rows),
      total: Number(countRow?.count ?? 0),
    };
  },

  /**
   * Archived rows are intentionally queried separately so the caller can render
   * them in a dedicated view without reintroducing them into active session lists.
   */
  getArchivedSessions(): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 1` + ACCOUNT_SCOPE_SQL + `
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC`
      )
      .all(getActiveAccountDir()) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  getSessionsByProjectPath(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0` + ACCOUNT_SCOPE_SQL
      )
      .all(normalizedProjectPath, getActiveAccountDir()) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Permanent project deletion must see every session row for the path,
   * including archived ones, so their transcript files can be cleaned up.
   */
  getSessionsByProjectPathIncludingArchived(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?`
      )
      .all(normalizedProjectPath) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  getSessionsByProjectPathPage(projectPath: string, limit: number, offset: number): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0` + ACCOUNT_SCOPE_SQL + `
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(normalizedProjectPath, getActiveAccountDir(), limit, offset) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Moves this account's script-launched sessions into the archive - once.
   *
   * New `auto` sessions are archived as they are inserted, but rows indexed
   * before that classification existed are already sitting in the active
   * list. This is the one-off catch-up for them.
   *
   * Two guards make it a genuine one-off rather than a rule:
   *   - it does nothing until every one of this account's sessions has been
   *     classified, so a partial scan cannot archive a half-known list;
   *   - it records that it ran, so a session the user later takes back OUT of
   *     the archive is never quietly re-archived behind them.
   */
  archiveAutomatedSessionsOnce(accountDir: string): number {
    const db = getConnection();
    const flagKey = `auto_sessions_tidied:${accountDir}`;
    if (appConfigDb.get(flagKey)) {
      return 0;
    }

    const unclassified = db
      .prepare(
        `SELECT COUNT(*) AS count FROM sessions
         WHERE account_dir = ? AND origin IS NULL`
      )
      .get(accountDir) as { count: number } | undefined;

    if (Number(unclassified?.count ?? 0) > 0) {
      return 0;
    }

    const result = db
      .prepare(
        `UPDATE sessions SET isArchived = 1
         WHERE account_dir = ? AND origin = 'auto' AND isArchived = 0`
      )
      .run(accountDir);

    appConfigDb.set(flagKey, new Date().toISOString());
    return result.changes;
  },

  countSessionsByProjectPath(projectPath: string): number {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0` + ACCOUNT_SCOPE_SQL
      )
      .get(normalizedProjectPath, getActiveAccountDir()) as { count: number } | undefined;

    return Number(row?.count ?? 0);
  },

  deleteSessionsByProjectPath(projectPath: string): void {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    db.prepare(`DELETE FROM sessions WHERE project_path = ?`).run(normalizedProjectPath);
  },

  getSessionName(sessionId: string, provider: string): string | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT custom_name
         FROM sessions
         WHERE session_id = ? AND provider = ?`
      )
      .get(sessionId, provider) as { custom_name: string | null } | undefined;

    return row?.custom_name ?? null;
  },

  /**
   * Soft-delete and restore both use the same flag update so callers keep the
   * row, metadata, and file path intact while toggling visibility.
   */
  updateSessionIsArchived(sessionId: string, isArchived: boolean): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET isArchived = ?
       WHERE session_id = ?`
    ).run(isArchived ? 1 : 0, sessionId);
  },

  deleteSessionById(sessionId: string): boolean {
    const db = getConnection();
    return db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId).changes > 0;
  },
};

import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import {
  getDevinDatabasePath,
  normalizeProviderTimestamp,
  normalizeSessionName,
  readOptionalString,
} from '@/shared/utils.js';

type DevinSessionRow = {
  id: string;
  working_directory: string | null;
  title: string | null;
  created_at: number | null;
  last_activity_at: number | null;
};

type SynchronizeRowsResult = {
  processed: number;
  firstSessionId: string | null;
};

/**
 * Devin's session store is machine-global: stamp rows with the owner's account
 * dir — the server's own config dir, NOT the request context (a guest listing
 * projects triggers this sync and must not claim the owner's sessions).
 */
function getMachineAccountDir(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  try {
    return fsSync.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

/**
 * Session indexer for Devin's shared `sessions.db` (`~/.local/share/devin/cli`).
 *
 * Devin sessions are machine-global (the CLI has one credential per host), so
 * indexed rows are stamped with the owner's account dir — under
 * OPEN_REGISTRATION guests never see another user's Devin history, same as
 * they cannot run the provider (see the /devin route gate).
 */
export class DevinSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'devin' as const;

  /**
   * Scans the Devin session table and upserts non-hidden sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const result = this.synchronizeRows(since);
    return result.processed;
  }

  /**
   * Handles watcher changes for `sessions.db` (and its -wal sibling).
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    const base = path.basename(filePath);
    if (base !== 'sessions.db' && base !== 'sessions.db-wal') {
      return null;
    }

    const result = this.synchronizeRows(undefined, 1);
    return result.firstSessionId;
  }

  private synchronizeRows(since?: Date, limit?: number): SynchronizeRowsResult {
    const dbPath = getDevinDatabasePath();
    if (!fsSync.existsSync(dbPath)) {
      return { processed: 0, firstSessionId: null };
    }

    let db: InstanceType<typeof Database>;
    try {
      // Locked/corrupt DB must degrade to "nothing synced", not poison the
      // caller's whole sync pass.
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[DevinProvider] Failed to open sessions database:', message);
      return { processed: 0, firstSessionId: null };
    }
    try {
      // Devin stores unix seconds; `since` is a Date on our side.
      const sinceSeconds = since ? Math.floor(since.getTime() / 1000) : null;
      const limitClause = limit ? 'LIMIT ?' : '';
      const params = limit ? [sinceSeconds, sinceSeconds, limit] : [sinceSeconds, sinceSeconds];
      const rows = db.prepare(`
        SELECT id, working_directory, title, created_at, last_activity_at
        FROM sessions
        WHERE COALESCE(hidden, 0) = 0
          AND (? IS NULL OR COALESCE(last_activity_at, created_at, 0) >= ?)
        ORDER BY COALESCE(last_activity_at, created_at, 0) DESC, id DESC
        ${limitClause}
      `).all(...params) as DevinSessionRow[];

      let processed = 0;
      let firstSessionId: string | null = null;
      for (const row of rows) {
        const indexedSessionId = this.upsertSession(row);
        if (!indexedSessionId) {
          continue;
        }
        if (!firstSessionId) {
          firstSessionId = indexedSessionId;
        }
        processed += 1;
      }

      return { processed, firstSessionId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[DevinProvider] Failed to synchronize sessions:', message);
      return { processed: 0, firstSessionId: null };
    } finally {
      db.close();
    }
  }

  private upsertSession(row: DevinSessionRow): string | null {
    const sessionId = readOptionalString(row.id);
    const projectPath = readOptionalString(row.working_directory);
    if (!sessionId || !projectPath) {
      return null;
    }

    const fallbackTitle = 'Untitled Devin Session';
    const pendingAppSession = sessionsDb.getSessionByProviderSessionId(sessionId)
      ?? sessionsDb.getSessionById(sessionId)
      ?? sessionsDb.findLatestPendingAppSession(this.provider, projectPath);
    if (pendingAppSession && !pendingAppSession.provider_session_id) {
      // Race guard: the DB watcher can index a session before the runtime's
      // provider-id mapping lands — bind the id to the fresh app row first.
      sessionsDb.assignProviderSessionId(pendingAppSession.session_id, sessionId);
    }

    const existingSession = sessionsDb.getSessionByProviderSessionId(sessionId)
      ?? sessionsDb.getSessionById(sessionId);
    const existingName = existingSession?.custom_name;
    const nextName = existingName && existingName !== fallbackTitle
      ? existingName
      : readOptionalString(row.title);

    // sessions.db is shared storage — jsonl_path must stay null so deleting an
    // app session never removes other sessions' history.
    return sessionsDb.createSession(
      sessionId,
      this.provider,
      projectPath,
      normalizeSessionName(nextName, fallbackTitle),
      normalizeProviderTimestamp(row.created_at),
      normalizeProviderTimestamp(row.last_activity_at ?? row.created_at),
      null,
      undefined,
      { accountDir: getMachineAccountDir(), origin: 'terminal' },
    );
  }
}

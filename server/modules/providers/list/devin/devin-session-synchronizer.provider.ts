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
 * How many distinct user messages a chat needs before its Devin-generated
 * title may replace the naive first-words name. The prompt start is an
 * acceptable placeholder early on, but the topic only becomes clear after a
 * couple of exchanges — promote once the conversation has that context.
 */
const MIN_USER_MESSAGES_FOR_TITLE = 2;

/**
 * Devin's `sessions.title` column holds two kinds of values: a summary the
 * CLI generates from the chat's task a few moments after the first turn —
 * a real title, the same evidence tier as Claude's `ai-title` transcript
 * entries — and, until that summary lands (or when the session opened with
 * a tool call rather than typed text), a serialization of that call like
 * `functions.read_file:0{"file_path": ...}`. Surfacing the blob would put
 * raw JSON in the sidebar in place of a readable prompt-derived name, so
 * tool-call-shaped titles count as "no title yet": the naive name stays
 * until a real one arrives.
 */
const SERIALIZED_TOOL_TITLE = /functions\.[\w-]+:\d+/;

function usableDevinTitle(rawTitle: string | null): string | undefined {
  const title = readOptionalString(rawTitle);
  // The blob can also follow readable text ("I need to look at the image
  // you sent.functions.ReadImage:0{...}"), so the tool-call marker is
  // rejected anywhere in the string, not just at the start.
  if (!title || SERIALIZED_TOOL_TITLE.test(title) || title.startsWith('{') || title.startsWith('[')) {
    return undefined;
  }
  return title;
}

/**
 * Devin sometimes stores the verbatim start of the first prompt in `title`
 * instead of a summary — the same useless text the naive name already
 * shows, but promoting it would freeze the placeholder forever. Such echoes
 * count as "no real title", keeping the row open for a later genuine
 * summary.
 */
function isEchoTitle(title: string, messageContent: string | undefined): boolean {
  if (!messageContent) {
    return false;
  }
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  const normalizedTitle = normalize(title);
  const normalizedContent = normalize(messageContent);
  return normalizedContent.startsWith(normalizedTitle)
    || normalizedTitle.startsWith(normalizedContent);
}

/**
 * Extracts plain text out of a `message_nodes.chat_message` JSON blob. ACP
 * content is a string for typed messages and an array of blocks for
 * messages with attachments; only the text matters for echo detection.
 */
function messageText(chatMessageJson: string): string | undefined {
  try {
    const content = (JSON.parse(chatMessageJson) as { content?: unknown }).content;
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      const text = content
        .map((block) => (block && typeof block === 'object' ? (block as { text?: unknown }).text : undefined))
        .filter((part): part is string => typeof part === 'string')
        .join(' ');
      return text || undefined;
    }
  } catch {
    // Unparseable node — treated as no content.
  }
  return undefined;
}

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
        const indexedSessionId = this.upsertSession(db, row);
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

  /**
   * Distinct user messages in the chat so far. Devin rebuilds context every
   * turn, replaying earlier messages into fresh branches, so raw node rows
   * overcount roughly 2x — dedupe on the stored blob. Summarizer branches
   * ("Conversation to summarize:") are internal plumbing, not user input.
   */
  private userMessageCount(db: InstanceType<typeof Database>, sessionId: string): number {
    try {
      const row = db.prepare(`
        SELECT COUNT(DISTINCT chat_message) AS c FROM message_nodes
        WHERE session_id = ?
          AND json_extract(chat_message, '$.role') = 'user'
          AND instr(chat_message, 'onversation to summarize') = 0
      `).get(sessionId) as { c: number };
      return row.c;
    } catch {
      // Older Devin databases may lack message_nodes — without it there is
      // no evidence the chat has context, so the naive name stays.
      return 0;
    }
  }

  /**
   * Whether Devin's title merely repeats the chat's opening prompt.
   */
  private echoesFirstPrompt(
    db: InstanceType<typeof Database>,
    sessionId: string,
    title: string,
  ): boolean {
    try {
      const row = db.prepare(`
        SELECT chat_message FROM message_nodes
        WHERE session_id = ? AND json_extract(chat_message, '$.role') = 'user'
        ORDER BY node_id LIMIT 1
      `).get(sessionId) as { chat_message: string } | undefined;
      return isEchoTitle(title, row ? messageText(row.chat_message) : undefined);
    } catch {
      return false;
    }
  }

  private upsertSession(db: InstanceType<typeof Database>, row: DevinSessionRow): string | null {
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
    const existingSource = existingSession?.title_source;
    // A chat keeps one settled name: once a real title has landed ('ai' from
    // a generated summary, 'custom' from a human rename) sync never proposes
    // another — Devin's own title may still evolve, the sidebar must not.
    // While the name is 'naive', the generated summary outranks it (the same
    // way a CLI `ai-title` does for Claude sessions) once the chat has a few
    // messages for the summary to draw on.
    const titleOpen = !existingSource || existingSource === 'naive';
    const devinTitle = titleOpen ? usableDevinTitle(row.title) : undefined;
    const derivedTitle = devinTitle
      && this.userMessageCount(db, sessionId) >= MIN_USER_MESSAGES_FOR_TITLE
      && !this.echoesFirstPrompt(db, sessionId, devinTitle)
      ? devinTitle
      : undefined;
    const nextName = derivedTitle
      ?? (existingName && existingName !== fallbackTitle
        ? existingName
        : usableDevinTitle(row.title))
      ?? undefined;

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
      derivedTitle ? 'ai' : undefined,
      { accountDir: getMachineAccountDir(), origin: 'terminal' },
    );
  }
}

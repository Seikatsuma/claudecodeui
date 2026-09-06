/**
 * Which Claude account a transcript belongs to, and how the session was
 * started. Both are derived from the transcript file itself rather than from
 * the ambient request context, and that is the whole point of this module.
 *
 * Context-derived answers have already gone wrong twice in this codebase: a
 * class field froze `~/.claude` at module load (see the long comment in
 * ClaudeSessionSynchronizer), and the file watcher still resolves its root
 * once at import time, outside any request. Anything that indexes a file it
 * found on disk must therefore work out the answer FROM THE PATH, so a caller
 * running outside a request context cannot silently file one account's chats
 * under another.
 */

import fs from 'node:fs';
import path from 'node:path';

import { getClaudeConfigDir } from '@/shared/utils.js';

/**
 * How a session came into existence:
 *   terminal - typed by a human in the Claude CLI (it is in that account's
 *              own history.jsonl, which is what the CLI's own resume picker
 *              lists);
 *   web      - driven through the remote/web bridge, i.e. this app or the
 *              phone;
 *   auto     - everything else: worker briefs, cron jobs, relays and probes
 *              launched by a script rather than by a person sitting down to
 *              chat.
 */
export type SessionOrigin = 'terminal' | 'web' | 'auto';

/**
 * The owner's `~/.claude-webuser-<id>` is a symlink to their real `~/.claude`,
 * so the same account is reachable under two spellings and rows written by
 * different code paths disagree on which one they store. Everything here is
 * canonicalised so an account is one value, not two.
 */
export function canonicalizeAccountDir(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

/**
 * The account directory a transcript lives in: the parent of the `projects/`
 * root it was found under. Returns null for a path that is not inside one
 * (nothing to attribute, so callers leave the row unscoped rather than
 * guessing).
 */
export function accountDirFromTranscriptPath(filePath: string): string | null {
  const segments = path.resolve(filePath).split(path.sep);
  const projectsIndex = segments.indexOf('projects');
  if (projectsIndex <= 0) {
    return null;
  }
  return canonicalizeAccountDir(segments.slice(0, projectsIndex).join(path.sep) || path.sep);
}

/** The account directory of whichever account the current request represents. */
export function getActiveAccountDir(): string {
  return canonicalizeAccountDir(getClaudeConfigDir());
}

/**
 * True when the transcript's opening records carry a remote/web bridge
 * marker. Only the head of the file is read: the marker is written when the
 * session is created, and these transcripts routinely reach tens of megabytes.
 */
export async function hasBridgeMarker(filePath: string, maxBytes = 64 * 1024): Promise<boolean> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf8');
    return head.includes('"bridge-session"') || head.includes('"bridgeSessionId"');
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

/**
 * Classifies one transcript. `terminalSessionIds` is the id set from that
 * account's own history.jsonl — the CLI writes an entry there for every
 * prompt a human types at the terminal and for nothing else, which makes it
 * the exact definition of "shows up in `claude --resume`".
 */
export async function classifySessionOrigin(
  filePath: string,
  sessionId: string,
  terminalSessionIds: ReadonlySet<string>,
): Promise<SessionOrigin> {
  if (terminalSessionIds.has(sessionId)) {
    return 'terminal';
  }
  return (await hasBridgeMarker(filePath)) ? 'web' : 'auto';
}

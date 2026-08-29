import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';

/**
 * Isolates both the sqlite session store and the fake `~/.claude` home the
 * synchronizer reads from (history.jsonl + projects/**\/*.jsonl), so these
 * tests never touch the real machine's Claude Code data.
 *
 * `ClaudeSessionSynchronizer` resolves its `claudeHome` once, in its
 * constructor, via `getClaudeConfigDir()` (which honors CLAUDE_CONFIG_DIR) -
 * so CLAUDE_CONFIG_DIR must be set *before* `new ClaudeSessionSynchronizer()`
 * runs, and each test must construct its own instance rather than reuse one
 * built under a different env value.
 */
async function withIsolatedClaudeHome(
  runTest: (claudeHome: string) => Promise<void>,
): Promise<void> {
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const previousDatabasePath = process.env.DATABASE_PATH;
  const claudeHome = await mkdtemp(path.join(os.tmpdir(), 'claude-session-sync-home-'));
  const dbDir = await mkdtemp(path.join(os.tmpdir(), 'claude-session-sync-db-'));

  closeConnection();
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.DATABASE_PATH = path.join(dbDir, 'auth.db');
  await initializeDatabase();

  try {
    await runTest(claudeHome);
  } finally {
    closeConnection();
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(claudeHome, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
}

async function writeHistoryJsonl(
  claudeHome: string,
  entries: Array<{ sessionId: string; display: string }>,
): Promise<void> {
  const lines = entries.map((entry) => JSON.stringify(entry)).join('\n');
  await writeFile(path.join(claudeHome, 'history.jsonl'), `${lines}\n`, 'utf8');
}

/** Writes a minimal, realistic session transcript: first line carries the
 * real (never-placeholder) first user message, exactly like the CLI writes
 * it on disk - the paste placeholder only ever lives in history.jsonl's
 * `display` field, never in the transcript itself. */
async function writeSessionTranscript(
  claudeHome: string,
  sessionId: string,
  options: { firstMessageText?: string; cwd?: string; trailingLines?: string[] } = {},
): Promise<string> {
  const cwd = options.cwd ?? '/tmp/project';
  const projectsDir = path.join(claudeHome, 'projects', '-tmp-project');
  await mkdir(projectsDir, { recursive: true });
  const filePath = path.join(projectsDir, `${sessionId}.jsonl`);

  const firstLine = JSON.stringify({
    type: 'user',
    sessionId,
    cwd,
    message: { role: 'user', content: options.firstMessageText ?? 'real full text, not a placeholder' },
  });
  const lines = [firstLine, ...(options.trailingLines ?? [])];
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

test(
  'a message that is only a pasted-text placeholder does not become the session title',
  { concurrency: false },
  async () => {
    await withIsolatedClaudeHome(async (claudeHome) => {
      const sessionId = 'sess-pure-paste';
      await writeHistoryJsonl(claudeHome, [
        { sessionId, display: '[Pasted text #1 +11 lines]' },
      ]);
      const filePath = await writeSessionTranscript(claudeHome, sessionId, {
        firstMessageText: 'the real, full pasted content the CLI actually sent to the model',
      });

      const upsertedId = await new ClaudeSessionSynchronizer().synchronizeFile(filePath);

      assert.equal(upsertedId, sessionId);
      const row = sessionsDb.getSessionById(sessionId);
      assert.ok(row, 'expected the session row to exist after sync');
      assert.notEqual(row?.custom_name, '[Pasted text #1 +11 lines]');
      // Nothing meaningful survived the placeholder, so it must fall back to
      // the same default used for a fully empty first message.
      assert.equal(row?.custom_name, 'Untitled Claude Session');
    });
  },
);

test(
  'text typed alongside a paste keeps that text as the title',
  { concurrency: false },
  async () => {
    await withIsolatedClaudeHome(async (claudeHome) => {
      const sessionId = 'sess-paste-with-text';
      await writeHistoryJsonl(claudeHome, [
        { sessionId, display: 'объясни этот файл: [Pasted text #1 +3 lines]' },
      ]);
      const filePath = await writeSessionTranscript(claudeHome, sessionId);

      await new ClaudeSessionSynchronizer().synchronizeFile(filePath);

      const row = sessionsDb.getSessionById(sessionId);
      assert.equal(row?.custom_name, 'объясни этот файл:');
    });
  },
);

test(
  'several concatenated placeholders with no other text still fall back cleanly',
  { concurrency: false },
  async () => {
    await withIsolatedClaudeHome(async (claudeHome) => {
      const sessionId = 'sess-multi-placeholder';
      await writeHistoryJsonl(claudeHome, [
        { sessionId, display: '[Pasted text #1][Pasted text #2 +10878 lines]' },
      ]);
      const filePath = await writeSessionTranscript(claudeHome, sessionId);

      await new ClaudeSessionSynchronizer().synchronizeFile(filePath);

      const row = sessionsDb.getSessionById(sessionId);
      assert.equal(row?.custom_name, 'Untitled Claude Session');
    });
  },
);

test(
  'a pasted image placeholder is stripped the same way as pasted text',
  { concurrency: false },
  async () => {
    await withIsolatedClaudeHome(async (claudeHome) => {
      const sessionId = 'sess-image-only';
      await writeHistoryJsonl(claudeHome, [{ sessionId, display: '[Image #1]' }]);
      const filePath = await writeSessionTranscript(claudeHome, sessionId);

      await new ClaudeSessionSynchronizer().synchronizeFile(filePath);

      const row = sessionsDb.getSessionById(sessionId);
      assert.equal(row?.custom_name, 'Untitled Claude Session');
    });
  },
);

test(
  'an ordinary short message is unaffected (no regression)',
  { concurrency: false },
  async () => {
    await withIsolatedClaudeHome(async (claudeHome) => {
      const sessionId = 'sess-normal-message';
      await writeHistoryJsonl(claudeHome, [
        { sessionId, display: 'обычное короткое сообщение без вставок' },
      ]);
      const filePath = await writeSessionTranscript(claudeHome, sessionId);

      await new ClaudeSessionSynchronizer().synchronizeFile(filePath);

      const row = sessionsDb.getSessionById(sessionId);
      assert.equal(row?.custom_name, 'обычное короткое сообщение без вставок');
    });
  },
);

test(
  'a stale placeholder title already persisted from before this fix self-heals on resync',
  { concurrency: false },
  async () => {
    await withIsolatedClaudeHome(async (claudeHome) => {
      const sessionId = 'sess-already-bad-title';
      // Seed the DB exactly like the buggy synchronizer used to: a row whose
      // custom_name is the raw placeholder, persisted before this fix shipped.
      sessionsDb.createSession(sessionId, 'claude', '/tmp/project', '[Pasted text #1 +11 lines]');
      assert.equal(sessionsDb.getSessionById(sessionId)?.custom_name, '[Pasted text #1 +11 lines]');

      // On resync, history.jsonl no longer has anything useful for this id
      // (matching the common case where the CLI's history file has since
      // rotated), but the transcript itself has since picked up an
      // AI-generated title, like the CLI writes for real sessions.
      const filePath = await writeSessionTranscript(claudeHome, sessionId, {
        trailingLines: [
          JSON.stringify({ type: 'ai-title', sessionId, aiTitle: 'Deploy the staging fix' }),
        ],
      });

      await new ClaudeSessionSynchronizer().synchronizeFile(filePath);

      const row = sessionsDb.getSessionById(sessionId);
      assert.equal(row?.custom_name, 'Deploy the staging fix');
    });
  },
);

test(
  'an AI-derived fallback title is stripped of the same CLI noise',
  { concurrency: false },
  async () => {
    await withIsolatedClaudeHome(async (claudeHome) => {
      const sessionId = 'sess-ai-title-with-image-noise';
      // No history.jsonl entry for this id at all, so the synchronizer must
      // fall through to the end-of-transcript AI title extraction - which,
      // per real on-disk data, can itself carry the same kind of
      // CLI-inserted "[Image #N]" noise via a `lastPrompt` event.
      await writeHistoryJsonl(claudeHome, []);
      const filePath = await writeSessionTranscript(claudeHome, sessionId, {
        trailingLines: [
          JSON.stringify({
            type: 'last-prompt',
            sessionId,
            lastPrompt: 'исправь проблему [Image #1]🖼 Фото сохранено:',
          }),
        ],
      });

      await new ClaudeSessionSynchronizer().synchronizeFile(filePath);

      const row = sessionsDb.getSessionById(sessionId);
      assert.ok(row?.custom_name);
      assert.ok(!row?.custom_name.includes('[Image #1]'));
      assert.equal(row?.custom_name, 'исправь проблему 🖼 Фото сохранено:');
    });
  },
);

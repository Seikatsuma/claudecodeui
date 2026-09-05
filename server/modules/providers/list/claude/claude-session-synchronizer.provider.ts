import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  getClaudeConfigDir,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import type { SessionTitleSource } from '@/shared/types.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
  titleSource: SessionTitleSource;
};

// The `claude` CLI's own terminal readline collapses a large paste into a
// placeholder - "[Pasted text #1 +11 lines]", or "[Image #1]" for a pasted
// image - before it ever reaches the model. That placeholder (not the real
// pasted content) is what lands in history.jsonl's `display` field, which is
// exactly what `nameMap` below is built from. Verified against the CLI's own
// on-disk history.jsonl: a message that is *only* a paste has `display`
// equal to the placeholder alone, while the actual session transcript's
// first user message holds the real, full text - the placeholder never
// reaches the transcript, only this history sidecar file. Using it verbatim
// as a session title produced sidebar rows literally titled "[Pasted text
// #1]", meaningless to anyone reading the list.
const PASTE_PLACEHOLDER_PATTERN = /\[(?:Pasted (?:text|image)|Image) #\d+(?: \+\d+ lines)?\]/g;

/**
 * Strips CLI paste/image placeholders out of a candidate session title.
 *
 * When the user typed something alongside the paste ("summarize this:
 * [Pasted text #1]"), the surrounding text is still a fine title and is
 * returned trimmed. When the message was nothing but placeholder(s) - a bare
 * paste, or several concatenated back to back - nothing meaningful is left,
 * so this returns `undefined` and callers should fall back the same way they
 * do for a missing/empty title (AI-generated title, then the default name).
 */
function stripPastePlaceholders(candidate: string): string | undefined {
  const stripped = candidate
    .replace(PASTE_PLACEHOLDER_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || undefined;
}

/**
 * Session indexer for Claude transcript artifacts.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;
  // claudeHome is intentionally NOT cached as a class field: the class is
  // instantiated once at module load time (before any HTTP request context
  // exists), so a field initializer would freeze the value to the process-wide
  // default (~/.claude) for every user forever. Instead, each method resolves
  // it fresh via getClaudeConfigDir(), which reads the AsyncLocalStorage
  // request context and returns the correct per-user ~/.claude-webuser-<id>
  // for whichever user is making the current request.

  /**
   * Returns true when a JSONL file is a subagent transcript or tool result
   * rather than a top-level session.
   *
   * Claude stores subagent transcripts under a `subagents/` directory and
   * tool results under a `tool-results/` directory, e.g.
   * `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`.
   * Those files repeat the parent session's `sessionId`, so indexing them as
   * standalone sessions overwrites the parent row's `jsonl_path` and corrupts
   * the main session record. The recursive scan in `synchronize()` reaches
   * them, so both entry points must skip them.
   */
  private isSubagentTranscript(filePath: string): boolean {
    const pathParts = path.normalize(filePath).split(path.sep);
    return pathParts.includes('subagents') || pathParts.includes('tool-results');
  }

  /**
   * Scans ~/.claude/projects and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const claudeHome = getClaudeConfigDir();
    const nameMap = await buildLookupMap(path.join(claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(claudeHome, 'projects'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      if (this.isSubagentTranscript(filePath)) {
        continue;
      }

      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      const timestamps = await readFileTimestamps(filePath);
      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath,
        parsed.titleSource
      );
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Claude session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    if (this.isSubagentTranscript(filePath)) {
      return null;
    }

    const nameMap = await buildLookupMap(path.join(getClaudeConfigDir(), 'history.jsonl'), 'sessionId', 'display');
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath,
      parsed.titleSource
    );
  }

  /**
   * Extracts session metadata from one Claude JSONL session file.
   *
   * Always re-derives the best available title from disk and lets
   * `resolveTitleUpdate()` (called inside `sessionsDb.createSession()`)
   * decide whether it actually beats what is already stored - this file no
   * longer short-circuits on "a name already exists". That early return used
   * to freeze a session's title forever the moment *any* custom_name was
   * set, including the naive placeholder the web assigns at creation, which
   * is exactly why a later, genuine `ai-title`/`custom-title` entry never
   * reached the sidebar. See `resolveTitleUpdate()` in sessions.db.ts for the
   * naive < ai < custom tiering that replaces it.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      const projectPath = typeof data.cwd === 'string' ? data.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    // A real title (explicit rename, or the CLI's own generated summary) always
    // wins over raw prompt text, no matter which of them the CLI happened to
    // append last.
    const candidates = await this.extractSessionTitleCandidates(filePath, parsed.sessionId);

    const derived: { name: string; source: SessionTitleSource } | undefined =
      candidates.customTitle
        ? { name: candidates.customTitle, source: 'custom' }
        : candidates.aiTitle
          ? { name: candidates.aiTitle, source: 'ai' }
          : undefined;

    if (derived) {
      const strippedName = stripPastePlaceholders(derived.name);
      if (strippedName) {
        return {
          ...parsed,
          sessionName: normalizeSessionName(strippedName, 'Untitled Claude Session'),
          titleSource: derived.source,
        };
      }
    }

    // No ai-title/custom-title entry (yet): fall back to raw prompt text, tagged
    // 'naive' - the same tier as the web's own placeholder - so it is replaced
    // the moment a real title shows up. The CLI's history.jsonl display text
    // comes first because `buildLookupMap` keeps the *first* entry per session,
    // i.e. the message that opened the chat and usually names its subject;
    // `last-prompt` is the latest message instead, which for an ongoing chat is
    // as likely to be "продолжай"/"yes" as anything descriptive.
    let sessionName = nameMap.get(parsed.sessionId) ?? candidates.lastPrompt;
    if (sessionName) {
      sessionName = stripPastePlaceholders(sessionName);
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Claude Session'),
      titleSource: 'naive',
    };
  }

  /**
   * Collects the most recent title-bearing event of each kind from one session
   * transcript, so the caller can rank them by provenance tier:
   *  - `custom-title` -> 'custom' (an explicit rename, via web or CLI)
   *  - `ai-title` -> 'ai' (a genuine LLM-generated summary title)
   *  - `last-prompt` -> 'naive' (just the raw last user message, no summary)
   *
   * Scans backwards so the first hit of each kind is the newest one, and
   * deliberately does NOT stop at the first title-bearing entry of any kind.
   * The CLI appends a `last-prompt` on every single user message but refreshes
   * `ai-title` only now and then, so in an active chat the last such entry is
   * almost always `last-prompt` - returning early there made the sidebar show
   * the raw text of whatever was typed most recently ("есть", "продолжай")
   * instead of the real title, and made it change with every message. Measured
   * on the owner's own machine: 30 of the 40 most recent chats ended in
   * `last-prompt`, and 90 chats had a real title on disk that never surfaced.
   * A `custom-title` outranks everything, so that one can still return early.
   */
  private async extractSessionTitleCandidates(
    filePath: string,
    sessionId: string
  ): Promise<{ customTitle?: string; aiTitle?: string; lastPrompt?: string }> {
    const candidates: { customTitle?: string; aiTitle?: string; lastPrompt?: string } = {};

    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const data = parsed as Record<string, unknown>;
        const eventType = typeof data.type === 'string' ? data.type : undefined;
        const eventSessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
        if (eventSessionId !== sessionId) {
          continue;
        }

        const aiTitle = typeof data.aiTitle === 'string' ? data.aiTitle : undefined;
        const lastPrompt = typeof data.lastPrompt === 'string' ? data.lastPrompt : undefined;
        const claudeRenamedTitle = typeof data.customTitle === 'string' ? data.customTitle : undefined;

        if (eventType === 'custom-title' && claudeRenamedTitle?.trim()) {
          candidates.customTitle = claudeRenamedTitle;
          return candidates;
        }
        if (eventType === 'ai-title' && aiTitle?.trim() && !candidates.aiTitle) {
          candidates.aiTitle = aiTitle;
        }
        if (eventType === 'last-prompt' && lastPrompt?.trim() && !candidates.lastPrompt) {
          candidates.lastPrompt = lastPrompt;
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return candidates;
  }
}

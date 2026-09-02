import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { sessionsDb, type SessionTitleSource } from '@/modules/database/index.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  getClaudeConfigDir,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

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
  // getClaudeConfigDir() honors CLAUDE_CONFIG_DIR - see its doc comment in
  // shared/utils.ts. A hardcoded ~/.claude here previously made every
  // CLAUDE_CONFIG_DIR-scoped instance index the default account's sessions.
  private readonly claudeHome = getClaudeConfigDir();

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
    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.claudeHome, 'projects'),
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

    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
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

    // The end-of-file scan finds the real ai-title/custom-title entries when
    // present - always the better candidate when it exists, since both tiers
    // outrank the naive history.jsonl/last-prompt text below.
    const derived = await this.extractSessionAiTitleFromEnd(filePath, parsed.sessionId);
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

    // No ai-title/custom-title entry (yet): fall back to the CLI's own raw
    // history.jsonl display text. This is still just raw prompt text, not an
    // AI summary, so it is tagged 'naive' - the same tier as the web's own
    // placeholder - and will be replaced the moment a real title shows up.
    let sessionName = nameMap.get(parsed.sessionId);
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
   * Scans a session transcript backwards for the most recent title-bearing
   * event, classifying it by provenance tier:
   *  - `custom-title` -> 'custom' (an explicit rename, via web or CLI)
   *  - `ai-title` -> 'ai' (a genuine LLM-generated summary title)
   *  - `last-prompt` -> 'naive' (just the raw last user message, no summary)
   */
  private async extractSessionAiTitleFromEnd(
    filePath: string,
    sessionId: string
  ): Promise<{ name: string; source: SessionTitleSource } | undefined> {
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
          return { name: claudeRenamedTitle, source: 'custom' };
        }
        if (eventType === 'ai-title' && aiTitle?.trim()) {
          return { name: aiTitle, source: 'ai' };
        }
        if (eventType === 'last-prompt' && lastPrompt?.trim()) {
          return { name: lastPrompt, source: 'naive' };
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return undefined;
  }
}

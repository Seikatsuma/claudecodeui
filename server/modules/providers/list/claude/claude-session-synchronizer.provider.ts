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

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
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
        filePath
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
      filePath
    );
  }

  /**
   * Extracts session metadata from one Claude JSONL session file.
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

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    // A previously-synced row can itself hold a stale paste-placeholder title
    // from before this fix. Only treat an existing name as "already good"
    // (and thus frozen against re-derivation, so a real user rename is never
    // clobbered) once it survives the same placeholder stripping applied
    // below - otherwise fall through and re-derive it like a fresh session.
    const sanitizedExistingName = existingSessionName
      ? stripPastePlaceholders(existingSessionName)
      : undefined;
    if (sanitizedExistingName && existingSessionName !== 'Untitled Claude Session') {
      return {
        ...parsed,
        sessionName: normalizeSessionName(sanitizedExistingName, 'Untitled Claude Session'),
      };
    }

    let sessionName = nameMap.get(parsed.sessionId);
    if (sessionName) {
      sessionName = stripPastePlaceholders(sessionName);
    }
    if (!sessionName) {
      // `lastPrompt` events carry the same kind of CLI-inserted noise, e.g.
      // a hook appending "[Image #1]🖼 Фото сохранено:" - confirmed on disk
      // alongside the history.jsonl case above, so the AI-derived fallback
      // needs the same stripping rather than being assumed already clean.
      const aiDerivedName = await this.extractSessionAiTitleFromEnd(filePath, parsed.sessionId);
      sessionName = aiDerivedName ? stripPastePlaceholders(aiDerivedName) : undefined;
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Claude Session'),
    };
  }

  private async extractSessionAiTitleFromEnd(
    filePath: string,
    sessionId: string
  ): Promise<string | undefined> {
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
        const aiTitle = typeof data.aiTitle === 'string' ? data.aiTitle : undefined;
        const lastPrompt = typeof data.lastPrompt === 'string' ? data.lastPrompt : undefined;
        const claudeRenamedTitle = typeof data.customTitle === 'string' ? data.customTitle : undefined;

        if (
          (eventType === 'ai-title' && eventSessionId === sessionId && aiTitle?.trim()) ||
          (eventType === 'last-prompt' && eventSessionId === sessionId && lastPrompt?.trim()) ||
          (eventType === "custom-title" && eventSessionId === sessionId && claudeRenamedTitle?.trim())
        ) {
          return aiTitle || lastPrompt || claudeRenamedTitle;
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return undefined;
  }
}

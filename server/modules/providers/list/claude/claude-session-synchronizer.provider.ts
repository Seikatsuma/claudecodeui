import { createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { sessionsDb } from '@/modules/database/index.js';
import {
  accountDirFromTranscriptPath,
  classifySessionOrigin,
} from '@/shared/session-scope.js';
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

type TitleCandidates = {
  customTitle?: string;
  aiTitle?: string;
  /** Text of the first thing the person typed, straight from the transcript. */
  firstUserText?: string;
  lastPrompt?: string;
};

/**
 * Plain text of one `role: user` transcript turn, or undefined when it carries
 * none - which is the normal case for the tool-result turns the CLI writes with
 * the same role.
 */
function extractUserMessageText(data: Record<string, unknown>): string | undefined {
  const message = data.message as { role?: unknown; content?: unknown } | undefined;
  if (!message || message.role !== 'user') {
    return undefined;
  }

  const { content } = message;
  if (typeof content === 'string') {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((block) => {
      if (typeof block !== 'object' || block === null) {
        return '';
      }
      const { type, text: blockText } = block as { type?: unknown; text?: unknown };
      return type === 'text' && typeof blockText === 'string' ? blockText : '';
    })
    .filter(Boolean)
    .join(' ')
    .trim();

  return text || undefined;
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
    // history.jsonl holds one entry per prompt a human typed at the terminal,
    // and nothing else - so its id set is exactly "what `claude --resume`
    // offers". Doubles as the title source below.
    const nameMap = await buildLookupMap(path.join(claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const terminalSessionIds = new Set(nameMap.keys());
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
        parsed.titleSource,
        {
          accountDir: accountDirFromTranscriptPath(filePath),
          origin: await classifySessionOrigin(filePath, parsed.sessionId, terminalSessionIds),
        }
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

    // Resolved from the file's own path, NOT from getClaudeConfigDir(): the
    // file watcher calls this outside any request context, where that helper
    // falls back to the process default and would file another account's
    // transcript - and its history.jsonl lookup - under the wrong account.
    const accountDir = accountDirFromTranscriptPath(filePath) ?? getClaudeConfigDir();
    const nameMap = await buildLookupMap(path.join(accountDir, 'history.jsonl'), 'sessionId', 'display');
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
      parsed.titleSource,
      {
        accountDir: accountDirFromTranscriptPath(filePath),
        origin: await classifySessionOrigin(filePath, parsed.sessionId, new Set(nameMap.keys())),
      }
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
    // the moment a real title shows up. Ordered by how well each names the chat:
    //  1. history.jsonl display - `buildLookupMap` keeps the *first* entry per
    //     session, i.e. the message that opened the chat, and it is the shortest
    //     form of it (the CLI collapses a big paste to a placeholder there).
    //  2. the transcript's own first user message - the same opening message,
    //     available even after history.jsonl has rotated, which on this owner's
    //     machine is the case for most older chats.
    //  3. `last-prompt` - the *latest* message, as likely to be "продолжай" as
    //     anything descriptive, so it is the last resort rather than the first.
    let sessionName = nameMap.get(parsed.sessionId)
      ?? candidates.firstUserText
      ?? candidates.lastPrompt;
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
   * Keeps the last occurrence of each kind rather than stopping at the first
   * title-bearing entry found. The CLI appends a `last-prompt` on every single
   * user message but refreshes `ai-title` only now and then, so the newest
   * title-bearing entry in an active chat is almost always `last-prompt` -
   * taking it made the sidebar show the raw text of whatever was typed most
   * recently ("есть", "продолжай") instead of the real title, and rewrote that
   * title on every message. Measured on the owner's own machine: 30 of the 40
   * most recent chats ended in `last-prompt`, and 90 chats had a real title on
   * disk that never surfaced.
   */
  private async extractSessionTitleCandidates(
    filePath: string,
    sessionId: string
  ): Promise<TitleCandidates> {
    const candidates: TitleCandidates = {};

    try {
      // Streamed line by line, and forwards, on purpose. Transcripts here reach
      // 71 MB (1.6 GB across one owner's project directory), so reading one into
      // a string and splitting it into an array of lines needs hundreds of MB
      // for a single chat - enough to hit the Node heap limit and take the whole
      // server down mid-scan. Reading forwards keeps the *latest* occurrence of
      // each event, which is what a backwards scan was looking for anyway, and
      // costs one line of memory at a time.
      const lineReader = readline.createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity,
      });

      try {
        for await (const rawLine of lineReader) {
          // Substring test before JSON.parse: title events are a fraction of a
          // percent of the lines, and parsing every message of a 71 MB
          // transcript to find them is both slow and pure garbage-collector
          // pressure. The user-role test drops out of the filter as soon as the
          // opening message is found, so it costs nothing for the rest of a
          // long transcript.
          const mayHoldTitle = rawLine.includes('"ai-title"')
            || rawLine.includes('"last-prompt"')
            || rawLine.includes('"custom-title"');
          const mayOpenChat = candidates.firstUserText === undefined
            && (rawLine.includes('"role":"user"') || rawLine.includes('"role": "user"'));
          if (!mayHoldTitle && !mayOpenChat) {
            continue;
          }

          const line = rawLine.trim();
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

          if (candidates.firstUserText === undefined && eventType === 'user') {
            // Tool results are also written as role:user turns, and carry no
            // text block - those are skipped, so this lands on the first thing
            // the person actually typed.
            const opening = extractUserMessageText(data);
            if (opening) {
              candidates.firstUserText = opening;
            }
          }

          const aiTitle = typeof data.aiTitle === 'string' ? data.aiTitle : undefined;
          const lastPrompt = typeof data.lastPrompt === 'string' ? data.lastPrompt : undefined;
          const claudeRenamedTitle = typeof data.customTitle === 'string' ? data.customTitle : undefined;

          if (eventType === 'custom-title' && claudeRenamedTitle?.trim()) {
            candidates.customTitle = claudeRenamedTitle;
          }
          if (eventType === 'ai-title' && aiTitle?.trim()) {
            candidates.aiTitle = aiTitle;
          }
          if (eventType === 'last-prompt' && lastPrompt?.trim()) {
            candidates.lastPrompt = lastPrompt;
          }
        }
      } finally {
        lineReader.close();
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return candidates;
  }
}

import fsSync from 'node:fs';
import path from 'node:path';

import { spawn } from 'cross-spawn';
import { rgPath } from '@vscode/ripgrep';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import {
  ensureSearchIndex,
  readIndexedSummaries,
  type IndexedMessage,
  type RecordExtractor,
  type SearchableRole,
} from '@/modules/providers/services/session-search-index.service.js';
import { canonicalizeAccountDir, getActiveAccountDir } from '@/shared/session-scope.js';
import type { ServerScope } from '@/shared/types.js';
import { isTranscriptServiceText, normalizeServerScope, stripInjectedContext } from '@/shared/utils.js';

type AnyRecord = Record<string, any>;
type SearchableProvider = 'claude' | 'codex';

type SearchSnippetHighlight = {
  start: number;
  end: number;
};

type SessionConversationMatch = {
  role: string;
  snippet: string;
  highlights: SearchSnippetHighlight[];
  timestamp: string | null;
  provider: SearchableProvider;
  messageUuid?: string | null;
};

type SessionConversationResult = {
  sessionId: string;
  provider: SearchableProvider;
  sessionSummary: string;
  matches: SessionConversationMatch[];
};

type ProjectConversationResult = {
  projectId: string | null;
  projectName: string;
  projectDisplayName: string;
  sessions: SessionConversationResult[];
};

type SessionTitleSearchResult = {
  sessionId: string;
  provider: string;
  projectId: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  lastActivity: string | null;
};

export type SessionConversationSearchProgressUpdate = {
  projectResult: ProjectConversationResult | null;
  totalMatches: number;
  scannedProjects: number;
  totalProjects: number;
};

type SearchSessionConversationsInput = {
  query: string;
  limit: number;
  signal?: AbortSignal;
  projectId?: string | null;
  serverScope?: ServerScope | null;
  onTitleResults?: (results: SessionTitleSearchResult[]) => void;
  onProgress?: (update: SessionConversationSearchProgressUpdate) => void;
};

type SessionRepositoryRow = ReturnType<typeof sessionsDb.getAllSessions>[number];
type SearchableSessionRow = SessionRepositoryRow & {
  provider: SearchableProvider;
  jsonl_path: string;
};

type SearchRuntime = {
  matchesQuery: (text: string) => boolean;
  buildSnippet: (text: string) => { snippet: string; highlights: SearchSnippetHighlight[] };
};

const SUPPORTED_PROVIDERS = new Set<SearchableProvider>(['claude', 'codex']);
const MAX_MATCHES_PER_SESSION = 2;
// Файлы переписки идут пачками: сначала несколько свежих чатов — их находки
// сразу на экране, — потом остальное крупными пачками (один запуск поисковика
// на пачку). Готовность выжимок проверяется параллельно.
const SEARCH_FIRST_BATCH = 8;
const SEARCH_NEXT_BATCH = 64;
const INDEX_CHECK_CONCURRENCY = 8;
const UNKNOWN_PROJECT_KEY = '__unknown_project__';

const INTERNAL_CONTENT_PREFIXES = [
  '<system-reminder>',
  'Caveat:',
  'Invalid API key',
  '[Request interrupted',
] as const;

/**
 * Codex includes extra internal metadata tags that should not surface as
 * user-facing searchable conversation content.
 */
const CODEX_INTERNAL_CONTENT_PREFIXES = [
  '<environment_context>',
  '<cwd>',
] as const;

function normalizeComparablePath(inputPath: string): string {
  if (!inputPath || typeof inputPath !== 'string') {
    return '';
  }

  const withoutLongPathPrefix = inputPath.startsWith('\\\\?\\')
    ? inputPath.slice(4)
    : inputPath;
  const normalized = path.normalize(withoutLongPathPrefix.trim());
  if (!normalized) {
    return '';
  }

  const resolved = path.resolve(normalized);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function chunkArray<TItem>(items: TItem[], size: number): TItem[][] {
  if (size <= 0) {
    return [items];
  }

  const chunks: TItem[][] = [];
  for (let idx = 0; idx < items.length; idx += size) {
    chunks.push(items.slice(idx, idx + size));
  }
  return chunks;
}

function getSessionKey(session: Pick<SessionRepositoryRow, 'provider' | 'session_id'>): string {
  return `${session.provider}:${session.session_id}`;
}

function makeProjectKey(projectPath: string | null): string {
  const normalized = typeof projectPath === 'string' ? projectPath.trim() : '';
  return normalized.length > 0 ? normalized : UNKNOWN_PROJECT_KEY;
}

function toSummaryText(customName: string | null, fallback: string | null | undefined, emptyLabel: string): string {
  const trimmedCustomName = typeof customName === 'string' ? customName.trim() : '';
  if (trimmedCustomName) {
    return trimmedCustomName;
  }

  const trimmedFallback = typeof fallback === 'string' ? fallback.trim() : '';
  if (!trimmedFallback) {
    return emptyLabel;
  }

  return trimmedFallback.length > 50 ? `${trimmedFallback.slice(0, 50)}...` : trimmedFallback;
}

/**
 * Finds visible sessions whose displayed title contains the query. Title
 * matches are resolved from the database before transcript scanning so the UI
 * can always present them first, including sessions without a transcript yet.
 */
function findSessionTitleResults(
  sessions: SessionRepositoryRow[],
  query: string,
  limit: number,
): SessionTitleSearchResult[] {
  const normalizedQuery = query.toLocaleLowerCase().replace(/\s+/g, ' ');
  const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();

  return sessions
    .flatMap((session) => {
      const sessionTitle = toSummaryText(session.custom_name, session.session_id, session.session_id);
      const normalizedTitle = sessionTitle.toLocaleLowerCase().replace(/\s+/g, ' ');
      const matchIndex = normalizedTitle.indexOf(normalizedQuery);
      if (matchIndex === -1) {
        return [];
      }

      const projectPath = typeof session.project_path === 'string' && session.project_path.trim()
        ? session.project_path.trim()
        : null;
      const projectKey = projectPath ?? UNKNOWN_PROJECT_KEY;
      if (!projectCache.has(projectKey)) {
        projectCache.set(
          projectKey,
          projectPath ? projectsDb.getProjectPath(projectPath) : null,
        );
      }

      const project = projectCache.get(projectKey) ?? null;
      if (project?.isArchived) {
        return [];
      }

      return [{
        sessionId: session.session_id,
        provider: session.provider,
        projectId: project?.project_id ?? null,
        projectDisplayName: projectPath
          ? (project?.custom_project_name?.trim() || path.basename(projectPath) || projectPath)
          : 'Unknown Project',
        sessionTitle,
        lastActivity: session.updated_at || session.created_at || null,
        matchIndex,
      }];
    })
    .sort((left, right) => {
      if (left.matchIndex !== right.matchIndex) {
        return left.matchIndex - right.matchIndex;
      }

      return new Date(right.lastActivity ?? 0).getTime() - new Date(left.lastActivity ?? 0).getTime();
    })
    .slice(0, limit)
    .map(({ matchIndex: _matchIndex, ...result }) => result);
}

function isInternalContent(content: string): boolean {
  return INTERNAL_CONTENT_PREFIXES.some((prefix) => content.startsWith(prefix));
}

function isInternalCodexContent(content: string): boolean {
  const normalized = content.trimStart();
  return CODEX_INTERNAL_CONTENT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createWordMatcher(
  rawQuery: string,
  words: string[],
): Pick<SearchRuntime, 'matchesQuery' | 'buildSnippet'> {
  const normalizedQuery = rawQuery.trim().replace(/\s+/g, ' ');
  const requireExactPhrase = words.length > 1 && normalizedQuery.length > 0;
  const wordPatterns = words.map((word) => new RegExp(`(?<!\\p{L})${escapeRegex(word)}(?!\\p{L})`, 'u'));
  const phrasePattern = words.map((word) => escapeRegex(word)).join('\\s+');
  const phraseRegex = new RegExp(phrasePattern, 'iu');

  const allWordsMatch = (textLower: string): boolean =>
    wordPatterns.every((pattern) => pattern.test(textLower));

  const matchesQuery = (text: string): boolean => {
    if (typeof text !== 'string' || text.length === 0) {
      return false;
    }

    if (requireExactPhrase) {
      return phraseRegex.test(text);
    }

    if (phraseRegex.test(text)) {
      return true;
    }

    if (words.length === 1) {
      return allWordsMatch(text.toLowerCase());
    }

    return allWordsMatch(text.toLowerCase());
  };

  const buildSnippet = (
    text: string,
    snippetLen = 150,
  ): { snippet: string; highlights: SearchSnippetHighlight[] } => {
    const textLower = text.toLowerCase();
    let firstIndex = -1;
    let firstWordLen = 0;
    let phraseStart = -1;
    let phraseLength = 0;

    const phraseMatch = phraseRegex.exec(text);
    if (phraseMatch) {
      phraseStart = phraseMatch.index;
      phraseLength = phraseMatch[0].length;
      firstIndex = phraseStart;
      firstWordLen = phraseLength;
    }

    if (firstIndex === -1) {
      for (const word of words) {
        const regex = new RegExp(`(?<!\\p{L})${escapeRegex(word)}(?!\\p{L})`, 'u');
        const match = regex.exec(textLower);
        if (match && (firstIndex === -1 || match.index < firstIndex)) {
          firstIndex = match.index;
          firstWordLen = word.length;
        }
      }
    }

    if (firstIndex === -1) {
      firstIndex = 0;
    }

    const halfLen = Math.floor(snippetLen / 2);
    const start = Math.max(0, firstIndex - halfLen);
    const end = Math.min(text.length, firstIndex + halfLen + firstWordLen);
    const prefix = start > 0 ? '...' : '';
    const suffix = end < text.length ? '...' : '';
    const snippetBody = text.slice(start, end).replace(/\n/g, ' ');
    const snippet = `${prefix}${snippetBody}${suffix}`;

    const snippetLower = snippet.toLowerCase();
    const highlights: SearchSnippetHighlight[] = [];

    if (phraseStart >= start && phraseStart + phraseLength <= end) {
      const phraseOffset = prefix.length + (phraseStart - start);
      highlights.push({
        start: phraseOffset,
        end: phraseOffset + phraseLength,
      });
    }

    if (!requireExactPhrase) {
      for (const word of words) {
        const regex = new RegExp(`(?<!\\p{L})${escapeRegex(word)}(?!\\p{L})`, 'gu');
        let match = regex.exec(snippetLower);
        while (match) {
          highlights.push({ start: match.index, end: match.index + word.length });
          match = regex.exec(snippetLower);
        }
      }
    }

    highlights.sort((left, right) => left.start - right.start);
    const merged: SearchSnippetHighlight[] = [];
    for (const highlight of highlights) {
      const previous = merged[merged.length - 1];
      if (previous && highlight.start <= previous.end) {
        previous.end = Math.max(previous.end, highlight.end);
      } else {
        merged.push({ ...highlight });
      }
    }

    return { snippet, highlights: merged };
  };

  return { matchesQuery, buildSnippet };
}

function extractClaudeText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((part: AnyRecord) => part?.type === 'text' && typeof part?.text === 'string')
    .map((part: AnyRecord) => String(part.text))
    .join(' ');
}

function extractTaggedContent(content: string, tagName: string): string | null {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
}

type ClaudeLocalCommandPayload = {
  commandName: string;
  commandMessage: string;
  commandArgs: string;
};

function parseClaudeLocalCommandPayload(content: string): ClaudeLocalCommandPayload | null {
  const commandName = extractTaggedContent(content, 'command-name');
  const commandMessage = extractTaggedContent(content, 'command-message');
  const commandArgs = extractTaggedContent(content, 'command-args');

  if (commandName === null && commandMessage === null && commandArgs === null) {
    return null;
  }

  return {
    commandName: commandName ?? '',
    commandMessage: commandMessage ?? '',
    commandArgs: commandArgs ?? '',
  };
}

function buildClaudeLocalCommandDisplayText(payload: ClaudeLocalCommandPayload): string {
  const commandName = payload.commandName.trim();
  const commandMessage = payload.commandMessage.trim();
  const commandArgs = payload.commandArgs.trim();
  const baseCommand = commandName || commandMessage;

  if (!baseCommand) {
    return '';
  }

  return commandArgs ? `${baseCommand} ${commandArgs}` : baseCommand;
}

function stripAnsiFormatting(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

type ClaudeSearchableMessage = {
  text: string;
  role: 'user' | 'assistant';
};

/**
 * Claude mixes visible chat, compact summaries, and local command wrappers into
 * the same transcript stream. Search should operate on the user-visible meaning
 * of those rows rather than the raw wrapper syntax.
 */
function extractClaudeSearchableMessage(entry: AnyRecord): ClaudeSearchableMessage | null {
  if (!entry.message?.content || entry.isApiErrorMessage) {
    return null;
  }

  const rawRole = entry.message.role;
  if (rawRole !== 'user' && rawRole !== 'assistant') {
    return null;
  }

  // Служебные вставки от имени человека (подпись к снимку «[Image: …]»,
  // загрузка навыка, «продолжай с места»): чат их не показывает, значит и
  // искать в них и показывать их в превью главного экрана нечего.
  if (rawRole === 'user' && entry.isMeta === true && entry.isCompactSummary !== true) {
    return null;
  }

  if (typeof entry.message.content === 'string') {
    const content = String(entry.message.content);

    if (entry.isCompactSummary === true && content.trim()) {
      return {
        text: content,
        role: 'assistant',
      };
    }

    const localCommand = parseClaudeLocalCommandPayload(content);
    if (localCommand) {
      const displayText = buildClaudeLocalCommandDisplayText(localCommand);
      return displayText
        ? {
            text: displayText,
            role: 'user',
          }
        : null;
    }

    const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
    if (localCommandStdout !== null) {
      const stdoutText = stripAnsiFormatting(localCommandStdout).trim();
      return stdoutText
        ? {
            text: stdoutText,
            role: 'assistant',
          }
        : null;
    }

    if (!content || isInternalContent(content)) {
      return null;
    }

    return {
      text: content,
      role: rawRole,
    };
  }

  const text = extractClaudeText(entry.message.content);
  if (!text) {
    return null;
  }

  if (entry.isCompactSummary === true) {
    return {
      text,
      role: 'assistant',
    };
  }

  if (isInternalContent(text)) {
    return null;
  }

  return {
    text,
    role: rawRole,
  };
}

function extractCodexText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }

      const record = item as AnyRecord;
      if (
        (record.type === 'input_text' || record.type === 'output_text' || record.type === 'text')
        && typeof record.text === 'string'
      ) {
        return record.text;
      }

      return '';
    })
    .filter(Boolean)
    .join(' ');
}

const claudeRecordExtractor: RecordExtractor = (entry) => {
  if (entry.type === 'summary' && entry.summary) {
    return {
      kind: 'summary',
      sessionId: entry.sessionId ? String(entry.sessionId) : null,
      leafUuid: entry.leafUuid ? String(entry.leafUuid) : null,
      summary: String(entry.summary),
    };
  }

  const searchableMessage = extractClaudeSearchableMessage(entry);
  if (!searchableMessage) {
    return null;
  }

  return {
    kind: 'message',
    isCompactSummary: entry.isCompactSummary === true,
    message: {
      s: null,
      u: entry.uuid ? String(entry.uuid) : null,
      r: searchableMessage.role,
      t: entry.timestamp ? String(entry.timestamp) : null,
      x: searchableMessage.text,
    },
  };
};

function isVisibleCodexUserMessage(payload: AnyRecord | null | undefined): boolean {
  if (!payload || payload.type !== 'user_message') {
    return false;
  }

  if (payload.kind && payload.kind !== 'plain') {
    return false;
  }

  return typeof payload.message === 'string' && payload.message.trim().length > 0;
}

const codexRecordExtractor: RecordExtractor = (entry) => {
  let text: string | null = null;
  let role: SearchableRole | null = null;

  if (entry.type === 'event_msg' && isVisibleCodexUserMessage(entry.payload as AnyRecord)) {
    text = String(entry.payload.message);
    role = 'user';
  } else if (
    entry.type === 'event_msg'
    && entry.payload?.type === 'agent_reasoning'
    && typeof entry.payload?.text === 'string'
  ) {
    text = String(entry.payload.text);
    role = 'assistant';
  } else if (entry.type === 'response_item' && entry.payload?.type === 'message') {
    const payload = entry.payload as AnyRecord;
    if (payload.role === 'user') {
      text = extractCodexText(payload.content);
      role = 'user';
    } else if (payload.role === 'assistant') {
      text = extractCodexText(payload.content);
      role = 'assistant';
    }
  } else if (entry.type === 'response_item' && entry.payload?.type === 'reasoning') {
    const summaryText = Array.isArray(entry.payload.summary)
      ? entry.payload.summary
        .map((item: AnyRecord) => (typeof item?.text === 'string' ? item.text : ''))
        .filter(Boolean)
        .join('\n')
      : '';

    if (summaryText.trim()) {
      text = summaryText;
      role = 'assistant';
    }
  }

  if (!text || !role || isInternalCodexContent(text)) {
    return null;
  }

  return {
    kind: 'message',
    isCompactSummary: false,
    message: {
      s: null,
      u: null,
      r: role,
      t: entry.timestamp ? String(entry.timestamp) : null,
      x: text,
    },
  };
};

function extractorFor(provider: SearchableProvider): RecordExtractor {
  return provider === 'codex' ? codexRecordExtractor : claudeRecordExtractor;
}

type SearchScope = {
  projectId?: string | null;
  serverScope?: ServerScope | null;
};

/**
 * Панель ищет внутри одной папки и одной вкладки («Проекты» / «2-й сервер»).
 * Раньше сервер перебирал все чаты всех папок на каждую раскрытую папку, а
 * чужие находки клиент выбрасывал: несколько полных проходов разом, и лимит
 * в 50 находок мог кончиться на других папках раньше, чем дошло до нужной.
 */
function filterSessionsByScope(rows: SessionRepositoryRow[], scope: SearchScope): SessionRepositoryRow[] {
  let filtered = rows;

  if (scope.projectId) {
    const project = projectsDb.getProjectById(scope.projectId);
    if (!project) {
      return [];
    }
    const projectPath = project.project_path.trim();
    filtered = filtered.filter((row) => (row.project_path ?? '').trim() === projectPath);
  }

  if (scope.serverScope) {
    const projectScopeByPath = new Map<string, ServerScope>();
    filtered = filtered.filter((row) => {
      const projectPath = (row.project_path ?? '').trim();
      if (!projectScopeByPath.has(projectPath)) {
        const projectRow = projectPath ? projectsDb.getProjectPath(projectPath) : null;
        projectScopeByPath.set(projectPath, normalizeServerScope(projectRow?.server_scope));
      }
      const effective = row.server_scope
        ? normalizeServerScope(row.server_scope)
        : projectScopeByPath.get(projectPath) as ServerScope;
      return effective === scope.serverScope;
    });
  }

  return filtered;
}

function normalizeSearchableSessions(rows: SessionRepositoryRow[]): SearchableSessionRow[] {
  const normalizedRows: SearchableSessionRow[] = [];
  const projectArchiveStateByPath = new Map<string, boolean>();

  for (const row of rows) {
    const provider = row.provider as SearchableProvider;
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      continue;
    }

    const rawJsonlPath = typeof row.jsonl_path === 'string' ? row.jsonl_path.trim() : '';
    if (!rawJsonlPath) {
      continue;
    }

    const absoluteJsonlPath = path.resolve(rawJsonlPath);
    if (!fsSync.existsSync(absoluteJsonlPath)) {
      continue;
    }

    /**
     * Active session rows can still belong to an archived project because
     * project archiving intentionally preserves the underlying session data.
     * Global conversation search should follow the visible workspace model,
     * which means excluding any session whose owning project is archived.
     */
    const normalizedProjectPath = typeof row.project_path === 'string' ? row.project_path.trim() : '';
    if (normalizedProjectPath) {
      if (!projectArchiveStateByPath.has(normalizedProjectPath)) {
        const projectRow = projectsDb.getProjectPath(normalizedProjectPath);
        projectArchiveStateByPath.set(normalizedProjectPath, Boolean(projectRow?.isArchived));
      }

      if (projectArchiveStateByPath.get(normalizedProjectPath) === true) {
        continue;
      }
    }

    normalizedRows.push({
      ...row,
      provider,
      jsonl_path: absoluteJsonlPath,
    });
  }

  return normalizedRows;
}

function sessionTime(session: SessionRepositoryRow): number {
  const value = new Date(session.updated_at || session.created_at || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

type ProjectMetadata = { projectId: string | null; projectDisplayName: string };

function createProjectMetadataLookup(): (projectKey: string) => ProjectMetadata {
  const cache = new Map<string, ProjectMetadata>();
  return (key) => {
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }

    let metadata: ProjectMetadata;
    if (key === UNKNOWN_PROJECT_KEY) {
      metadata = { projectId: null, projectDisplayName: 'Unknown Project' };
    } else {
      const projectRow = projectsDb.getProjectPath(key);
      const customProjectName = typeof projectRow?.custom_project_name === 'string'
        ? projectRow.custom_project_name.trim()
        : '';
      metadata = {
        projectId: projectRow?.project_id ?? null,
        projectDisplayName: customProjectName || path.basename(key) || key,
      };
    }
    cache.set(key, metadata);
    return metadata;
  };
}

/** Одно на файл переписки: файл, его чаты и путь к выжимке. */
type SearchFile = {
  sourcePath: string;
  provider: SearchableProvider;
  sessions: SearchableSessionRow[];
  newest: number;
};

/**
 * Для отбора строк поисковику даётся самое длинное слово запроса: оно реже
 * всего встречается, а проверку всех слов и фразы делает разборщик ниже.
 */
function pickGrepWord(words: string[]): string {
  return words.reduce((longest, word) => (word.length > longest.length ? word : longest), '');
}

/**
 * Ищет строки выжимок, где есть слово. Возвращает строки по файлам выжимок.
 * Без предела на файл: в одном файле Claude бывает несколько разговоров, и
 * предел по строкам отрезал бы поздние. Все выжимки вместе — десятки
 * мегабайт, поэтому вывод и так ограничен.
 */
async function grepIndexLines(
  word: string,
  indexPaths: string[],
  signal?: AbortSignal,
): Promise<Map<string, string[]>> {
  const linesByIndex = new Map<string, string[]>();
  if (!word || indexPaths.length === 0 || signal?.aborted) {
    return linesByIndex;
  }

  return new Promise((resolve, reject) => {
    const rg = spawn(rgPath, [
      '--no-messages',
      '--ignore-case',
      '--fixed-strings',
      '--with-filename',
      '--no-heading',
      '--no-line-number',
      '--null',
      '--',
      word,
      ...indexPaths,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let buffered = '';
    const stderrChunks: Buffer[] = [];
    let aborted = false;

    const takeLine = (line: string) => {
      const separator = line.indexOf('\0');
      if (separator <= 0) {
        return;
      }
      const indexPath = line.slice(0, separator);
      const list = linesByIndex.get(indexPath);
      if (list) {
        list.push(line.slice(separator + 1));
      } else {
        linesByIndex.set(indexPath, [line.slice(separator + 1)]);
      }
    };

    const abortListener = () => {
      aborted = true;
      rg.kill();
    };
    signal?.addEventListener('abort', abortListener, { once: true });

    rg.stdout.setEncoding('utf8');
    rg.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        takeLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
    });
    rg.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    rg.on('error', (error) => {
      signal?.removeEventListener('abort', abortListener);
      if (aborted || signal?.aborted) {
        resolve(new Map());
        return;
      }
      reject(error);
    });

    rg.on('close', (code) => {
      signal?.removeEventListener('abort', abortListener);
      if (aborted || signal?.aborted) {
        resolve(new Map());
        return;
      }
      if (code !== 0 && code !== 1) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new Error(`ripgrep failed with code ${String(code)}: ${stderr}`));
        return;
      }
      if (buffered) {
        takeLine(buffered);
      }
      resolve(linesByIndex);
    });
  });
}

/**
 * Разбирает строки выжимки одного файла в находки по чатам этого файла.
 * В файле Claude бывает несколько разговоров: строка помечена номером
 * разговора у Claude, а наружу отдаётся номер чата в приложении.
 */
async function collectFileMatches(
  file: SearchFile,
  lines: string[],
  matcher: Pick<SearchRuntime, 'matchesQuery' | 'buildSnippet'>,
  remaining: () => number,
): Promise<SessionConversationResult[]> {
  const sessionByProviderId = new Map<string, SearchableSessionRow>();
  for (const session of file.sessions) {
    sessionByProviderId.set(session.provider_session_id || session.session_id, session);
  }

  const matchesBySession = new Map<string, SessionConversationMatch[]>();
  const seenBySession = new Map<string, Set<string>>();
  const order: SearchableSessionRow[] = [];
  let taken = 0;

  for (const line of lines) {
    if (taken >= remaining()) {
      break;
    }

    let message: IndexedMessage;
    try {
      message = JSON.parse(line) as IndexedMessage;
    } catch {
      continue;
    }

    const session = file.provider === 'codex'
      ? file.sessions[0]
      : (message.s ? sessionByProviderId.get(message.s) : undefined);
    if (!session) {
      continue;
    }

    const key = session.session_id;
    const matches = matchesBySession.get(key) ?? [];
    if (matches.length >= MAX_MATCHES_PER_SESSION) {
      continue;
    }

    // Codex пишет одно и то же сообщение дважды (событие и запись ответа).
    const fingerprint = `${message.r}:${message.x.trim().toLowerCase()}`;
    const seen = seenBySession.get(key) ?? new Set<string>();
    if (seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    seenBySession.set(key, seen);

    if (!matcher.matchesQuery(message.x)) {
      continue;
    }

    const { snippet, highlights } = matcher.buildSnippet(message.x);
    matches.push({
      role: message.r,
      snippet,
      highlights,
      timestamp: message.t,
      provider: file.provider,
      ...(file.provider === 'claude' ? { messageUuid: message.u } : {}),
    });
    taken += 1;
    if (!matchesBySession.has(key)) {
      matchesBySession.set(key, matches);
      order.push(session);
    }
  }

  if (order.length === 0) {
    return [];
  }

  const summaries = await readIndexedSummaries(file.sourcePath);
  return order
    .sort((left, right) => sessionTime(right) - sessionTime(left))
    .map((session) => {
      const summaryKey = file.provider === 'codex' ? '' : (session.provider_session_id || session.session_id);
      const summary = summaries[summaryKey];
      const fallback = file.provider === 'codex'
        ? summary?.lastUserText ?? null
        : summary?.resolvedSummary || summary?.lastUserText || summary?.lastAssistantText || null;
      return {
        sessionId: session.session_id,
        provider: file.provider,
        sessionSummary: toSummaryText(
          session.custom_name,
          fallback,
          file.provider === 'codex' ? 'Codex Session' : 'New Session',
        ),
        matches: matchesBySession.get(session.session_id) as SessionConversationMatch[],
      };
    });
}

function groupSessionsByFile(sessions: SearchableSessionRow[]): SearchFile[] {
  const files = new Map<string, SearchFile>();
  for (const session of sessions) {
    const key = normalizeComparablePath(session.jsonl_path);
    if (!key) {
      continue;
    }
    const existing = files.get(key);
    if (existing) {
      existing.sessions.push(session);
      existing.newest = Math.max(existing.newest, sessionTime(session));
    } else {
      files.set(key, {
        sourcePath: session.jsonl_path,
        provider: session.provider,
        sessions: [session],
        newest: sessionTime(session),
      });
    }
  }

  // Свежие чаты — первыми: их находки приходят на экран раньше старых.
  return Array.from(files.values()).sort((left, right) => right.newest - left.newest);
}

/**
 * Searches session titles and provider transcripts for the provider search
 * service and its route-level integration tests.
 */
export async function searchConversations(
  query: string,
  limit = 50,
  onProjectResult: ((update: SessionConversationSearchProgressUpdate) => void) | null = null,
  signal: AbortSignal | null = null,
  onTitleResults: ((results: SessionTitleSearchResult[]) => void) | null = null,
  scope: SearchScope = {},
): Promise<{
  results: ProjectConversationResult[];
  titleResults: SessionTitleSearchResult[];
  totalMatches: number;
  query: string;
}> {
  const safeQuery = typeof query === 'string' ? query.trim() : '';
  const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 50, 200));
  const words = safeQuery.toLowerCase().split(/\s+/).filter((word) => word.length > 0);

  if (words.length === 0) {
    return { results: [], titleResults: [], totalMatches: 0, query: safeQuery };
  }

  const isAborted = () => signal?.aborted === true;
  if (isAborted()) {
    return { results: [], titleResults: [], totalMatches: 0, query: safeQuery };
  }

  const activeSessions = filterSessionsByScope(sessionsDb.getAllSessions(), scope);
  const titleResults = findSessionTitleResults(activeSessions, safeQuery, safeLimit);
  onTitleResults?.(titleResults);

  const files = groupSessionsByFile(normalizeSearchableSessions(activeSessions));
  const totalFiles = files.length;
  const matcher = createWordMatcher(safeQuery, words);
  const grepWord = pickGrepWord(words);
  const projectMetadata = createProjectMetadataLookup();
  const resultsByProject = new Map<string, ProjectConversationResult>();
  let totalMatches = 0;
  let scannedFiles = 0;

  const batches = [
    files.slice(0, SEARCH_FIRST_BATCH),
    ...chunkArray(files.slice(SEARCH_FIRST_BATCH), SEARCH_NEXT_BATCH),
  ].filter((batch) => batch.length > 0);

  for (const batch of batches) {
    if (totalMatches >= safeLimit || isAborted()) {
      break;
    }

    const indexPathBySource = new Map<string, string>();
    let nextFile = 0;
    await Promise.all(Array.from({ length: Math.min(INDEX_CHECK_CONCURRENCY, batch.length) }, async () => {
      while (nextFile < batch.length && !isAborted()) {
        const file = batch[nextFile];
        nextFile += 1;
        const indexPath = await ensureSearchIndex(file.sourcePath, file.provider, extractorFor(file.provider));
        if (indexPath) {
          indexPathBySource.set(file.sourcePath, indexPath);
        }
      }
    }));
    if (isAborted()) {
      break;
    }

    const linesByIndex = await grepIndexLines(
      grepWord,
      Array.from(new Set(indexPathBySource.values())),
      signal ?? undefined,
    );

    for (const file of batch) {
      scannedFiles += 1;
      if (totalMatches >= safeLimit || isAborted()) {
        break;
      }
      const indexPath = indexPathBySource.get(file.sourcePath);
      const lines = indexPath ? linesByIndex.get(indexPath) : undefined;
      if (!lines || lines.length === 0) {
        continue;
      }

      const sessionResults = await collectFileMatches(file, lines, matcher, () => safeLimit - totalMatches);
      for (const sessionResult of sessionResults) {
        totalMatches += sessionResult.matches.length;
        const projectKey = makeProjectKey(
          file.sessions.find((session) => session.session_id === sessionResult.sessionId)?.project_path ?? null,
        );
        const metadata = projectMetadata(projectKey);
        const aggregate = resultsByProject.get(projectKey) ?? {
          projectId: metadata.projectId,
          projectName: projectKey,
          projectDisplayName: metadata.projectDisplayName,
          sessions: [],
        };
        aggregate.sessions.push(sessionResult);
        resultsByProject.set(projectKey, aggregate);

        // Каждая находка уходит на экран сразу, а не пачкой после всей папки.
        onProjectResult?.({
          projectResult: {
            projectId: metadata.projectId,
            projectName: projectKey,
            projectDisplayName: metadata.projectDisplayName,
            sessions: [sessionResult],
          },
          totalMatches,
          scannedProjects: scannedFiles,
          totalProjects: totalFiles,
        });
      }
    }
  }

  return {
    results: Array.from(resultsByProject.values()),
    titleResults,
    totalMatches,
    query: safeQuery,
  };
}

/**
 * Готовит выжимки заранее, чтобы первый поиск после выкатки не ждал разбора
 * всей переписки. Идёт по одному файлу, свежие первыми, и уступает очередь
 * запросам между файлами.
 */
export async function warmSearchIndexes(signal?: AbortSignal): Promise<{ files: number; ms: number }> {
  const startedAt = Date.now();
  const files = groupSessionsByFile(normalizeSearchableSessions(sessionsDb.getAllSessions()));
  let done = 0;
  for (const file of files) {
    if (signal?.aborted) {
      break;
    }
    await ensureSearchIndex(file.sourcePath, file.provider, extractorFor(file.provider));
    done += 1;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { files: done, ms: Date.now() - startedAt };
}

// ---------------------------
// Превью чатов для главного экрана: последние слова человека и последний
// ответ — чтобы по строке было понятно, что это за чат и на чём остановились.
// Берутся из хвоста выжимки поиска (она уже держит видимые сообщения каждого
// чата и дочитывает только новые байты), а не из сырой переписки: хвост
// выжимки — десятки килобайт, переписка — до сотни мегабайт.

/** Больше за раз не отдаём: главный экран показывает последний чат и пять недавних. */
const PREVIEW_MAX_SESSIONS = 12;
/** Хвост выжимки, в котором ищутся последние сообщения. */
const PREVIEW_TAIL_BYTES = 256 * 1024;
const PREVIEW_TEXT_LIMIT = 240;
/** Вставки веб-чата и хуков в сообщении человека: вложения, вставленный текст, напоминания. */
const PREVIEW_WRAPPER_BLOCKS = /<(files_input|pasted_content|system-reminder|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/g;

type SessionPreview = {
  lastUserText: string | null;
  lastAssistantText: string | null;
};

function previewText(text: string): string {
  const flat = text.replace(PREVIEW_WRAPPER_BLOCKS, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_TEXT_LIMIT ? `${flat.slice(0, PREVIEW_TEXT_LIMIT).trimEnd()}…` : flat;
}

async function readIndexTail(indexPath: string): Promise<string[]> {
  const handle = await fsSync.promises.open(indexPath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, PREVIEW_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    // Хвост начался с середины строки — первая строка оборвана.
    if (length < size) lines.shift();
    return lines;
  } finally {
    await handle.close();
  }
}

async function readSessionPreview(sessionId: string, projectsRoot: string): Promise<SessionPreview | null> {
  const row = sessionsDb.getSessionById(sessionId);
  if (!row || !row.jsonl_path || (row.provider && row.provider !== 'claude')) {
    return null;
  }
  // Номер чата в базе общий на всех пользователей сайта: чужую переписку
  // отсекает только то, что её файл лежит в папке аккаунта запроса.
  if (!canonicalizeAccountDir(row.jsonl_path).startsWith(projectsRoot)) {
    return null;
  }

  const indexPath = await ensureSearchIndex(row.jsonl_path, 'claude', claudeRecordExtractor);
  if (!indexPath) {
    return null;
  }

  const conversationId = row.provider_session_id || row.session_id;
  const lines = await readIndexTail(indexPath);
  const preview: SessionPreview = { lastUserText: null, lastAssistantText: null };
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (preview.lastUserText && preview.lastAssistantText) {
      break;
    }
    let message: IndexedMessage;
    try {
      message = JSON.parse(lines[index]) as IndexedMessage;
    } catch {
      continue;
    }
    if ((message.s && message.s !== conversationId) || typeof message.x !== 'string') {
      continue;
    }
    if (message.r === 'user') {
      const raw = message.x.trim();
      // Уведомление фоновой задачи или отзыв хука — не слова человека: ищем выше.
      if (preview.lastUserText || isTranscriptServiceText(raw)) {
        continue;
      }
      preview.lastUserText = previewText(stripInjectedContext(raw)) || null;
    } else if (!preview.lastAssistantText) {
      preview.lastAssistantText = previewText(message.x) || null;
    }
  }
  return preview;
}

async function readSessionPreviews(sessionIds: string[]): Promise<Record<string, SessionPreview>> {
  const projectsRoot = path.join(getActiveAccountDir(), 'projects') + path.sep;
  const ids = Array.from(new Set(sessionIds)).slice(0, PREVIEW_MAX_SESSIONS);
  const previews: Record<string, SessionPreview> = {};
  await Promise.all(ids.map(async (sessionId) => {
    try {
      const preview = await readSessionPreview(sessionId, projectsRoot);
      if (preview) {
        previews[sessionId] = preview;
      }
    } catch (error) {
      console.warn('[session-previews] превью не собрано:', sessionId, error instanceof Error ? error.message : error);
    }
  }));
  return previews;
}

/**
 * Application service for session-conversation search.
 *
 * Provider routes call this service so route handlers stay focused on
 * request parsing/response formatting, while search execution remains
 * centralized in one place.
 */
export const sessionConversationsSearchService = {
  /**
   * Streams progress updates while the search scans provider session logs.
   */
  async search(input: SearchSessionConversationsInput): Promise<void> {
    await searchConversations(
      input.query,
      input.limit,
      input.onProgress ?? null,
      input.signal ?? null,
      input.onTitleResults ?? null,
      { projectId: input.projectId ?? null, serverScope: input.serverScope ?? null },
    );
  },

  /**
   * Последние слова человека и последний ответ по списку чатов — для строк
   * главного экрана. Чаты чужого аккаунта и не Claude пропускаются молча.
   */
  readPreviews(sessionIds: string[]): Promise<Record<string, SessionPreview>> {
    return readSessionPreviews(sessionIds);
  },
};

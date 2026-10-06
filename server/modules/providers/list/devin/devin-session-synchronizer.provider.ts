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

import { askDevinOnce, DEVIN_MODEL_CWD } from './devin-model.js';
import {
  buildChatTitlePrompt,
  cleanGeneratedTitle,
  isEchoTitle,
  TITLE_ASK_TIMEOUT_MS,
  TITLE_MAX_ATTEMPTS,
  TITLE_RETRY_MS,
} from './devin-title.js';

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

/** Чего достаточно модели для имени: сессия, папка, черновик CLI и первые реплики. */
type TitleCandidate = {
  sessionId: string;
  projectPath: string;
  devinTitle?: string;
  userMessages: string[];
  createdAt: number | null;
  updatedAt: number | null;
};

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
   * Имя чата пишет разовый `devin -p` (devin-title.ts): сырой `sessions.title`
   * длинный и начинается с общих слов — в узкой панели различительное съезжало
   * за край. Генерация асинхронна и дороже чтения строки, поэтому она идёт
   * фоном, не внутри прохода синхронизации: проход лишь ставит задание, когда
   * у чата набрались сообщения и имя ещё открыто. `titleAttempts`/`titleInFlight`
   * — защита от перезапуска на каждом тике; после TITLE_MAX_ATTEMPTS сбоев
   * ставится сырой title CLI как запасной вариант (старое поведение).
   * Живут в памяти: рестарт процесса сбрасывает счётчики — это лишь лишние
   * попытки, безопасно.
   */
  private readonly titleAttempts = new Map<string, { attempts: number; nextTryAt: number }>();
  private readonly titleInFlight = new Set<string>();
  private readonly pendingTitleJobs = new Set<Promise<void>>();
  /**
   * Генерация идёт строго по одной: полный рескан или старт после рестarta
   * ставит десятки заданий разом, и сотня параллельных `devin -p` — это
   * сотня CLI-процессов на 8-гиговом сервере. Очередь-цепочка сериализует.
   */
  private titleQueue: Promise<void> = Promise.resolve();
  private readonly askTitle: (prompt: string, timeoutMs: number) => Promise<string>;
  private readonly titleRetryMs: number;
  private readonly titleMaxAttempts: number;

  constructor(
    askTitle: (prompt: string, timeoutMs: number) => Promise<string> = askDevinOnce,
    options?: { titleRetryMs?: number; titleMaxAttempts?: number },
  ) {
    this.askTitle = askTitle;
    this.titleRetryMs = options?.titleRetryMs ?? TITLE_RETRY_MS;
    this.titleMaxAttempts = options?.titleMaxAttempts ?? TITLE_MAX_ATTEMPTS;
  }

  /**
   * Потребитель: тесты — дождаться конца фоновых заданий имени, поставленных
   * проходом синхронизации. В проде вызывать не нужно: задания идут фоном,
   * чтобы проход (и висевший на нём запрос списка) не ждал ответа модели.
   */
  async drainTitleJobs(): Promise<void> {
    await Promise.allSettled([...this.pendingTitleJobs]);
  }

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
      const content = row ? messageText(row.chat_message) : undefined;
      return content !== undefined && isEchoTitle(title, content);
    } catch {
      return false;
    }
  }

  private upsertSession(db: InstanceType<typeof Database>, row: DevinSessionRow): string | null {
    const sessionId = readOptionalString(row.id);
    const projectPath = readOptionalString(row.working_directory);
    if (!sessionId || !projectPath || path.resolve(projectPath) === path.resolve(DEVIN_MODEL_CWD)) {
      // Беседы разовых вызовов `devin -p` — служебные: имя им ставить нечего,
      // в списке чатов их быть не должно даже в окне до пометки hidden.
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
    // the generated name, 'custom' from a human rename) sync never proposes
    // another — the sidebar must not churn. While the name is 'naive', the
    // chat is a candidate for the async name job once it has a few messages.
    const titleOpen = !existingSource || existingSource === 'naive';
    if (titleOpen) {
      const devinTitle = usableDevinTitle(row.title);
      const draft = devinTitle && !this.echoesFirstPrompt(db, sessionId, devinTitle)
        ? devinTitle
        : undefined;
      this.scheduleTitleJob({
        sessionId,
        projectPath,
        devinTitle: draft,
        userMessages: this.firstUserMessages(db, sessionId),
        createdAt: row.created_at,
        updatedAt: row.last_activity_at ?? row.created_at,
      });
    }
    const nextName = (existingName && existingName !== fallbackTitle
      ? existingName
      : usableDevinTitle(row.title))
      ?? undefined;

    // sessions.db is shared storage — jsonl_path must stay null so deleting an
    // app session never removes other sessions' history. The name candidate
    // here is only the provisional one (raw CLI title or the existing name):
    // the generated short name lands via the async job with source 'ai'.
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

  /**
   * Первые различные реплики человека — материал для имени. Тот же лес и
   * тот же фильтр, что у счётчика: дедупликация по blob, ветки
   * суммаризатора не считаются.
   */
  private firstUserMessages(db: InstanceType<typeof Database>, sessionId: string): string[] {
    try {
      const rows = db.prepare(`
        SELECT chat_message, MIN(node_id) AS first_seen FROM message_nodes
        WHERE session_id = ?
          AND json_extract(chat_message, '$.role') = 'user'
          AND instr(chat_message, 'onversation to summarize') = 0
        GROUP BY chat_message
        ORDER BY first_seen
        LIMIT 3
      `).all(sessionId) as Array<{ chat_message: string }>;
      return rows
        .map((row) => messageText(row.chat_message))
        .filter((text): text is string => Boolean(text && text.trim()));
    } catch {
      return [];
    }
  }

  /**
   * Ставит имя в очередь на генерацию — по достижении порога сообщений,
   * с защитой от повторов. Без читаемых сообщений имя не рождается:
   * модели не из чего выбрать сущность.
   */
  private scheduleTitleJob(candidate: TitleCandidate): void {
    // Порог тот же, что у счётчика: список из firstUserMessages LIMIT 3 —
    // >= 2 различных реплик набралось ровно тогда, когда их есть в базе.
    if (candidate.userMessages.length < MIN_USER_MESSAGES_FOR_TITLE) {
      return;
    }
    if (this.titleInFlight.has(candidate.sessionId)) {
      return;
    }
    const state = this.titleAttempts.get(candidate.sessionId);
    if (state && Date.now() < state.nextTryAt) {
      return;
    }
    if (state && state.attempts >= this.titleMaxAttempts) {
      // Модель так и не ответила — чат не должен остаться на обрезке
      // промпта: ставим длинный сырой title CLI, если он пригоден, ровно
      // один раз (attempts > MAX — запасной вариант уже записан).
      if (candidate.devinTitle && state.attempts === this.titleMaxAttempts) {
        state.attempts += 1;
        this.applyTitle(candidate, candidate.devinTitle);
      }
      return;
    }
    this.titleInFlight.add(candidate.sessionId);
    const job = (this.titleQueue = this.titleQueue
      .then(() => this.generateAndApplyTitle(candidate))
      .catch(() => undefined)
      .finally(() => {
        this.titleInFlight.delete(candidate.sessionId);
        this.pendingTitleJobs.delete(job);
      }));
    this.pendingTitleJobs.add(job);
  }

  private async generateAndApplyTitle(candidate: TitleCandidate): Promise<void> {
    let title: string | null = null;
    try {
      const raw = await this.askTitle(buildChatTitlePrompt(candidate), TITLE_ASK_TIMEOUT_MS);
      title = cleanGeneratedTitle(raw, candidate.userMessages[0]);
    } catch {
      title = null;
    }
    if (title) {
      this.applyTitle(candidate, title);
      this.titleAttempts.delete(candidate.sessionId);
      return;
    }
    const previous = this.titleAttempts.get(candidate.sessionId);
    this.titleAttempts.set(candidate.sessionId, {
      attempts: (previous?.attempts ?? 0) + 1,
      nextTryAt: Date.now() + this.titleRetryMs,
    });
  }

  /**
   * Записывает придуманное имя как 'ai' — рангами `resolveTitleUpdate` это
   * заменит naive и уступит позднему ручному переименованию ('custom').
   */
  private applyTitle(candidate: TitleCandidate, title: string): void {
    const internalSessionId = sessionsDb.createSession(
      candidate.sessionId,
      this.provider,
      candidate.projectPath,
      normalizeSessionName(title, 'Untitled Devin Session'),
      normalizeProviderTimestamp(candidate.createdAt),
      normalizeProviderTimestamp(candidate.updatedAt),
      null,
      'ai',
      { accountDir: getMachineAccountDir(), origin: 'terminal' },
    );
    // Ленивый импорт: прямой `import` из sessions-watcher образует цикл
    // (watcher → synchronizer.service → реестр → этот провайдер) и роняет
    // инициализацию модулей — рассылке нужен только рантайм.
    void import('../../services/sessions-watcher.service.js')
      .then(({ broadcastSessionUpserted }) => broadcastSessionUpserted(internalSessionId))
      .catch(() => undefined);
  }
}

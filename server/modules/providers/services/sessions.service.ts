import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  NormalizedMessage,
  ServerScope,
} from '@/shared/types.js';
import { getRequestRuntimeContext } from '@/shared/request-context.js';
import { ensureJpegForHeic } from '@/shared/image-attachments.js';
import {
  AppError,
  isCodexAllowedForWebUser,
  isPlatformOwnerWebUser,
  normalizeServerScope,
  OPEN_REGISTRATION,
} from '@/shared/utils.js';

/**
 * Devin sessions may only ever be read by the platform owner: the provider's
 * credentials and session store are machine-global. A guest who guesses a
 * session id must not be able to read history or provider ids through the
 * provider-agnostic session endpoints.
 */
const assertSessionProviderAllowed = (provider: string): void => {
  if (provider !== 'devin' || !OPEN_REGISTRATION) {
    return;
  }
  const userId = getRequestRuntimeContext()?.userId;
  const numericUserId = userId === undefined || userId === null ? NaN : Number(userId);
  if (!Number.isFinite(numericUserId) || !isPlatformOwnerWebUser(numericUserId)) {
    throw new AppError('The Devin provider is only available to the platform owner.', {
      code: 'PROVIDER_NOT_ALLOWED',
      statusCode: 403,
    });
  }
};

/**
 * Снимки с телефона лежат в истории вложениями .heic: в ленте они карточкой
 * «File attachment», а картинкой быть не могут — формата нет в списках
 * провайдеров, поэтому на отправке он уезжает в <files_input>. Здесь, в одной
 * точке на всех провайдеров, heic-файлы конвертируются в jpeg и перекладываются
 * в images: лента рисует снимок, как когда он был jpg. Конвертер кладёт jpeg
 * рядом с исходником и помнит его — повторная отдача истории работу не
 * повторяет; неудача оставляет файл карточкой, как раньше.
 */
async function upgradeHeicAttachmentsToImages(messages: NormalizedMessage[]): Promise<void> {
  for (const message of messages) {
    const files = Array.isArray(message.files) ? message.files as Array<Record<string, unknown>> : null;
    if (!files || files.length === 0) {
      continue;
    }

    const remaining: Array<Record<string, unknown>> = [];
    const converted: Array<Record<string, unknown>> = [];
    for (const file of files) {
      const filePath = typeof file?.path === 'string' ? file.path : '';
      const jpegPath = filePath ? await ensureJpegForHeic(filePath) : null;
      if (jpegPath) {
        converted.push({ ...file, path: jpegPath, mimeType: 'image/jpeg' });
      } else {
        remaining.push(file);
      }
    }
    if (converted.length === 0) {
      continue;
    }

    const images = Array.isArray(message.images) ? message.images as Array<Record<string, unknown>> : [];
    message.images = [...images, ...converted];
    message.files = remaining;
  }
}

type CreateAppSessionResult = {
  sessionId: string;
  provider: LLMProvider;
  projectPath: string;
  sessionName: string;
};

type ArchivedSessionListItem = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isProjectArchived: boolean;
  serverScope: ServerScope;
};

type RecentSessionListItem = Pick<
  ArchivedSessionListItem,
  'sessionId' | 'provider' | 'projectId' | 'projectDisplayName' | 'sessionTitle' | 'lastActivity'
> & {
  /** Блок верхней панели, в котором виден чат. */
  serverScope: ServerScope;
};

type RecentSessionsPage = {
  conversations: RecentSessionListItem[];
  total: number;
  hasMore: boolean;
};

type SessionDetails = {
  /** Canonical app-facing session id (may differ from the looked-up id when a provider-native id was given). */
  sessionId: string;
  provider: LLMProvider;
  summary: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isArchived: boolean;
  project: {
    projectId: string;
    path: string;
    fullPath: string;
    displayName: string;
    isStarred: boolean;
    isArchived: boolean;
    serverScope: ServerScope;
  } | null;
};

const MAX_CLOUDCLI_SESSION_NAME_WORDS = 4;
// Independent of the word cap above: `split(/\s+/)` on a message with no
// whitespace at all (a bare URL, a base64/JSON blob, one long unbroken
// token, ...) yields a single-element array, so `.slice(0, 4)` is a no-op
// and the *entire* raw message became the session title — e.g. a full
// pasted link rendering as the session name instead of something readable.
// This caps the result by characters too, regardless of word count.
const MAX_CLOUDCLI_SESSION_NAME_CHARS = 50;

function buildCloudCliSessionName(initialMessage: string): string {
  const words = initialMessage.trim().split(/\s+/).filter(Boolean);
  const name = words.slice(0, MAX_CLOUDCLI_SESSION_NAME_WORDS).join(' ');
  if (!name) {
    return 'Untitled Session';
  }
  if (name.length <= MAX_CLOUDCLI_SESSION_NAME_CHARS) {
    return name;
  }
  return `${name.slice(0, MAX_CLOUDCLI_SESSION_NAME_CHARS).trimEnd()}…`;
}

/**
 * Removes one file if it exists.
 */
async function removeFileIfExists(filePath: string): Promise<boolean> {
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Archive rows need a stable project label even when the owning project is not
 * part of the active sidebar payload. This lightweight resolver keeps the
 * archive API self-contained while still matching the project's stored display
 * name when one exists.
 */
function resolveProjectDisplayName(
  projectPath: string | null,
  customProjectName: string | null | undefined,
): string {
  const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  if (!projectPath) {
    return 'Unknown Project';
  }

  return path.basename(projectPath) || projectPath;
}

/**
 * Application service for provider-backed session message operations.
 *
 * Callers pass a provider id and this service resolves the concrete provider
 * class, keeping normalization/history call sites decoupled from implementation
 * file layout.
 */
export const sessionsService = {
  /**
   * Lists provider ids that can load session history and normalize live messages.
   */
  listProviderIds(): LLMProvider[] {
    return providerRegistry.listProviders().map((provider) => provider.id);
  },

  /**
   * Returns app-facing ids for provider runs that are currently processing.
   *
   * This is intentionally status-only: callers that only need sidebar activity
   * indicators should not attach to chat streams or request replayed messages.
   */
  listRunningSessions(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
  }> {
    return chatRunRegistry.listRunningRuns();
  },

  /**
   * Returns the active conversation feed in true global activity order.
   */
  listRecentSessions(
    limit: number,
    offset: number,
    serverScope?: ServerScope,
    providerSpace?: 'codex' | 'devin' | 'claude',
  ): RecentSessionsPage {
    const requestContext = getRequestRuntimeContext();
    const canUseCodex = requestContext === undefined
      || isCodexAllowedForWebUser(requestContext.userId);
    if ((providerSpace === 'codex' || providerSpace === 'devin') && !canUseCodex) {
      // Codex and Devin share one owner boundary (isCodexAllowedForWebUser).
      return { conversations: [], total: 0, hasMore: false };
    }
    const accountVisibility = canUseCodex ? 'shared-codex' : 'hide-codex';
    const page = sessionsDb.getRecentSessionsPage(
      limit,
      offset,
      serverScope,
      providerSpace,
      accountVisibility,
    );
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();
    const conversations = page.sessions.map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      return {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        lastActivity: session.updated_at ?? session.created_at ?? null,
        // Блок верхней панели: своё значение чата важнее значения папки.
        serverScope: normalizeServerScope(session.server_scope ?? project?.server_scope),
      };
    });

    return {
      conversations,
      total: page.total,
      hasMore: offset + conversations.length < page.total,
    };
  },

  /**
   * Resolves the provider-native session id a runtime needs for resume.
   *
   * Callers hand provider runtimes the stable app session id; the provider
   * CLIs/SDKs only understand their own native id, which lives on the session
   * row. Ids without a row are assumed to be provider-native already (direct
   * API callers that reference sessions the watcher has not indexed yet).
   */
  resolveProviderSessionId(sessionId: string | null | undefined): string | null {
    if (!sessionId) {
      return null;
    }

    const session = sessionsDb.getSessionById(sessionId);
    return session ? session.provider_session_id : sessionId;
  },

  /**
   * Normalizes one provider-native event into frontend session message events.
   */
  normalizeMessage(
    providerName: string,
    raw: unknown,
    sessionId: string | null,
  ): NormalizedMessage[] {
    return providerRegistry.resolveProvider(providerName).sessions.normalizeMessage(raw, sessionId);
  },

  /**
   * Allocates a stable app-facing session id before any provider run happens.
   *
   * This is the entry point of the session gateway: the frontend calls this
   * (via `POST /api/providers/sessions`) when the user starts a brand-new
   * chat, navigates to the returned id immediately, and the id never changes
   * for the lifetime of the conversation. The provider-native id is mapped to
   * this row later, when the provider runtime announces it mid-run. Its title
   * comes directly from the first visible CloudCLI message and is limited to
   * four whole words before any provider-owned storage exists.
   */
  createAppSession(
    provider: LLMProvider,
    projectPath: string,
    initialMessage: string,
  ): CreateAppSessionResult {
    const normalizedProjectPath = projectPath.trim();
    if (!normalizedProjectPath) {
      throw new AppError('projectPath is required.', {
        code: 'PROJECT_PATH_REQUIRED',
        statusCode: 400,
      });
    }

    const sessionId = randomUUID();
    const sessionName = buildCloudCliSessionName(initialMessage);
    sessionsDb.createAppSession(sessionId, provider, normalizedProjectPath, sessionName);

    return {
      sessionId,
      provider,
      projectPath: normalizedProjectPath,
      sessionName,
    };
  },

  /**
   * Переносит чат в другой блок верхней панели или возвращает его к
   * значению папки.
   *
   * Файл переписки при этом не двигается: перенос — это признак в базе,
   * поэтому чат остаётся тем же самым, его можно продолжить и вернуть
   * обратно одним нажатием.
   */
  setSessionServerScope(sessionId: string, serverScope: ServerScope | null): { serverScope: ServerScope | null } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.setSessionServerScope(sessionId, serverScope);
    return { serverScope };
  },

  /**
   * Вешает или снимает ярлык-флажок на чате. Только метка в базе: файл
   * переписки и порядок чатов не меняются.
   */
  setSessionFlagged(sessionId: string, flagged: boolean): { flagged: boolean } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.setSessionFlagged(sessionId, flagged);
    return { flagged };
  },

  /**
   * Resolves the provider-native id only for an explicit user copy action.
   * Normal session payloads continue to expose only the stable app id.
   */
  getProviderSessionId(sessionId: string): string {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }
    assertSessionProviderAllowed(session.provider);

    if (!session.provider_session_id) {
      throw new AppError('This session ID is not available yet.', {
        code: 'PROVIDER_SESSION_ID_NOT_AVAILABLE',
        statusCode: 409,
      });
    }

    return session.provider_session_id;
  },

  /**
   * Fetches persisted history by app session id.
   *
   * Provider and provider-specific lookup hints are resolved from the indexed
   * session metadata in the database. The provider adapter receives the
   * provider-native session id (the one written into transcripts on disk),
   * and every returned message is remapped back to the app session id so
   * provider ids never reach the frontend.
   */
  async fetchHistory(
    sessionId: string,
    options: Pick<FetchHistoryOptions, 'limit' | 'offset'> = {},
  ): Promise<FetchHistoryResult> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }
    assertSessionProviderAllowed(session.provider);

    // App-created sessions that never produced a provider transcript yet
    // (e.g. first message still streaming) simply have no history.
    if (!session.provider_session_id) {
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset: options.offset ?? 0,
        limit: options.limit ?? null,
      };
    }

    const provider = session.provider as LLMProvider;
    const result = await providerRegistry.resolveProvider(provider).sessions.fetchHistory(sessionId, {
      limit: options.limit ?? null,
      offset: options.offset ?? 0,
      projectPath: session.project_path ?? '',
      providerSessionId: session.provider_session_id,
    });

    await upgradeHeicAttachmentsToImages(result.messages);

    return {
      ...result,
      messages: result.messages.map((message) => ({
        ...message,
        sessionId,
      })),
    };
  },

  /**
   * Resolves one session (by app id, falling back to the provider-native id)
   * to its metadata plus the owning project.
   *
   * This backs deep links like `/session/:sessionId`: the frontend's paginated
   * project payloads only carry each project's first session page, so a
   * session opened directly by URL may not be present client-side at all —
   * this lookup is the authoritative way to learn which project owns it.
   */
  getSessionDetailsById(sessionId: string): SessionDetails {
    const session =
      sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }
    assertSessionProviderAllowed(session.provider);

    const projectPath = session.project_path?.trim() ? session.project_path : null;
    const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;

    return {
      sessionId: session.session_id,
      provider: session.provider as LLMProvider,
      summary: session.custom_name?.trim() || '',
      createdAt: session.created_at ?? null,
      updatedAt: session.updated_at ?? null,
      lastActivity: session.updated_at ?? session.created_at ?? null,
      isArchived: Boolean(session.isArchived),
      project: project && projectPath
        ? {
            projectId: project.project_id,
            path: projectPath,
            fullPath: projectPath,
            displayName: resolveProjectDisplayName(projectPath, project.custom_project_name),
            isStarred: Boolean(project.isStarred),
            isArchived: Boolean(project.isArchived),
            // Блок папки: без него чат второго сервера, открытый ссылкой,
            // выглядел бы в интерфейсе чатом основного.
            serverScope: normalizeServerScope(project.server_scope),
          }
        : null,
    };
  },

  /**
   * Returns archived sessions with enough project metadata for the sidebar to
   * group, filter, open, and restore them without a per-row follow-up query.
   */
  listArchivedSessions(): ArchivedSessionListItem[] {
    const requestContext = getRequestRuntimeContext();
    const canUseCodex = requestContext === undefined
      || isCodexAllowedForWebUser(requestContext.userId);
    const archivedSessions = sessionsDb.getArchivedSessions(
      canUseCodex ? 'shared-codex' : 'hide-codex',
    );
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();

    return archivedSessions.map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      return {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectPath,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        createdAt: session.created_at ?? null,
        updatedAt: session.updated_at ?? null,
        lastActivity: session.updated_at ?? session.created_at ?? null,
        isProjectArchived: Boolean(project?.isArchived),
        // Блок верхней панели: архив тоже делится на блоки, иначе дела
        // второго сервера всплывали бы в архиве обычных «Проектов».
        serverScope: normalizeServerScope(session.server_scope ?? project?.server_scope),
      };
    });
  },

  /**
   * Archives or permanently deletes one persisted session row by id.
   *
   * Soft-delete mirrors the project behavior by toggling `isArchived` so the
   * row disappears from active lists but remains restorable. Force-delete
   * optionally removes the transcript file before deleting the database row.
   */
  async deleteOrArchiveSessionById(
    sessionId: string,
    options: {
      force?: boolean;
      deletedFromDisk?: boolean;
    } = {},
  ): Promise<{ sessionId: string; action: 'archived' | 'deleted'; deletedFromDisk: boolean }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (!options.force) {
      sessionsDb.updateSessionIsArchived(sessionId, true);
      return {
        sessionId,
        action: 'archived',
        deletedFromDisk: false,
      };
    }

    let removedFromDisk = false;
    if (options.deletedFromDisk && session.jsonl_path) {
      removedFromDisk = await removeFileIfExists(session.jsonl_path);
    }

    const deleted = sessionsDb.deleteSessionById(sessionId);
    if (!deleted) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    return {
      sessionId,
      action: 'deleted',
      deletedFromDisk: removedFromDisk,
    };
  },

  /**
   * Restores one archived session back into the active sidebar lists.
   */
  restoreSessionById(sessionId: string): { sessionId: string; isArchived: false } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionIsArchived(sessionId, false);
    return { sessionId, isArchived: false };
  },

  /**
   * Renames one session by id without requiring the caller to pass provider.
   */
  renameSessionById(sessionId: string, summary: string): { sessionId: string; summary: string } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.renameSessionByUser(sessionId, summary);
    return { sessionId, summary };
  },
};

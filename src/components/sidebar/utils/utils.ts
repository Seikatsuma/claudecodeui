import type { TFunction } from 'i18next';

import type { LLMProvider, Project, ProjectSession } from '../../../types/app';
import type { ProjectSortOrder, SettingsProject, SessionViewModel, SessionWithProvider } from '../types/types';

export const formatCompactAge = (
  dateString: string | null | undefined,
  currentTime: Date,
): string => {
  if (!dateString) return '';

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '';

  const minutes = Math.floor(Math.max(0, currentTime.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин`;

  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} ч` : `${Math.floor(hours / 24)} дн`;
};

/**
 * Раскладка списка бесед по дням — «Сегодня», «Вчера», «7 дней» и так далее.
 *
 * Плоский список из полусотни строк читается плохо: все они выглядят
 * одинаково, и чтобы понять, где вчерашняя работа, приходится вглядываться в
 * возраст у каждой. Заголовок со счётчиком отвечает на это сразу. Так же
 * устроены списки в панели Клода для VS Code и на claude.ai.
 */
export type RecencyBucketKey = 'today' | 'yesterday' | 'week' | 'month' | 'older' | 'undated';

export const RECENCY_BUCKET_TITLES: Record<RecencyBucketKey, string> = {
  today: 'Сегодня',
  yesterday: 'Вчера',
  week: 'Последние 7 дней',
  month: 'Последние 30 дней',
  older: 'Раньше',
  undated: 'Без даты',
};

const BUCKET_ORDER: RecencyBucketKey[] = ['today', 'yesterday', 'week', 'month', 'older', 'undated'];

/** В какую корзину попадает дата. Считаем по календарным суткам, не по часам:
 *  беседа в 23:50 вчера — это «Вчера», а не «7 часов назад». */
export const recencyBucketOf = (
  dateString: string | null | undefined,
  currentTime: Date,
): RecencyBucketKey => {
  if (!dateString) return 'undated';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return 'undated';

  const startOfToday = new Date(
    currentTime.getFullYear(),
    currentTime.getMonth(),
    currentTime.getDate(),
  ).getTime();
  const days = Math.floor((startOfToday - date.getTime()) / 86400000);

  if (days < 0) return 'today';
  if (days < 1) return 'yesterday';
  if (days < 7) return 'week';
  if (days < 30) return 'month';
  return 'older';
};

/** Группы в естественном порядке; пустые не возвращаются. */
export const groupByRecency = <T,>(
  items: T[],
  currentTime: Date,
  dateOf: (item: T) => string | null | undefined,
): { key: RecencyBucketKey; title: string; items: T[] }[] => {
  const buckets = new Map<RecencyBucketKey, T[]>();
  for (const item of items) {
    const key = recencyBucketOf(dateOf(item), currentTime);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(key, [item]);
    }
  }
  return BUCKET_ORDER.filter((key) => buckets.get(key)?.length).map((key) => ({
    key,
    title: RECENCY_BUCKET_TITLES[key],
    items: buckets.get(key) as T[],
  }));
};

export const readProjectSortOrder = (): ProjectSortOrder => {
  try {
    const rawSettings = localStorage.getItem('claude-settings');
    if (!rawSettings) {
      return 'name';
    }

    const settings = JSON.parse(rawSettings) as { projectSortOrder?: ProjectSortOrder };
    return settings.projectSortOrder === 'date' ? 'date' : 'name';
  } catch {
    return 'name';
  }
};

const LEGACY_STARRED_PROJECTS_STORAGE_KEY = 'starredProjects';

/**
 * Reads legacy project stars from localStorage (used only for one-time migration to backend).
 */
export const readLegacyStarredProjectIds = (): string[] => {
  try {
    const saved = localStorage.getItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
    if (!saved) {
      return [];
    }

    const parsed = JSON.parse(saved) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
};

/**
 * Clears the legacy localStorage stars key after migration to backend completes.
 */
export const clearLegacyStarredProjectIds = () => {
  try {
    localStorage.removeItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
  } catch {
    // Keep UI responsive even if storage is unavailable.
  }
};

const getCreatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.createdAt || session.created_at || '');
};

const getUpdatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.lastActivity || '');
};

const getSessionProvider = (session: ProjectSession): LLMProvider => {
  const provider = session.__provider ?? session.provider;
  return typeof provider === 'string' && provider.trim()
    ? provider as LLMProvider
    : 'claude';
};

export const getSessionDate = (session: SessionWithProvider): Date => {
  return new Date(getUpdatedTimestamp(session) || getCreatedTimestamp(session) || 0);
};

export const getSessionName = (session: SessionWithProvider, t: TFunction): string => {
  return session.summary || session.name || t('projects.newSession');
};

export const getSessionTime = (session: SessionWithProvider): string => {
  return getUpdatedTimestamp(session) || getCreatedTimestamp(session);
};

export const createSessionViewModel = (
  session: SessionWithProvider,
  currentTime: Date,
  t: TFunction,
): SessionViewModel => {
  const sessionDate = getSessionDate(session);
  const diffInMinutes = Math.floor((currentTime.getTime() - sessionDate.getTime()) / (1000 * 60));

  return {
    isActive: diffInMinutes < 10,
    sessionName: getSessionName(session, t),
    sessionTime: getSessionTime(session),
    messageCount: Number(session.messageCount || 0),
  };
};

export const getAllSessions = (project: Project): SessionWithProvider[] => {
  return (project.sessions || []).map((session) => ({
    ...session,
    __provider: getSessionProvider(session),
  })).sort(
    (a, b) => getSessionDate(b).getTime() - getSessionDate(a).getTime(),
  );
};

export const getProjectLastActivity = (project: Project): Date => {
  const sessions = getAllSessions(project);
  if (sessions.length === 0) {
    return new Date(0);
  }

  return sessions.reduce((latest, session) => {
    const sessionDate = getSessionDate(session);
    return sessionDate > latest ? sessionDate : latest;
  }, new Date(0));
};

export const sortProjects = (
  projects: Project[],
  projectSortOrder: ProjectSortOrder,
): Project[] => {
  const byName = [...projects];

  byName.sort((projectA, projectB) => {
    // Star order now comes from backend `projects.isStarred`.
    const aStarred = Boolean(projectA.isStarred);
    const bStarred = Boolean(projectB.isStarred);

    if (aStarred && !bStarred) {
      return -1;
    }

    if (!aStarred && bStarred) {
      return 1;
    }

    if (projectSortOrder === 'date') {
      return getProjectLastActivity(projectB).getTime() - getProjectLastActivity(projectA).getTime();
    }

    return (projectA.displayName || projectA.projectId).localeCompare(projectB.displayName || projectB.projectId);
  });

  return byName;
};

export const filterProjects = (projects: Project[], searchFilter: string): Project[] => {
  const normalizedSearch = searchFilter.trim().toLowerCase();
  if (!normalizedSearch) {
    return projects;
  }

  return projects.filter((project) => {
    const displayName = (project.displayName || project.projectId).toLowerCase();
    // `project.path`/`fullPath` is the most useful search target now that the
    // folder-derived name is gone; fall back to displayName above.
    const searchPath = (project.path || project.fullPath || '').toLowerCase();
    return displayName.includes(normalizedSearch) || searchPath.includes(normalizedSearch);
  });
};

export const getTaskIndicatorStatus = (
  project: Project,
  mcpServerStatus: { hasMCPServer?: boolean; isConfigured?: boolean } | null,
) => {
  const projectConfigured = Boolean(project.taskmaster?.hasTaskmaster);
  const mcpConfigured = Boolean(mcpServerStatus?.hasMCPServer && mcpServerStatus?.isConfigured);

  if (projectConfigured && mcpConfigured) {
    return 'fully-configured';
  }

  if (projectConfigured) {
    return 'taskmaster-only';
  }

  if (mcpConfigured) {
    return 'mcp-only';
  }

  return 'not-configured';
};

export const normalizeProjectForSettings = (project: Project): SettingsProject => {
  const fallbackPath =
    typeof project.fullPath === 'string' && project.fullPath.length > 0
      ? project.fullPath
      : typeof project.path === 'string'
        ? project.path
        : '';

  // Legacy SettingsProject still expects a `name` field; use the projectId so
  // downstream consumers that rely on a stable identifier continue to work.
  return {
    name: project.projectId,
    displayName:
      typeof project.displayName === 'string' && project.displayName.trim().length > 0
        ? project.displayName
        : project.projectId,
    fullPath: fallbackPath,
    path:
      typeof project.path === 'string' && project.path.length > 0
        ? project.path
        : fallbackPath,
  };
};

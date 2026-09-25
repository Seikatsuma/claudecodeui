import { useCallback, useEffect, useRef, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import { useAuth } from '../components/auth/context/AuthContext';
import type { Project, ProjectSession } from '../types/app';
import { api } from '../utils/api';
import { getSessionTitle } from '../utils/pageTitle';

import { MAX_OPEN_TABS, capTabs } from './openTabsLimit';

/**
 * A session the user has explicitly opened, rendered as a tab above the chat
 * area (mirrors the open-editor-tabs strip in VS Code's Claude Code
 * extension). Only sessions the user actually navigated to end up here —
 * never the full sidebar list.
 */
export type OpenSessionTab = {
  sessionId: string;
  projectId?: string;
  provider?: string;
  title: string;
};

type StoredTab = {
  sessionId: string;
  projectId?: string;
  provider?: string;
  title?: string;
  /** Когда вкладку последний раз открывали (мс). */
  openedAt?: number;
};


/**
 * Вкладки хранятся у КАЖДОГО пользователя отдельно.
 *
 * Ключ был один на весь браузер. 12.09.26 Егор открыл ссылку второго
 * пользователя в своём браузере — и над пустым списком чужого рабочего стола
 * висели его собственные вкладки с названиями его разговоров. Сервер здесь ни
 * при чём: это остаток его входа в том же браузере, но выглядит как утечка и
 * по сути ею является — названия чужих чатов видны тому, кто вошёл не под
 * собой.
 *
 * Имя пользователя в ключе разводит их полностью: в одном браузере можно
 * держать два входа, и вкладки не перемешаются.
 */
const STORAGE_KEY_PREFIX = 'open-session-tabs';

const storageKeyFor = (userKey: string | null): string =>
  userKey ? `${STORAGE_KEY_PREFIX}:${userKey}` : STORAGE_KEY_PREFIX;

const readStoredTabs = (userKey: string | null): StoredTab[] => {
  try {
    const raw = localStorage.getItem(storageKeyFor(userKey));
    if (!raw) return [];

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((entry): entry is StoredTab =>
        Boolean(entry) && typeof (entry as StoredTab).sessionId === 'string' && (entry as StoredTab).sessionId.trim().length > 0)
      .map((entry) => ({
        sessionId: entry.sessionId,
        projectId: typeof entry.projectId === 'string' ? entry.projectId : undefined,
        provider: typeof entry.provider === 'string' ? entry.provider : undefined,
        title: typeof entry.title === 'string' ? entry.title : undefined,
        openedAt: typeof entry.openedAt === 'number' && Number.isFinite(entry.openedAt) ? entry.openedAt : undefined,
      }));
  } catch {
    return [];
  }
};

const writeStoredTabs = (userKey: string | null, tabs: StoredTab[]) => {
  try {
    localStorage.setItem(storageKeyFor(userKey), JSON.stringify(tabs));
  } catch {
    // Storage unavailable/full: tabs simply won't survive a reload.
  }
};

/**
 * Вкладки одни на все устройства пользователя (Егор 16.09.26: «чтобы порядок
 * на телефоне и на компьютере был одинаковым, и список чатов тоже»).
 *
 * localStorage остаётся быстрым кэшем для первого кадра, правда — на сервере
 * (`/api/open-tabs`, номер версии). Страница спрашивает сервер при запуске,
 * при возвращении на неё (включили телефон, переключились на окно) и раз в
 * 15 секунд, пока она видна. Своё изменение уходит на сервер через 300 мс;
 * пока оно не записано, чужой список не накатывается — иначе только что
 * открытая или переставленная вкладка отскочила бы назад.
 *
 * Первый заход устройства (версии в кэше нет) не теряет его вкладок: к списку
 * с сервера дописываются местные, которых там нет. Дальше сервер главный.
 *
 * Сокетом не рассылаем нарочно: страница старой сборки показала бы
 * незнакомое событие строкой в ленте.
 */
const SYNC_POLL_MS = 15000;
const SYNC_PUSH_DELAY_MS = 300;

const syncVersionKeyFor = (userKey: string | null): string => `${storageKeyFor(userKey)}:version`;

const readSyncVersion = (userKey: string | null): number | null => {
  try {
    const raw = localStorage.getItem(syncVersionKeyFor(userKey));
    const value = raw === null ? NaN : Number(raw);
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
};

const writeSyncVersion = (userKey: string | null, version: number) => {
  try {
    localStorage.setItem(syncVersionKeyFor(userKey), String(version));
  } catch {
    // без кэша версии следующий заход просто сольёт списки ещё раз
  }
};

/** Одинаковый вид списка для сравнения: порядок полей, без пустых. */
const serializeTabs = (tabs: StoredTab[]): string =>
  JSON.stringify(tabs.map((tab) => ({
    sessionId: tab.sessionId,
    ...(tab.projectId ? { projectId: tab.projectId } : {}),
    ...(tab.provider ? { provider: tab.provider } : {}),
    ...(tab.title ? { title: tab.title } : {}),
    ...(tab.openedAt ? { openedAt: tab.openedAt } : {}),
  })));

type ServerTabsState = { version: number; tabs: StoredTab[] };

const readServerState = async (response: Response): Promise<ServerTabsState | null> => {
  if (response.status === 204 || !response.ok) return null;
  const body = (await response.json()) as { version?: unknown; tabs?: unknown };
  if (!Number.isInteger(body.version) || !Array.isArray(body.tabs)) return null;
  return {
    version: body.version as number,
    tabs: (body.tabs as StoredTab[]).filter((tab) => tab && typeof tab.sessionId === 'string'),
  };
};

const findSessionInProjects = (
  projects: Project[],
  sessionId: string,
): { session: ProjectSession; project: Project } | null => {
  for (const project of projects) {
    const session = project.sessions?.find((candidate) => candidate.id === sessionId);
    if (session) {
      return { session, project };
    }
  }
  return null;
};

type UseOpenSessionTabsArgs = {
  /** Full project/session tree from `useProjectsState`, used to keep tab titles live. */
  projects: Project[];
  /** The session currently being viewed (`selectedSession?.id ?? sessionId` upstream). */
  activeSessionId: string | null;
  /** Resolved session object for `activeSessionId`, when available (may lag by a tick). */
  activeSession: ProjectSession | null;
  navigate: NavigateFunction;
};

export function useOpenSessionTabs({ projects, activeSessionId, activeSession, navigate }: UseOpenSessionTabsArgs) {
  const { user } = useAuth();
  const userKey = user?.id != null ? String(user.id) : (user?.username ?? null);

  const [tabs, setTabs] = useState<StoredTab[]>(() => readStoredTabs(userKey));
  const hasHydratedRef = useRef(false);
  const loadedUserKeyRef = useRef(userKey);

  // Сменился пользователь — берём ЕГО вкладки, а не оставляем прежние.
  // Иначе после входа по чужой ссылке над пустым рабочим столом висели бы
  // названия разговоров того, кто сидел в этом браузере до тебя.
  useEffect(() => {
    if (loadedUserKeyRef.current === userKey) return;
    loadedUserKeyRef.current = userKey;
    hasHydratedRef.current = false;
    setTabs(readStoredTabs(userKey));
  }, [userKey]);

  // Skip the very first write so a freshly-read (and therefore identical)
  // value doesn't cause a pointless localStorage write on mount.
  useEffect(() => {
    if (!hasHydratedRef.current) {
      hasHydratedRef.current = true;
      return;
    }
    writeStoredTabs(userKey, tabs);
  }, [tabs, userKey]);

  // ── Общие вкладки с сервером ──────────────────────────────────────────
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Сверх 15 — откуда бы ни пришёл список (сервер, другое устройство, старый
  // кэш) — лишние уходят здесь; дальше обычная отправка на сервер.
  useEffect(() => {
    if (tabs.length > MAX_OPEN_TABS) setTabs((previous) => capTabs(previous, activeSessionIdRef.current));
  }, [tabs]);
  const syncRef = useRef({
    ready: false,
    version: null as number | null,
    syncedJson: '',
    pushTimer: 0,
    pushing: false,
    fetching: false,
    /** Растёт при смене пользователя: ответ сверки под прежним отбрасывается. */
    generation: 0,
    /** Первая отправка устройства — дописать на сервере, а не заменить. */
    mergeNext: false,
    /** Есть местное изменение, ещё не записанное на сервер (например, не было сети). */
    dirty: false,
  });

  // Накатить список с сервера. Если отсюда пропал чат, открытый на ЭТОМ
  // устройстве, — его закрыли на другом: уходим к соседней вкладке, как при
  // закрытии крестиком. Иначе правило «открытый чат всегда во вкладках»
  // вернуло бы вкладку и отменило закрытие на всех устройствах.
  const applyRemote = useCallback((remote: StoredTab[], followClose = true) => {
    const previous = tabsRef.current;
    const activeId = activeSessionIdRef.current;
    const remoteIds = new Set(remote.map((tab) => tab.sessionId));
    if (followClose && activeId && !remoteIds.has(activeId) && previous.some((tab) => tab.sessionId === activeId)) {
      const index = previous.findIndex((tab) => tab.sessionId === activeId);
      const neighbour = [...previous.slice(index + 1), ...previous.slice(0, index).reverse()]
        .find((tab) => remoteIds.has(tab.sessionId));
      navigateRef.current(neighbour ? `/session/${neighbour.sessionId}` : '/');
    }
    tabsRef.current = remote;
    setTabs(remote);
  }, []);

  const pushTabs = useCallback(async (keepalive = false) => {
    const sync = syncRef.current;
    if (sync.pushTimer) window.clearTimeout(sync.pushTimer);
    sync.pushTimer = 0;
    if (userKey === null) return;
    if (sync.pushing) {
      sync.pushTimer = window.setTimeout(() => void pushTabs(keepalive), SYNC_PUSH_DELAY_MS);
      return;
    }
    const json = serializeTabs(tabsRef.current);
    if (json === sync.syncedJson && !sync.mergeNext) return;
    const merge = sync.mergeNext;
    sync.pushing = true;
    try {
      const state = await readServerState(await api.openTabs.put(JSON.parse(json), keepalive, merge));
      if (state) {
        sync.dirty = serializeTabs(tabsRef.current) !== json;
        sync.mergeNext = false;
        sync.version = state.version;
        sync.syncedJson = serializeTabs(state.tabs);
        writeSyncVersion(userKey, state.version);
        // Слияние на сервере могло добавить вкладки другого устройства.
        if (merge && sync.syncedJson !== serializeTabs(tabsRef.current)) applyRemote(state.tabs, false);
      }
    } catch {
      // сеть пропала — повторим при следующем изменении или опросе
    } finally {
      sync.pushing = false;
    }
  }, [applyRemote, userKey]);

  const pullTabs = useCallback(async () => {
    const sync = syncRef.current;
    // Пока пользователь не известен, сверять нечего: кэш и номер версии
    // лежат под его именем (гонка при запуске 16.09.26 теряла местные вкладки).
    if (userKey === null || sync.fetching) return;
    sync.fetching = true;
    const generation = sync.generation;
    try {
      const response = await api.openTabs.get(sync.ready && sync.version !== null ? sync.version : undefined);
      const state = await readServerState(response);
      if (generation !== sync.generation) return;
      // Пока своё изменение не записано, чужой список не трогает экран.
      if (sync.pushTimer || sync.pushing) return;
      // Своё не дошло до сервера (сеть) — не затирать его, а отправить снова.
      if (sync.ready && sync.dirty) {
        sync.pushTimer = window.setTimeout(() => void pushTabs(), SYNC_PUSH_DELAY_MS);
        return;
      }
      if (!state) return;

      if (!sync.ready) {
        sync.ready = true;
        const local = tabsRef.current;
        const neverSynced = readSyncVersion(userKey) === null;
        let next = state.tabs;
        if (neverSynced || state.version === 0) {
          // Первая сверка устройства: серверные + местные, которых там нет.
          // Отправка идёт слиянием на сервере — если другое устройство успело
          // записать своё между нашим чтением и записью, его вкладки останутся.
          const known = new Set(state.tabs.map((tab) => tab.sessionId));
          next = [...state.tabs, ...local.filter((tab) => !known.has(tab.sessionId))];
          sync.mergeNext = next.length > state.tabs.length;
        } else {
          // Чат, открытый на этом устройстве прямо сейчас (например, по ссылке
          // до первой сверки), остаётся вкладкой — закрытием это не было.
          const activeId = activeSessionIdRef.current;
          const activeTab = activeId ? local.find((tab) => tab.sessionId === activeId) : undefined;
          if (activeTab && !state.tabs.some((tab) => tab.sessionId === activeId)) next = [...state.tabs, activeTab];
        }
        sync.version = state.version;
        sync.syncedJson = serializeTabs(state.tabs);
        // Отметку «сверено» в кэш — только когда кэш и сервер совпадают. Иначе
        // её ставит отправка. Страница при первом заходе сама перезагружается
        // (обновление сборки); отметка до отправки заставляла вторую загрузку
        // довериться серверу и терять местные вкладки (16.09.26).
        if (serializeTabs(next) === sync.syncedJson) writeSyncVersion(userKey, state.version);
        if (serializeTabs(next) !== serializeTabs(local)) applyRemote(next, false);
        if (serializeTabs(next) !== sync.syncedJson) {
          sync.dirty = true;
          sync.pushTimer = window.setTimeout(() => void pushTabs(), SYNC_PUSH_DELAY_MS);
        }
        return;
      }

      sync.version = state.version;
      sync.syncedJson = serializeTabs(state.tabs);
      writeSyncVersion(userKey, state.version);
      if (sync.syncedJson !== serializeTabs(tabsRef.current)) applyRemote(state.tabs);
    } catch {
      // нет сети — спросим на следующем круге
    } finally {
      sync.fetching = false;
    }
  }, [applyRemote, pushTabs, userKey]);

  // Своё изменение — на сервер (после первой сверки, чтобы не затереть
  // серверный список устаревшим кэшем этого устройства).
  useEffect(() => {
    const sync = syncRef.current;
    if (!sync.ready || serializeTabs(tabs) === sync.syncedJson) return;
    sync.dirty = true;
    if (sync.pushTimer) window.clearTimeout(sync.pushTimer);
    sync.pushTimer = window.setTimeout(() => void pushTabs(), SYNC_PUSH_DELAY_MS);
  }, [tabs, pushTabs]);

  // Сверка: при запуске, при возвращении на страницу и раз в 15 с, пока видна.
  useEffect(() => {
    const sync = syncRef.current;
    sync.generation += 1;
    sync.fetching = false;
    sync.ready = false;
    sync.version = null;
    sync.syncedJson = '';
    sync.dirty = false;
    sync.mergeNext = false;
    void pullTabs();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void pullTabs();
      // Уходим со страницы — несохранённое изменение отправить сейчас, а не через 300 мс.
      else if (sync.pushTimer) void pushTabs(true);
    };
    const onPageHide = () => {
      if (sync.pushTimer) void pushTabs(true);
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void pullTabs();
    }, SYNC_POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('focus', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      window.clearInterval(timer);
      if (sync.pushTimer) {
        window.clearTimeout(sync.pushTimer);
        sync.pushTimer = 0;
      }
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [pullTabs, pushTabs]);

  // Whatever session is currently being viewed always gets a tab — this is
  // the single funnel that covers sidebar clicks, archived-session opens,
  // search results, notifications and deep links alike, without ever having
  // to enumerate every place session navigation can be triggered from.
  const stampedSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeSessionId) {
      stampedSessionIdRef.current = null;
      return;
    }
    // Отметка «открывали» — только при переходе на чат, а не на каждое
    // обновление списка чатов (иначе вкладки уходили бы на сервер непрерывно).
    const openedAt = stampedSessionIdRef.current !== activeSessionId ? Date.now() : undefined;
    stampedSessionIdRef.current = activeSessionId;

    setTabs((previous) => {
      const existingIndex = previous.findIndex((tab) => tab.sessionId === activeSessionId);
      const liveMatch = findSessionInProjects(projects, activeSessionId);
      const activeMatchesSession = activeSession?.id === activeSessionId ? activeSession : null;

      const resolvedTitle = liveMatch
        ? getSessionTitle(liveMatch.session)
        : activeMatchesSession
          ? getSessionTitle(activeMatchesSession)
          : undefined;
      const resolvedProjectId = liveMatch?.project.projectId ?? activeMatchesSession?.__projectId;
      const resolvedProvider = liveMatch?.session.__provider ?? activeMatchesSession?.__provider;

      if (existingIndex === -1) {
        return capTabs([
          ...previous,
          {
            sessionId: activeSessionId,
            projectId: resolvedProjectId,
            provider: resolvedProvider,
            title: resolvedTitle,
            openedAt: openedAt ?? Date.now(),
          },
        ], activeSessionId);
      }

      const existing = previous[existingIndex];
      const needsUpdate =
        openedAt !== undefined ||
        (resolvedTitle !== undefined && resolvedTitle !== existing.title) ||
        (resolvedProjectId !== undefined && resolvedProjectId !== existing.projectId) ||
        (resolvedProvider !== undefined && resolvedProvider !== existing.provider);
      if (!needsUpdate) {
        return previous;
      }

      const next = [...previous];
      next[existingIndex] = {
        ...existing,
        title: resolvedTitle ?? existing.title,
        projectId: resolvedProjectId ?? existing.projectId,
        provider: resolvedProvider ?? existing.provider,
        openedAt: openedAt ?? existing.openedAt,
      };
      return next;
    });
  }, [activeSessionId, activeSession, projects]);

  // Keep titles fresh for background tabs too (renames, AI-generated titles
  // filling in after the fact, etc.) as sidebar data streams in.
  useEffect(() => {
    if (projects.length === 0) return;

    setTabs((previous) => {
      let changed = false;
      const next = previous.map((tab) => {
        const liveMatch = findSessionInProjects(projects, tab.sessionId);
        if (!liveMatch) return tab;

        const liveTitle = getSessionTitle(liveMatch.session);
        if (liveTitle === tab.title && liveMatch.project.projectId === tab.projectId) {
          return tab;
        }

        changed = true;
        return { ...tab, title: liveTitle, projectId: liveMatch.project.projectId };
      });
      return changed ? next : previous;
    });
  }, [projects]);

  const switchToTab = useCallback((sessionId: string) => {
    if (sessionId === activeSessionId) return;
    navigate(`/session/${sessionId}`);
  }, [activeSessionId, navigate]);

  const closeTab = useCallback((sessionId: string) => {
    setTabs((previous) => {
      const index = previous.findIndex((tab) => tab.sessionId === sessionId);
      if (index === -1) return previous;

      const next = previous.filter((tab) => tab.sessionId !== sessionId);

      if (activeSessionId === sessionId) {
        // Prefer the neighboring tab to the right, then the one to the left,
        // then fall back to the empty/new-session view — never a blank crash.
        const neighbor = previous[index + 1] ?? previous[index - 1] ?? null;
        if (neighbor) {
          navigate(`/session/${neighbor.sessionId}`);
        } else {
          navigate('/');
        }
      }

      return next;
    });
  }, [activeSessionId, navigate]);

  // Перетаскивание вкладки: порядок сохраняется в том же localStorage.
  const moveTab = useCallback((sessionId: string, toIndex: number) => {
    setTabs((previous) => {
      const from = previous.findIndex((tab) => tab.sessionId === sessionId);
      if (from === -1) return previous;
      const target = Math.max(0, Math.min(previous.length - 1, toIndex));
      if (from === target) return previous;
      const next = [...previous];
      const [moved] = next.splice(from, 1);
      next.splice(target, 0, moved);
      return next;
    });
  }, []);

  const removeTabsForSessions = useCallback((sessionIds: string[]) => {
    if (sessionIds.length === 0) return;
    const idsToRemove = new Set(sessionIds);
    setTabs((previous) => previous.filter((tab) => !idsToRemove.has(tab.sessionId)));
  }, []);

  const openTabs: OpenSessionTab[] = tabs.map((tab) => ({
    sessionId: tab.sessionId,
    projectId: tab.projectId,
    provider: tab.provider,
    title: tab.title?.trim() || 'New Session',
  }));

  return { openTabs, switchToTab, closeTab, moveTab, removeTabsForSessions };
}

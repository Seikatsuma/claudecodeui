import { useCallback, useSyncExternalStore } from 'react';

import type { Project } from '../../../types/app';

/*
 * Какой блок верхней панели открыт: «Проекты» (этот сервер) или второй
 * сервер. Егор 20.09.26: «есть проекты, а есть проекты 2 сервера; если я
 * захожу туда, открывается новый чат, который не мешается с проектами
 * обычного чата, и последние открытые чаты — отдельный список».
 *
 * Выбор живёт здесь, а не в состоянии панели: его спрашивают и шапка
 * (какая кнопка нажата), и список папок, и лента последних чатов, и
 * создание нового чата.
 *
 * НЕ помнится между заходами (Егор 22.09.26: «пишет, что я на втором
 * сервере, хотя я его не открывал»). Раньше выбор лежал в памяти телефона:
 * однажды нажатый «2-й…» тихо оставался включённым, и следующие новые чаты
 * и командная строка заводились в папке второго сервера. Теперь каждый заход
 * начинается с «Проекты», а второй блок включается только нажатием или
 * открытием чата, который ему принадлежит (AppContent сверяет блок с
 * открытым чатом).
 */
export type ServerScope = 'main' | 'second';

const STORAGE_KEY = 'sidebar-server-scope';
const listeners = new Set<() => void>();

// Старая запись о выбранном блоке больше не читается — стираем её, чтобы
// она не всплыла, если чтение когда-нибудь вернут.
try {
  if (typeof window !== 'undefined') localStorage.removeItem(STORAGE_KEY);
} catch {
  // Приватный режим Safari — записи и так нет.
}

let current: ServerScope = 'main';

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useServerScope(): [ServerScope, (next: ServerScope) => void] {
  const scope = useSyncExternalStore(subscribe, () => current, () => 'main' as ServerScope);
  const setScope = useCallback((next: ServerScope) => {
    if (next === current) return;
    current = next;
    listeners.forEach((listener) => listener());
  }, []);
  return [scope, setScope];
}

/** Блок, которому принадлежит чат: своё значение важнее значения папки. */
export function effectiveScope(
  sessionScope: ServerScope | null | undefined,
  projectScope: ServerScope | null | undefined,
): ServerScope {
  return sessionScope ?? projectScope ?? 'main';
}

/**
 * Папки и чаты одного блока. Папка попадает в блок, если сама к нему
 * приписана ИЛИ если в ней есть чат, перенесённый в этот блок поимённо:
 * перенос чата — признак в базе, файл переписки остаётся в своей папке,
 * поэтому чат виден там же, где и лежит, но в другом блоке. Без второго
 * блока (`hasSecondServer` = false) — всё как есть.
 * Одна функция на панель и главный экран: иначе они разойдутся в том, чей чат.
 */
export function scopeProjectsToServer(
  projects: Project[],
  serverScope: ServerScope,
  hasSecondServer: boolean,
): Project[] {
  if (!hasSecondServer) {
    return projects;
  }

  return projects.reduce<Project[]>((kept, project) => {
    const projectScope: ServerScope = project.serverScope ?? 'main';
    const allSessions = project.sessions ?? [];
    const sessions = allSessions.filter(
      (session) => effectiveScope(session.serverScope as ServerScope | null | undefined, projectScope) === serverScope,
    );

    if (projectScope !== serverScope && sessions.length === 0) {
      return kept;
    }

    kept.push(
      sessions.length === allSessions.length
        ? project
        : {
          ...project,
          sessions,
          sessionMeta: {
            hasMore: project.sessionMeta?.hasMore ?? false,
            total: sessions.length,
          },
        },
    );
    return kept;
  }, []);
}

/*
 * Название второго блока (SECOND_SERVER_LABEL на сервере, у общей площадки —
 * только хозяину). Лежит здесь же, а не ходит пропсами: его спрашивают шапка,
 * карточка чата и карточка папки — три конца панели, между которыми иначе
 * пришлось бы тянуть проп через четыре компонента.
 */
let secondServerLabel: string | null = null;
const labelListeners = new Set<() => void>();

function subscribeLabel(listener: () => void) {
  labelListeners.add(listener);
  return () => {
    labelListeners.delete(listener);
  };
}

export function setSecondServerLabel(next: string | null) {
  const normalized = next && next.trim().length > 0 ? next.trim() : null;
  if (normalized === secondServerLabel) return;
  secondServerLabel = normalized;
  labelListeners.forEach((listener) => listener());
}

export function useSecondServerLabel(): string | null {
  return useSyncExternalStore(subscribeLabel, () => secondServerLabel, () => null);
}

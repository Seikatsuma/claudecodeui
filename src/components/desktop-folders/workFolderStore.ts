import { useSyncExternalStore } from 'react';

import { getDesktopBridge, isDesktopApp } from '../../lib/desktopBridge';
import { authenticatedFetch } from '../../utils/api';

/**
 * Главная папка человека в программе на компьютере (настройки → «Папки»,
 * сервер: modules/desktop/desktop-settings.ts). Одна на страницу: её показывает
 * строка над полем ввода, первый экран и раздел настроек.
 */

type State = { loaded: boolean; workFolder: string | null };

let state: State = { loaded: false, workFolder: null };
const listeners = new Set<() => void>();
let requested = false;

const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};

export async function refreshWorkFolder(): Promise<void> {
  if (!isDesktopApp()) return;
  try {
    const response = await authenticatedFetch('/api/desktop/settings');
    const body = response.ok ? await response.json() : null;
    set({ loaded: true, workFolder: body?.data?.workFolder || null });
  } catch {
    set({ loaded: true });
  }
}

/** Системное окно выбора → сохранить главной папкой → открыть её слева с новым чатом. */
export async function chooseWorkFolder(): Promise<string | null> {
  const picked = await getDesktopBridge()?.pickFolder({ defaultPath: state.workFolder || undefined });
  if (!picked) return null;
  const response = await authenticatedFetch('/api/desktop/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workFolder: picked }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) throw new Error(body?.error || 'Не получилось сохранить папку — попробуйте ещё раз.');
  const saved = body.data?.workFolder || picked;
  set({ loaded: true, workFolder: saved });
  window.dispatchEvent(new CustomEvent('claudeui:open-folder-project', { detail: { path: saved } }));
  return saved;
}

export const openFolderPicker = (): void => {
  window.dispatchEvent(new CustomEvent('claudeui:open-new-project'));
};

/** Путь для человека: внутри главной папки — «Главная › Проекты › Отчёт», иначе полный. */
export function describeFolder(folderPath: string, workFolder: string | null): { label: string; inside: boolean } {
  const sep = folderPath.includes('\\') ? '\\' : '/';
  const trim = (value: string) => value.replace(/[\\/]+$/, '');
  const target = trim(folderPath);
  if (workFolder) {
    const root = trim(workFolder);
    const rootName = root.split(/[\\/]/).pop() || root;
    if (target.toLowerCase() === root.toLowerCase()) return { label: rootName, inside: true };
    if (target.toLowerCase().startsWith(`${root.toLowerCase()}${sep}`)) {
      return { label: [rootName, ...target.slice(root.length + 1).split(/[\\/]/)].join(' › '), inside: true };
    }
  }
  return { label: target, inside: false };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (!requested) {
    requested = true;
    void refreshWorkFolder();
  }
  return () => listeners.delete(listener);
};

export function useWorkFolder(): State {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

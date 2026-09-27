import { useSyncExternalStore } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { isDesktopApp } from '../../../lib/desktopBridge';

/**
 * Состояние входа в подписку Claude в настольной программе — одно на всю
 * страницу: его показывают полоса над полем ввода и настройки.
 *
 * Сервер (claude-desktop-login.ts) запускает вход вложенного Claude: браузер
 * открывается сам, после «Разрешить» вход возвращается в программу. Пока ждём —
 * спрашиваем сервер раз в полторы секунды.
 */

export type ClaudeLoginPhase = 'idle' | 'waiting' | 'success' | 'error';

export type ClaudeConnectState = {
  /** null — ещё не спрашивали. */
  loggedIn: boolean | null;
  email: string | null;
  subscriptionType: string | null;
  phase: ClaudeLoginPhase;
  url: string | null;
  message: string | null;
  codeSent: boolean;
  /** «/login» в чате или ошибка «не вошли» — показать карточку, даже если её свернули. */
  forcedOpen: boolean;
  /** Только что подключились — короткое «Готово». */
  justConnected: boolean;
};

const BASE = '/api/providers/claude/desktop-login';

let state: ClaudeConnectState = {
  loggedIn: null,
  email: null,
  subscriptionType: null,
  phase: 'idle',
  url: null,
  message: null,
  codeSent: false,
  forcedOpen: false,
  justConnected: false,
};
const listeners = new Set<() => void>();
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let loadedOnce = false;

const emit = (): void => {
  for (const listener of listeners) listener();
};

const setState = (patch: Partial<ClaudeConnectState>): void => {
  state = { ...state, ...patch };
  emit();
};

type ServerLogin = { phase: ClaudeLoginPhase; url: string | null; message: string | null; codeSent: boolean };
type ServerStatus = { loggedIn: boolean; email: string | null; subscriptionType: string | null } | null;

const readJson = async (response: Response): Promise<{ login?: ServerLogin; status?: ServerStatus } | null> => {
  try {
    const body = await response.json();
    return body && typeof body === 'object' && 'data' in body ? body.data : null;
  } catch {
    return null;
  }
};

const applyServer = (data: { login?: ServerLogin; status?: ServerStatus } | null): void => {
  if (!data) return;
  const patch: Partial<ClaudeConnectState> = {};
  if (data.login) {
    patch.phase = data.login.phase;
    patch.url = data.login.url;
    patch.message = data.login.message;
    patch.codeSent = data.login.codeSent;
  }
  if (data.status) {
    const wasLoggedIn = state.loggedIn;
    patch.loggedIn = data.status.loggedIn;
    patch.email = data.status.email;
    patch.subscriptionType = data.status.subscriptionType;
    if (data.status.loggedIn && wasLoggedIn === false) {
      patch.justConnected = true;
      patch.forcedOpen = false;
      window.dispatchEvent(new CustomEvent('claudeui:claude-connected'));
    }
  }
  setState(patch);
};

const schedulePoll = (): void => {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  if (state.phase !== 'waiting') return;
  pollTimer = setTimeout(() => { void refreshClaudeConnect(); }, 1500);
};

/** fresh — спросить Claude заново, минуя 10-секундный запас сервера (после ошибки «не вошли»). */
export async function refreshClaudeConnect(fresh = false): Promise<void> {
  if (!isDesktopApp()) return;
  try {
    const response = await authenticatedFetch(fresh ? `${BASE}?fresh=1` : BASE, { method: 'GET', headers: { 'Cache-Control': 'no-cache' } });
    if (response.ok) applyServer(await readJson(response));
  } catch {
    // сеть моргнула — спросим ещё раз при следующем действии
  }
  schedulePoll();
}

const post = async (path: string, body?: Record<string, unknown>): Promise<void> => {
  try {
    const response = await authenticatedFetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    applyServer(await readJson(response));
  } catch {
    setState({ phase: 'error', message: 'Программа не ответила. Попробуйте ещё раз.' });
  }
  schedulePoll();
};

export const startClaudeConnect = (): Promise<void> => {
  setState({ phase: 'waiting', message: null, url: null, codeSent: false, justConnected: false });
  return post('/start');
};
export const sendClaudeConnectCode = (code: string): Promise<void> => post('/code', { code });
export const cancelClaudeConnect = (): Promise<void> => post('/cancel');

/** «/login» в чате или ответ Claude «не вошли»: развернуть карточку и перепроверить вход. */
export function openClaudeConnect(): void {
  if (!isDesktopApp()) return;
  setState({ forcedOpen: true });
  void refreshClaudeConnect(true);
}

export const dismissJustConnected = (): void => setState({ justConnected: false, forcedOpen: false });

/** Ответ Claude, означающий «не вошли в подписку». */
export function isClaudeNotLoggedInText(text: unknown): boolean {
  if (typeof text !== 'string' || text.length > 600) return false;
  return /Not logged in|Please run \/login|\/login isn't available|OAuth token has expired|Invalid API key|authentication_error/i.test(text);
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  if (!loadedOnce) {
    loadedOnce = true;
    void refreshClaudeConnect();
  }
  return () => listeners.delete(listener);
};

export function useClaudeConnect(): ClaudeConnectState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

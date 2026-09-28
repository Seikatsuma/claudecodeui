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
  /** 'claude.ai' — свой вход через браузер; 'oauth_token' — годовой ключ с сервера аккаунтов. */
  authMethod: string | null;
  phase: ClaudeLoginPhase;
  url: string | null;
  message: string | null;
  codeSent: boolean;
  /** «/login» в чате или ошибка «не вошли» — показать карточку, даже если её свернули. */
  forcedOpen: boolean;
  /** Только что подключились — короткое «Готово». */
  justConnected: boolean;
  /**
   * Claude ответил «вход истёк» (401 OAuth access token has expired): вход лежит,
   * а не работает — `auth status` при этом всё равно говорит «вошли» (28.09.26,
   * снимок Егора). Показать «Войти заново», пока вход не обновится.
   */
  authExpired: boolean;
  /** Когда поймали «вход устарел» — нормальный ответ Claude позже этого снимает карточку. */
  authExpiredAt: number;
};

const BASE = '/api/providers/claude/desktop-login';

let state: ClaudeConnectState = {
  loggedIn: null,
  email: null,
  subscriptionType: null,
  authMethod: null,
  phase: 'idle',
  url: null,
  message: null,
  codeSent: false,
  forcedOpen: false,
  justConnected: false,
  authExpired: false,
  authExpiredAt: 0,
};
const listeners = new Set<() => void>();
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let loadedOnce = false;
/** Растёт на каждое действие (подключить, код, отмена): опрос, начатый раньше, устарел. */
let actionEpoch = 0;

const emit = (): void => {
  for (const listener of listeners) listener();
};

const setState = (patch: Partial<ClaudeConnectState>): void => {
  state = { ...state, ...patch };
  emit();
};

type ServerLogin = { phase: ClaudeLoginPhase; url: string | null; message: string | null; codeSent: boolean };
type ServerStatus = { loggedIn: boolean; email: string | null; subscriptionType: string | null; authMethod?: string | null } | null;

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
    if (data.login.phase === 'success' && state.phase === 'waiting') {
      patch.authExpired = false;
      patch.justConnected = true;
      patch.forcedOpen = false;
    }
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
    patch.authMethod = data.status.authMethod ?? null;
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
  const epoch = actionEpoch;
  try {
    const response = await authenticatedFetch(fresh ? `${BASE}?fresh=1` : BASE, { method: 'GET', headers: { 'Cache-Control': 'no-cache' } });
    if (response.ok && epoch === actionEpoch) applyServer(await readJson(response));
  } catch {
    // сеть моргнула — спросим ещё раз при следующем действии
  }
  schedulePoll();
}

const post = async (path: string, body?: Record<string, unknown>): Promise<void> => {
  actionEpoch += 1;
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

/** Ответ Claude, означающий «вход устарел»: вход лежит, но не работает. */
// Только точные сообщения самого Claude в начале текста: ответ, где Claude разбирает
// чужую ошибку «401», сюда не попадает (замечание проверяющего 28.09.26).
const EXPIRED_LOGIN = /^\s*(?:Claude Code returned an error result:\s*)?(?:Failed to authenticate\b|Failed to refresh OAuth token\b|OAuth (?:access )?token has expired\b)/i;

export function isClaudeLoginExpiredText(text: unknown): boolean {
  return typeof text === 'string' && text.length <= 600 && EXPIRED_LOGIN.test(text);
}

/** Ответ Claude, означающий «не вошли в подписку» или «вход устарел». */
export function isClaudeNotLoggedInText(text: unknown): boolean {
  if (typeof text !== 'string' || text.length > 600) return false;
  return EXPIRED_LOGIN.test(text)
    || /Not logged in|Please run \/login|\/login isn't available|Invalid API key|authentication_error/i.test(text);
}

/** Чат получил «вход устарел» — развернуть карточку с «Войти заново». */
export function markClaudeLoginExpired(at: number = Date.now()): void {
  if (!isDesktopApp() || at <= state.authExpiredAt) return;
  setState({ authExpired: true, authExpiredAt: at, forcedOpen: true, justConnected: false });
}

/**
 * Claude нормально ответил позже ошибки — вход жив (сам продлился, вошли в
 * терминале или другим аккаунтом), карточку «устарел» убрать.
 */
export function noteClaudeAnsweredAt(at: number): void {
  if (state.authExpired && at > state.authExpiredAt) setState({ authExpired: false, forcedOpen: false });
}

export const dismissClaudeLoginExpired = (): void => setState({ authExpired: false, forcedOpen: false });

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

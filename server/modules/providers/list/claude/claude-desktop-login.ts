import type { ChildProcess } from 'node:child_process';

import spawn from 'cross-spawn';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';

/**
 * Вход в подписку Claude из настольной программы — без чёрного окна.
 *
 * Запускаем вложенный Claude командой `auth login --claudeai`: он сам открывает
 * браузер со страницей «Разрешить», а после нажатия браузер возвращает ответ на
 * этот же компьютер (localhost), и вход записывается туда же, где его хранит
 * Claude Code (на Mac — «Связка ключей»). Если браузер вместо этого показал код,
 * человек вставляет его в карточку — пишем код в стандартный ввод процесса.
 *
 * Работает только в программе (CLAUDE_UI_DESKTOP=1): на сайте браузер открылся бы
 * на сервере, там остаётся вход через терминал.
 */

export type DesktopLoginPhase = 'idle' | 'waiting' | 'success' | 'error';

export type DesktopLoginState = {
  phase: DesktopLoginPhase;
  /** Запасная ссылка входа (страница покажет код), если браузер не открылся сам. */
  url: string | null;
  message: string | null;
  startedAt: number | null;
  codeSent: boolean;
};

export type ClaudeCliAuthStatus = {
  loggedIn: boolean;
  email: string | null;
  subscriptionType: string | null;
  authMethod: string | null;
};

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const CANNOT_START = 'Не получилось запустить вход: внутри программы не нашёлся Claude. Скачайте программу заново со страницы скачивания и установите поверх.';
const STATUS_CACHE_MS = 10 * 1000;
const URL_PATTERN = /https:\/\/(?:[a-z0-9-]+\.)*(?:claude\.com|claude\.ai|anthropic\.com)\/\S*oauth\/authorize\S*/;

let child: ChildProcess | null = null;
let timeoutTimer: NodeJS.Timeout | null = null;
let output = '';
let state: DesktopLoginState = { phase: 'idle', url: null, message: null, startedAt: null, codeSent: false };
let statusCache: { at: number; value: ClaudeCliAuthStatus } | null = null;
/** Вход через браузер завершён — программа переходит на него с годового ключа (desktop-claude-accounts). */
let successListener: (() => void) | null = null;

export function setDesktopLoginSuccessListener(listener: (() => void) | null): void {
  successListener = listener;
}

export const isDesktopLoginEnabled = (): boolean => process.env.CLAUDE_UI_DESKTOP === '1';

// Программу закрыли посреди входа — не оставлять вход Claude висеть в фоне.
process.once('exit', () => {
  try { child?.kill(); } catch { /* уже завершён */ }
});

const cliPath = (): string => resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);

/** Окружение для входа: без ключа, пришедшего с сервера, — входим в собственное хранилище человека. */
const loginEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
};

const clearTimer = (): void => {
  if (timeoutTimer) clearTimeout(timeoutTimer);
  timeoutTimer = null;
};

/** Последняя осмысленная строка вывода — для понятной ошибки, без ссылок и кодов. */
const lastOutputLine = (): string | null => {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.replace(URL_PATTERN, '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim())
    .filter((line) => line && !/^Paste code here/i.test(line) && !/^Opening browser/i.test(line) && !/^If the browser/i.test(line));
  return lines.length ? lines[lines.length - 1].slice(0, 300) : null;
};

export function getDesktopLoginState(): DesktopLoginState {
  return { ...state };
}

export function startDesktopLogin(): DesktopLoginState {
  if (child && state.phase === 'waiting') return getDesktopLoginState();

  output = '';
  statusCache = null;
  state = { phase: 'waiting', url: null, message: null, startedAt: Date.now(), codeSent: false };

  let proc: ChildProcess;
  try {
    proc = spawn(cliPath(), ['auth', 'login', '--claudeai'], {
      env: loginEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    console.error('[claude-login] не запустился:', error);
    state = { ...state, phase: 'error', message: CANNOT_START };
    return getDesktopLoginState();
  }
  child = proc;

  const onChunk = (chunk: Buffer): void => {
    output = (output + chunk.toString('utf8')).slice(-20000);
    const match = output.match(URL_PATTERN);
    if (match && !state.url) state = { ...state, url: match[0] };
  };
  proc.stdout?.on('data', onChunk);
  proc.stderr?.on('data', onChunk);
  proc.stdin?.on('error', () => {});

  proc.on('error', (error) => {
    if (child !== proc) return;
    clearTimer();
    child = null;
    console.error('[claude-login] не запустился:', error);
    state = { ...state, phase: 'error', message: CANNOT_START };
  });

  proc.on('close', (code) => {
    if (child !== proc) return;
    clearTimer();
    child = null;
    statusCache = null;
    if (state.phase !== 'waiting') return;
    if (code === 0) {
      state = { ...state, phase: 'success', message: null };
      try { successListener?.(); } catch (error) { console.warn('[claude-login] не переключился на свой вход:', error); }
    } else {
      const detail = lastOutputLine();
      if (detail) console.warn('[claude-login] вход не завершён:', detail);
      state = {
        ...state,
        phase: 'error',
        message: state.codeSent
          ? 'Код не подошёл. Нажмите «Попробовать ещё раз» и скопируйте код со страницы целиком — он действует несколько минут.'
          : 'Вход не завершён. Нажмите «Попробовать ещё раз» — и в браузере «Разрешить».',
      };
    }
  });

  timeoutTimer = setTimeout(() => {
    if (child !== proc) return;
    state = { ...state, phase: 'error', message: 'Время ожидания вышло: подтверждение в браузере не пришло за 10 минут. Нажмите «Подключить» ещё раз.' };
    child = null;
    try { proc.kill(); } catch { /* уже завершён */ }
  }, LOGIN_TIMEOUT_MS);

  return getDesktopLoginState();
}

/** Код со страницы входа (если браузер показал код вместо возврата в программу). */
export function submitDesktopLoginCode(rawCode: string): DesktopLoginState {
  const code = rawCode.trim();
  if (!code || code.length > 2000 || /[\r\n]/.test(code)) {
    return { ...getDesktopLoginState(), message: 'Код пустой или слишком длинный — скопируйте его со страницы целиком.' };
  }
  if (!child || state.phase !== 'waiting' || !child.stdin) {
    return { ...getDesktopLoginState(), message: 'Вход уже не ждёт кода — нажмите «Подключить» ещё раз.' };
  }
  child.stdin.write(`${code}\n`);
  state = { ...state, codeSent: true };
  return getDesktopLoginState();
}

export function cancelDesktopLogin(): DesktopLoginState {
  const proc = child;
  child = null;
  clearTimer();
  if (proc) {
    try { proc.kill(); } catch { /* уже завершён */ }
  }
  state = { phase: 'idle', url: null, message: null, startedAt: null, codeSent: false };
  return getDesktopLoginState();
}

/**
 * Вошёл ли Claude — спрашиваем сам Claude (`auth status --json`): он знает все
 * места хранения входа, включая «Связку ключей» Mac, которую файлом не прочитать.
 */
export async function readClaudeCliAuthStatus(force = false): Promise<ClaudeCliAuthStatus | null> {
  if (!force && statusCache && Date.now() - statusCache.at < STATUS_CACHE_MS) return statusCache.value;
  const value = await runAuthStatus(process.env);
  if (value) statusCache = { at: Date.now(), value };
  return value;
}

/**
 * Собственный вход человека в Claude — без годового ключа с сервера аккаунтов.
 * Нужен, чтобы выбрать его: подключения аккаунта claude.ai (Google Диск, Gmail,
 * Календарь…) приходят только при таком входе, при годовом ключе — нет.
 */
export function readOwnClaudeLogin(): Promise<ClaudeCliAuthStatus | null> {
  return runAuthStatus(loginEnv());
}

export function clearClaudeAuthStatusCache(): void {
  statusCache = null;
}

function runAuthStatus(env: NodeJS.ProcessEnv): Promise<ClaudeCliAuthStatus | null> {
  return new Promise<ClaudeCliAuthStatus | null>((resolve) => {
    let text = '';
    let settled = false;
    const done = (result: ClaudeCliAuthStatus | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let proc: ChildProcess;
    try {
      proc = spawn(cliPath(), ['auth', 'status', '--json'], { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      done(null);
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      done(null);
    }, 15000);
    proc.stdout?.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
    proc.on('error', () => { clearTimeout(timer); done(null); });
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        done({
          loggedIn: parsed.loggedIn === true,
          email: typeof parsed.email === 'string' ? parsed.email : null,
          subscriptionType: typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : null,
          authMethod: typeof parsed.authMethod === 'string' ? parsed.authMethod : null,
        });
      } catch {
        done(null);
      }
    });
  });
}

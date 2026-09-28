import fs from 'node:fs';
import path from 'node:path';

import {
  clearClaudeAuthStatusCache,
  readOwnClaudeLogin,
  setDesktopLoginSuccessListener,
} from '@/modules/providers/list/claude/claude-desktop-login.js';

/**
 * Подписки Claude владельца в настольной программе: приходят готовыми с сервера
 * аккаунтов, без входа через «Настройки → Агенты».
 *
 * Сервер аккаунтов отдаёт программе годовые ключи Claude (`claude setup-token`:
 * отдельный ключ под другое устройство, вход на сервере от него не слетает),
 * программа передаёт их сюда одной переменной CLAUDE_UI_CLAUDE_ACCOUNTS.
 * Активный ключ кладём в CLAUDE_CODE_OAUTH_TOKEN: каждый запуск Claude берёт
 * окружение заново, так что переключение действует со следующего сообщения.
 * Список ключей из окружения сразу убираем — иначе его унаследовали бы команды,
 * которые Claude запускает на компьютере.
 *
 * Свой вход через браузер (`claude auth login --claudeai`) главнее ключа: только
 * при нём приходят подключения аккаунта claude.ai — Google Диск, Gmail, Календарь
 * и другие (при ключе setup-token Claude их не загружает). Поэтому: вошёл сам — ключ
 * убираем из окружения; выбрал подписку в переключателе — снова ключ.
 */

type DesktopClaudeAccount = { email: string; token: string };

let accounts: DesktopClaudeAccount[] = [];
let activeEmail: string | null = null;
let ownLoginActive = false;
// Подписку выбрали в переключателе, пока шла проверка своего входа, — выбор важнее.
let activeEmailChosenSinceStart = false;
let initialized = false;

type SavedChoice = { email: string | null; own: boolean };

const statePath = (): string | null => {
  const dbPath = process.env.DATABASE_PATH;
  return dbPath ? path.join(path.dirname(dbPath), 'claude-account.json') : null;
};

const readSavedChoice = (): SavedChoice => {
  const file = statePath();
  if (!file) return { email: null, own: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { email?: unknown; own?: unknown };
    return { email: typeof parsed.email === 'string' ? parsed.email : null, own: parsed.own === true };
  } catch {
    return { email: null, own: false };
  }
};

const saveChoice = (choice: { email?: string; own?: boolean }): void => {
  const file = statePath();
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(choice), 'utf8');
};

const apply = (email: string | null): void => {
  const account = accounts.find((item) => item.email === email) ?? accounts[0];
  if (!account) return;
  activeEmail = account.email;
  ownLoginActive = false;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = account.token;
  clearClaudeAuthStatusCache();
};

/** Перейти на свой вход через браузер: ключ из окружения убрать (со следующего сообщения). */
const useOwnLogin = (): void => {
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  activeEmail = null;
  ownLoginActive = true;
  clearClaudeAuthStatusCache();
};

const hasOwnClaudeAiLogin = async (): Promise<boolean> => {
  const own = await readOwnClaudeLogin();
  return Boolean(own?.loggedIn && own.authMethod === 'claude.ai');
};

/** Разбирает ключи из окружения один раз, при старте сервера программы. */
export function initDesktopClaudeAccounts(): void {
  if (initialized) return;
  initialized = true;
  const raw = process.env.CLAUDE_UI_CLAUDE_ACCOUNTS;
  delete process.env.CLAUDE_UI_CLAUDE_ACCOUNTS;
  if (process.env.CLAUDE_UI_DESKTOP !== '1' || !raw) return;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      accounts = parsed
        .map((item) => item as Partial<DesktopClaudeAccount>)
        .filter((item): item is DesktopClaudeAccount => (
          typeof item.email === 'string' && typeof item.token === 'string' && item.token.length > 20
        ));
    }
  } catch {
    accounts = [];
  }

  // Вход через браузер в программе завершился — сразу на него и запомнить выбор.
  setDesktopLoginSuccessListener(() => {
    useOwnLogin();
    saveChoice({ own: true });
  });
  if (!accounts.length) return;

  const saved = readSavedChoice();
  if (saved.email && !saved.own) {
    apply(saved.email); // подписку выбрали в переключателе сами — её и держим
    return;
  }
  // Пока проверяем свой вход (1–2 секунды) — работает ключ, чтобы первое сообщение не упало.
  apply(null);
  void hasOwnClaudeAiLogin().then((own) => {
    if (own && !activeEmailChosenSinceStart) useOwnLogin();
  }).catch(() => {});
}

export function hasDesktopClaudeAccounts(): boolean {
  return accounts.length > 0;
}

export function getDesktopClaudeActiveEmail(): string | null {
  return ownLoginActive ? null : activeEmail;
}

/** Тот же ответ, что у сайта (/api/user/owner-accounts): номер = место в списке с 1. */
export function listDesktopClaudeAccounts() {
  const activeIndex = accounts.findIndex((item) => item.email === activeEmail);
  return {
    success: true,
    activeSlot: !ownLoginActive && activeIndex >= 0 ? activeIndex + 1 : null,
    accounts: accounts.map((item, index) => ({ slot: index + 1, email: item.email, available: true })),
  };
}

export function activateDesktopClaudeAccount(slotInput: unknown) {
  const account = accounts[Number(slotInput) - 1];
  if (!account) {
    return null;
  }
  activeEmailChosenSinceStart = true;
  apply(account.email);
  saveChoice({ email: account.email });
  return listDesktopClaudeAccounts();
}

import fs from 'node:fs';
import path from 'node:path';

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
 */

type DesktopClaudeAccount = { email: string; token: string };

let accounts: DesktopClaudeAccount[] = [];
let activeEmail: string | null = null;
let initialized = false;

const statePath = (): string | null => {
  const dbPath = process.env.DATABASE_PATH;
  return dbPath ? path.join(path.dirname(dbPath), 'claude-account.json') : null;
};

const readSavedEmail = (): string | null => {
  const file = statePath();
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { email?: unknown };
    return typeof parsed.email === 'string' ? parsed.email : null;
  } catch {
    return null;
  }
};

const saveEmail = (email: string): void => {
  const file = statePath();
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ email }), 'utf8');
};

const apply = (email: string | null): void => {
  const account = accounts.find((item) => item.email === email) ?? accounts[0];
  if (!account) return;
  activeEmail = account.email;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = account.token;
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
  apply(readSavedEmail());
}

export function hasDesktopClaudeAccounts(): boolean {
  return accounts.length > 0;
}

export function getDesktopClaudeActiveEmail(): string | null {
  return activeEmail;
}

/** Тот же ответ, что у сайта (/api/user/owner-accounts): номер = место в списке с 1. */
export function listDesktopClaudeAccounts() {
  const activeIndex = accounts.findIndex((item) => item.email === activeEmail);
  return {
    success: true,
    activeSlot: activeIndex >= 0 ? activeIndex + 1 : null,
    accounts: accounts.map((item, index) => ({ slot: index + 1, email: item.email, available: true })),
  };
}

export function activateDesktopClaudeAccount(slotInput: unknown) {
  const account = accounts[Number(slotInput) - 1];
  if (!account) {
    return null;
  }
  apply(account.email);
  saveEmail(account.email);
  return listDesktopClaudeAccounts();
}

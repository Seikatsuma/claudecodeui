import spawn from 'cross-spawn';

import {
  getActiveDevinSlot,
  setActiveDevinSlot,
  type DevinSlot,
} from '@/shared/devin-slots.js';
import { buildDevinChildEnv, isDevinCliInstalled, resolveDevinCliCommand } from '@/shared/utils.js';

/**
 * Подписки Devin хозяина (до двух), как их показывает меню аккаунтов.
 *
 * Читается из `devin auth status`: он сообщает только, лежит ли файл входа, и
 * имя аккаунта — без запроса к модели, без расхода квоты. Окон лимитов 5 ч /
 * неделя Devin в CLI не публикует (в отличие от Codex), поэтому полос расхода нет;
 * квота — на app.devin.ai. В ответе только имя — путь к файлу входа и ключ
 * не отдаём никогда. Слоты и их каталоги — shared/devin-slots.ts.
 */
export type DevinAccount = {
  available: boolean;
  name: string | null;
  /** The only model family the owner allows on this account. */
  models: string;
  fetchedAtMs: number | null;
};

export type DevinAccountEntry = DevinAccount & { slot: DevinSlot };

/**
 * Ответ меню: верхний уровень — АКТИВНЫЙ аккаунт (так читали прежние клиенты),
 * `accounts` — оба слота, `canAddSecond` — можно ли показать «Добавить аккаунт».
 */
export type DevinAccountsView = DevinAccount & {
  slot: DevinSlot;
  accounts: DevinAccountEntry[];
  canAddSecond: boolean;
};

const CACHE_TTL_MS = 60_000;
const STATUS_TIMEOUT_MS = 8_000;

const cache = new Map<DevinSlot, { at: number; value: DevinAccount }>();

const UNAVAILABLE: DevinAccount = { available: false, name: null, models: 'SWE-2', fetchedAtMs: null };

function runAuthStatus(slot: DevinSlot): Promise<string> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (text: string) => {
      if (!settled) {
        settled = true;
        resolve(text);
      }
    };
    try {
      const child = spawn(resolveDevinCliCommand(), ['auth', 'status'], {
        env: buildDevinChildEnv(slot),
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish('');
      }, STATUS_TIMEOUT_MS);
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.on('error', () => {
        clearTimeout(timer);
        finish('');
      });
      child.on('close', () => {
        clearTimeout(timer);
        finish(output);
      });
    } catch {
      finish('');
    }
  });
}

/** Parses the text of `devin auth status` into the owner-facing account record. */
export function parseDevinAuthStatus(text: string): DevinAccount {
  if (!/^\s*Logged in\b/m.test(text)) {
    return UNAVAILABLE;
  }
  const name = /^\s*Name:\s*(\S.*?)\s*$/m.exec(text)?.[1] ?? null;
  return { available: true, name, models: 'SWE-2', fetchedAtMs: Date.now() };
}

async function readSlotAccount(slot: DevinSlot, fresh = false): Promise<DevinAccount> {
  const hit = cache.get(slot);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.value;
  }
  const value = parseDevinAuthStatus(await runAuthStatus(slot));
  cache.set(slot, { at: Date.now(), value });
  return value;
}

/** Сбросить память о входе: после входа/выхода меню должно увидеть новое сразу. */
export function forgetDevinAccountCache(): void {
  cache.clear();
}

export async function readDevinAccount(): Promise<DevinAccountsView> {
  if (!isDevinCliInstalled()) {
    return { ...UNAVAILABLE, slot: 1, accounts: [], canAddSecond: false };
  }
  const [first, second] = await Promise.all([readSlotAccount(1), readSlotAccount(2)]);
  const accounts: DevinAccountEntry[] = [
    { slot: 1, ...first },
    { slot: 2, ...second },
  ];
  // Активным считаем выбранный слот, только если в нём есть вход: иначе меню
  // показало бы пустой пункт, а запуск упал бы без входа.
  const wanted = getActiveDevinSlot();
  const slot: DevinSlot = accounts.find((account) => account.slot === wanted)?.available
    ? wanted
    : (first.available ? 1 : (second.available ? 2 : 1));
  const active = accounts.find((account) => account.slot === slot) ?? accounts[0];
  return {
    available: active.available,
    name: active.name,
    models: active.models,
    fetchedAtMs: active.fetchedAtMs,
    slot,
    accounts,
    canAddSecond: !second.available,
  };
}

/** Выбрать активный аккаунт Devin. Слот без входа выбрать нельзя. */
export async function selectDevinSlot(slot: DevinSlot): Promise<DevinAccountsView> {
  const target = await readSlotAccount(slot, true);
  if (!target.available) {
    throw new Error('В этом аккаунте Devin нет входа.');
  }
  setActiveDevinSlot(slot);
  return readDevinAccount();
}

/** Проверка входа второго аккаунта без кэша — после ввода кода. */
export async function readFreshDevinSlot2(): Promise<DevinAccount> {
  return readSlotAccount(2, true);
}

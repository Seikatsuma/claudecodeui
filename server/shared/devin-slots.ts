import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Два аккаунта Devin хозяина (Егор 07.10.26: «создай ещё один аккаунт для
 * Devin» — на первом кончился бесплатный лимит).
 *
 * Слот 1 — вход самой машины (`~/.local/share/devin/credentials.toml`).
 * Слот 2 — отдельный каталог данных `~/.devin-account2/data`: Devin берёт
 * вход из `$XDG_DATA_HOME/devin/credentials.toml`, поэтому достаточно
 * запускать его с другим XDG_DATA_HOME (проверено: `devin auth status` показывает
 * путь входа и «Not logged in» в пустом каталоге).
 *
 * Чаты, история и доверенные папки у обоих аккаунтов общие: в каталоге слота 2
 * `cli` и `mcp` — ссылки на каталоги слота 1. Иначе чаты второго аккаунта жили
 * бы в другой базе sessions.db, и сайт их не увидел бы. Отдельным остаётся
 * только credentials.toml.
 *
 * Какой слот сейчас активен — один маленький файл `active-slot` ("1" или "2"):
 * Devin на машине один, гостям общего экземпляра он закрыт (isDevinAllowedForWebUser),
 * поэтому выбор общий для хозяина, а не по пользователям. Новые запуски Devin
 * берут слот при старте (buildDevinChildEnv); уже идущие чаты слот не меняют.
 */
export type DevinSlot = 1 | 2;

const PROFILE_ROOT = path.join(os.homedir(), '.devin-account2');
export const DEVIN_SLOT2_DATA_HOME = path.join(PROFILE_ROOT, 'data');
const ACTIVE_SLOT_FILE = path.join(PROFILE_ROOT, 'active-slot');
const SHARED_ENTRIES = ['cli', 'mcp'] as const;

// Каталог слота 1 — тот же расчёт, что getDevinDataDir() в utils.ts; свой, чтобы
// utils.ts мог импортировать этот модуль без цикла.
function slot1DataDir(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  return path.join(xdgDataHome || path.join(os.homedir(), '.local', 'share'), 'devin');
}

export function getActiveDevinSlot(): DevinSlot {
  try {
    return fs.readFileSync(ACTIVE_SLOT_FILE, 'utf8').trim() === '2' ? 2 : 1;
  } catch {
    return 1;
  }
}

export function setActiveDevinSlot(slot: DevinSlot): void {
  fs.mkdirSync(PROFILE_ROOT, { recursive: true, mode: 0o700 });
  fs.writeFileSync(ACTIVE_SLOT_FILE, `${slot}\n`, { mode: 0o600 });
}

/** Переменные окружения, которые направляют Devin на вход нужного слота. Слот 1 — как есть. */
export function getDevinSlotEnv(slot: DevinSlot): Record<string, string> {
  return slot === 2 ? { XDG_DATA_HOME: DEVIN_SLOT2_DATA_HOME } : {};
}

/**
 * Готовит каталог слота 2: создаёт недостающие ссылки на общие `cli` и `mcp`.
 * Существующее не трогает — настоящий каталог на месте ссылки значит, что там
 * уже что-то лежит; такое оставляем как есть и возвращаем в списке пропущенных.
 */
export function ensureDevinSlot2Profile(): { skipped: string[] } {
  const skipped: string[] = [];
  const devinDir = path.join(DEVIN_SLOT2_DATA_HOME, 'devin');
  fs.mkdirSync(devinDir, { recursive: true, mode: 0o700 });
  for (const entry of SHARED_ENTRIES) {
    const link = path.join(devinDir, entry);
    const target = path.join(slot1DataDir(), entry);
    let exists = true;
    try {
      fs.lstatSync(link);
    } catch {
      exists = false;
    }
    if (exists) {
      if (!fs.lstatSync(link).isSymbolicLink()) {
        skipped.push(entry);
      }
      continue;
    }
    if (fs.existsSync(target)) {
      fs.symlinkSync(target, link);
    }
  }
  return { skipped };
}

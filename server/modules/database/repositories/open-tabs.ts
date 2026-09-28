/**
 * Открытые вкладки чатов — одни на все устройства пользователя.
 *
 * Егор 16.09.26: «чтобы порядок на телефоне и на компьютере по ссылке был
 * одинаковым, и список чатов тоже — я часто путаюсь». Раньше вкладки жили в
 * localStorage каждого браузера отдельно.
 *
 * Храним весь список целиком с номером версии: пишет по сути один человек,
 * поэтому «последняя запись побеждает» достаточно. Номер растёт только когда
 * список действительно изменился — устройства сверяют его и не тянут список
 * без нужды.
 *
 * Окна командной строки сюда не входят: это процессы конкретной страницы, на
 * другом устройстве их нет.
 */
import { getConnection } from '@/modules/database/connection.js';

export type StoredOpenTab = {
  sessionId: string;
  projectId?: string;
  provider?: string;
  title?: string;
  /** Когда вкладку последний раз открывали (мс) — по нему страница убирает самую давнюю сверх 15. */
  openedAt?: number;
};

export type OpenTabsState = {
  version: number;
  tabs: StoredOpenTab[];
  updatedAt: string | null;
};

const MAX_TABS = 60;

let readyConnection: unknown = null;

function ensureTable(): void {
  const db = getConnection();
  if (readyConnection === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_open_tabs (
      user_id INTEGER PRIMARY KEY,
      tabs_json TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  readyConnection = db;
}

const shortString = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.slice(0, max) : undefined;

/** Чистит присланный список: только известные поля, без повторов, не больше MAX_TABS. */
export function normalizeOpenTabs(value: unknown): StoredOpenTab[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: StoredOpenTab[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const sessionId = shortString(raw.sessionId, 200);
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    const tab: StoredOpenTab = { sessionId };
    const projectId = shortString(raw.projectId, 500);
    const provider = shortString(raw.provider, 50);
    const title = shortString(raw.title, 300);
    if (projectId) tab.projectId = projectId;
    if (provider) tab.provider = provider;
    if (title) tab.title = title;
    if (typeof raw.openedAt === 'number' && Number.isFinite(raw.openedAt) && raw.openedAt > 0) {
      tab.openedAt = Math.round(raw.openedAt);
    }
    result.push(tab);
    if (result.length >= MAX_TABS) break;
  }
  return result;
}

export const openTabsDb = {
  get(userId: number): OpenTabsState {
    ensureTable();
    const row = getConnection()
      .prepare('SELECT tabs_json, version, updated_at FROM user_open_tabs WHERE user_id = ?')
      .get(userId) as { tabs_json: string; version: number; updated_at: string } | undefined;
    if (!row) return { version: 0, tabs: [], updatedAt: null };
    let tabs: StoredOpenTab[] = [];
    try {
      tabs = normalizeOpenTabs(JSON.parse(row.tabs_json));
    } catch {
      tabs = [];
    }
    return { version: row.version, tabs, updatedAt: row.updated_at };
  },

  /**
   * Записывает список; версия растёт только при настоящем изменении.
   * merge — первая отправка устройства: не заменить, а дописать к серверному
   * списку вкладки, которых там нет. Делается здесь, в одной транзакции: два
   * устройства, впервые сверяющиеся одновременно, иначе затирали бы друг друга.
   */
  put(userId: number, value: unknown, merge = false): OpenTabsState {
    ensureTable();
    const incoming = normalizeOpenTabs(value);
    const db = getConnection();
    const write = db.transaction(() => {
      const row = db
        .prepare('SELECT tabs_json, version FROM user_open_tabs WHERE user_id = ?')
        .get(userId) as { tabs_json: string; version: number } | undefined;
      let tabs = incoming;
      if (merge && row) {
        let existing: StoredOpenTab[] = [];
        try {
          existing = normalizeOpenTabs(JSON.parse(row.tabs_json));
        } catch {
          existing = [];
        }
        const known = new Set(existing.map((tab) => tab.sessionId));
        tabs = normalizeOpenTabs([...existing, ...incoming.filter((tab) => !known.has(tab.sessionId))]);
      }
      const json = JSON.stringify(tabs);
      if (row && row.tabs_json === json) return;
      if (row) {
        db.prepare('UPDATE user_open_tabs SET tabs_json = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?')
          .run(json, userId);
      } else {
        db.prepare('INSERT INTO user_open_tabs (user_id, tabs_json, version, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP)')
          .run(userId, json);
      }
    });
    write();
    return this.get(userId);
  },
};

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
  /**
   * Вкладки, закрытые ЯВНО (клиент прислал их в `remove`), — метка времени
   * закрытия (мс). Без неё «чата нет в пришедшем списке» неотличимо от
   * «устаревший снимок другого устройства затёр список»: страница считала
   * любое отсутствие закрытием и уводила человека из открытого чата.
   */
  closed: Record<string, number>;
};

const MAX_TABS = 60;
/** Метки закрытия старше этого срока забываются — они нужны только ближайшей сверке. */
const CLOSED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

let readyConnection: unknown = null;

function ensureTable(): void {
  const db = getConnection();
  if (readyConnection === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_open_tabs (
      user_id INTEGER PRIMARY KEY,
      tabs_json TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      closed_json TEXT NOT NULL DEFAULT '{}'
    )
  `);
  const columns = db.prepare("SELECT name FROM pragma_table_info('user_open_tabs')").all() as { name: string }[];
  if (!columns.some((column) => column.name === 'closed_json')) {
    db.exec("ALTER TABLE user_open_tabs ADD COLUMN closed_json TEXT NOT NULL DEFAULT '{}'");
  }
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
      .prepare('SELECT tabs_json, version, updated_at, closed_json FROM user_open_tabs WHERE user_id = ?')
      .get(userId) as { tabs_json: string; version: number; updated_at: string; closed_json?: string } | undefined;
    if (!row) return { version: 0, tabs: [], updatedAt: null, closed: {} };
    let tabs: StoredOpenTab[] = [];
    try {
      tabs = normalizeOpenTabs(JSON.parse(row.tabs_json));
    } catch {
      tabs = [];
    }
    let closed: Record<string, number> = {};
    try {
      const parsed = JSON.parse(row.closed_json ?? '{}') as Record<string, unknown>;
      for (const [id, at] of Object.entries(parsed)) {
        if (typeof at === 'number' && Number.isFinite(at)) closed[id] = Math.round(at);
      }
    } catch {
      closed = {};
    }
    return { version: row.version, tabs, updatedAt: row.updated_at, closed };
  },

  /**
   * Записывает список; версия растёт только при настоящем изменении.
   * merge — первая отправка устройства: не заменить, а дописать к серверному
   * списку вкладки, которых там нет. Делается здесь, в одной транзакции: два
   * устройства, впервые сверяющиеся одновременно, иначе затирали бы друг друга.
   *
   * remove — явный список закрытых клиентом вкладок. Его присутствие (даже
   * пустым) включает объединение вместо замены: сервер дописывает к присланному
   * списку свои вкладки, которых клиент не видел. Без него любая устаревшая
   * запись затирала список целиком — телефон с неотправленным старым снимком
   * ронял вкладки компьютера, а страница там уводила человека из открытого
   * чата. Закрытые через remove id помечаются в closed — страница уводит из
   * чата только по такой метке, не по простому отсутствию.
   */
  put(userId: number, value: unknown, merge = false, remove?: unknown): OpenTabsState {
    ensureTable();
    const incoming = normalizeOpenTabs(value);
    const removeIds = Array.isArray(remove)
      ? new Set(remove.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))
      : null;
    const db = getConnection();
    const write = db.transaction(() => {
      const row = db
        .prepare('SELECT tabs_json, closed_json FROM user_open_tabs WHERE user_id = ?')
        .get(userId) as { tabs_json: string; closed_json?: string } | undefined;
      let existing: StoredOpenTab[] = [];
      let closed: Record<string, number> = {};
      if (row) {
        try {
          existing = normalizeOpenTabs(JSON.parse(row.tabs_json));
        } catch {
          existing = [];
        }
        try {
          const parsed = JSON.parse(row.closed_json ?? '{}') as Record<string, unknown>;
          for (const [id, at] of Object.entries(parsed)) {
            if (typeof at === 'number' && Number.isFinite(at)) closed[id] = Math.round(at);
          }
        } catch {
          closed = {};
        }
      }
      let tabs = incoming;
      if (merge && row) {
        const known = new Set(existing.map((tab) => tab.sessionId));
        tabs = normalizeOpenTabs([...existing, ...incoming.filter((tab) => !known.has(tab.sessionId))]);
      } else if (removeIds !== null) {
        const incomingIds = new Set(incoming.map((tab) => tab.sessionId));
        const extras = existing.filter((tab) => !incomingIds.has(tab.sessionId) && !removeIds.has(tab.sessionId));
        tabs = normalizeOpenTabs([...incoming, ...extras]);
      }
      // Метки закрытия: снять у вернувшихся в список, поставить явно закрытым,
      // забыть совсем старые. Устаревшие записи (без remove) меток не ставят —
      // иначе затирание маскировалось бы под настоящее закрытие.
      const now = Date.now();
      const present = new Set(tabs.map((tab) => tab.sessionId));
      for (const id of present) delete closed[id];
      if (removeIds) {
        for (const id of removeIds) {
          if (!present.has(id)) closed[id] = now;
        }
      }
      for (const [id, at] of Object.entries(closed)) {
        if (now - at > CLOSED_KEEP_MS) delete closed[id];
      }
      const json = JSON.stringify(tabs);
      const closedJson = JSON.stringify(closed);
      if (row && row.tabs_json === json && row.closed_json === closedJson) return;
      if (row) {
        db.prepare('UPDATE user_open_tabs SET tabs_json = ?, closed_json = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?')
          .run(json, closedJson, userId);
      } else {
        db.prepare('INSERT INTO user_open_tabs (user_id, tabs_json, closed_json, version, updated_at) VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)')
          .run(userId, json, closedJson);
      }
    });
    write();
    return this.get(userId);
  },
};

import { existsSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';

import Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';
import { getDevinDatabasePath, normalizeProviderTimestamp } from '@/shared/utils.js';

/**
 * Время последнего сообщения чата — из самой переписки, а не из базы.
 *
 * На общем экземпляре (OPEN_REGISTRATION) наблюдатель за файлами переписок
 * выключен: его обход папки владельца съедал всю память (см. server/index.ts).
 * Без него `sessions.updated_at` обновлялся только от отдельных действий
 * веба, и время в списке чатов слева отставало на часы: 18.09.26 у работающей
 * «Презентации для арендодателей» в базе стояло 13:00, а последний ответ был в
 * 14:08; база не менялась полтора часа, хотя чаты шли. Перезапрос списка при
 * возврате в приложение (AppContent) этого не лечил — он перечитывал ту же
 * устаревшую базу.
 *
 * Здесь вместо обхода папок — опрос только уже известных чатов: раз в
 * несколько секунд `stat` их файлов, и только у изменившихся — чтение хвоста.
 *
 * Время берётся из последней записи user/assistant, а не из времени изменения
 * файла: Claude дописывает служебные строки без времени (cost-state,
 * last-prompt), и у чата, молчащего с 13.09, файл был «изменён сегодня».
 *
 * В браузер ничего не рассылается: `session_upserted` помечает чат как
 * «требует внимания» и уходит всем пользователям сервера. Список сам
 * перечитывает базу раз в минуту (useSidebarController).
 */

const POLL_INTERVAL_MS = 15_000;
const TAIL_BYTES = [256 * 1024, 4 * 1024 * 1024];

type ActivityRow = {
  session_id: string;
  jsonl_path: string;
  updated_at: string | null;
};

/**
 * session_id → «mtime:size» файла и найденное в нём время. Файл перечитывается
 * только при смене «mtime:size», а сверка с базой идёт на каждом проходе:
 * `updated_at` пишут и другие (синхронизатор при загрузке списка ставит
 * mtime, веб — время запуска), и без неё их значение оставалось бы навсегда.
 */
const seenFiles = new Map<string, { fileState: string; lastMessageAt: string | null }>();
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Время последней записи user/assistant в хвосте переписки. Строка-сообщение
 * ассистента бывает в сотни килобайт (результаты инструментов), поэтому, если
 * в коротком хвосте ни одной не нашлось, читается длинный.
 */
export async function readLastMessageTimestamp(filePath: string): Promise<string | null> {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    for (const tailBytes of TAIL_BYTES) {
      const length = Math.min(size, tailBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const lines = buffer.toString('utf8').split('\n');
      // Первая строка хвоста обычно обрезана посередине — её не разбираем,
      // если хвост не покрывает файл целиком.
      const firstUsable = length < size ? 1 : 0;
      for (let index = lines.length - 1; index >= firstUsable; index -= 1) {
        const line = lines[index];
        if (!line.includes('"timestamp"')) continue;
        try {
          const entry = JSON.parse(line) as { type?: unknown; timestamp?: unknown; isMeta?: unknown };
          if ((entry.type === 'user' || entry.type === 'assistant')
            && entry.isMeta !== true
            && typeof entry.timestamp === 'string'
            && !Number.isNaN(new Date(entry.timestamp).getTime())) {
            return new Date(entry.timestamp).toISOString();
          }
        } catch {
          // Недописанная строка — идём дальше вверх.
        }
      }
      if (length >= size) break;
    }
    return null;
  } finally {
    await handle.close();
  }
}

/** SQLite CURRENT_TIMESTAMP хранится как UTC без пояса: «2026-09-18 13:00:45». */
function parseStoredTimestamp(value: string | null): number | null {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** Один проход сверки. Возвращает число чатов, у которых поправлено время. */
export async function syncSessionActivityOnce(): Promise<number> {
  const db = getConnection();
  const rows = db.prepare(
    `SELECT session_id, jsonl_path, updated_at FROM sessions
      WHERE provider = 'claude' AND isArchived = 0 AND jsonl_path IS NOT NULL`
  ).all() as ActivityRow[];

  const update = db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?');
  let changed = 0;

  for (const row of rows) {
    let fileState: string;
    try {
      const fileStat = await stat(row.jsonl_path);
      fileState = `${fileStat.mtimeMs}:${fileStat.size}`;
    } catch {
      continue;
    }
    let lastMessageAt: string | null;
    const seen = seenFiles.get(row.session_id);
    if (seen && seen.fileState === fileState) {
      lastMessageAt = seen.lastMessageAt;
    } else {
      try {
        lastMessageAt = await readLastMessageTimestamp(row.jsonl_path);
      } catch {
        continue;
      }
      seenFiles.set(row.session_id, { fileState, lastMessageAt });
    }
    if (!lastMessageAt) continue;

    const storedMs = parseStoredTimestamp(row.updated_at);
    if (storedMs !== null && Math.abs(storedMs - new Date(lastMessageAt).getTime()) < 1000) continue;

    update.run(lastMessageAt, row.session_id);
    changed += 1;
  }

  changed += syncDevinSessionActivity(db, update);
  return changed;
}

/**
 * То же для чатов Devin: у них нет файла переписки, вместо него колонка
 * `last_activity_at` (unix-секунды) в общей `sessions.db` Devin CLI.
 */
function syncDevinSessionActivity(
  db: ReturnType<typeof getConnection>,
  update: { run(...args: unknown[]): unknown },
): number {
  const devinRows = db.prepare(
    `SELECT session_id, provider_session_id, updated_at FROM sessions
      WHERE provider = 'devin' AND isArchived = 0`
  ).all() as { session_id: string; provider_session_id: string | null; updated_at: string | null }[];
  if (devinRows.length === 0) {
    return 0;
  }

  const dbPath = getDevinDatabasePath();
  if (!existsSync(dbPath)) {
    return 0;
  }

  let devinDb: InstanceType<typeof Database>;
  try {
    devinDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return 0;
  }

  let changed = 0;
  try {
    const readStamp = devinDb.prepare(
      'SELECT COALESCE(last_activity_at, created_at, 0) AS stamp FROM sessions WHERE id = ?',
    );
    for (const row of devinRows) {
      const providerId = row.provider_session_id ?? row.session_id;
      const stampRow = readStamp.get(providerId) as { stamp: number } | undefined;
      if (!stampRow?.stamp) {
        continue;
      }
      const lastMessageAt = normalizeProviderTimestamp(stampRow.stamp);
      const storedMs = parseStoredTimestamp(row.updated_at);
      if (storedMs !== null && Math.abs(storedMs - new Date(lastMessageAt).getTime()) < 1000) {
        continue;
      }
      update.run(lastMessageAt, row.session_id);
      changed += 1;
    }
    return changed;
  } catch {
    // Mid-loop failure still reports the rows already updated.
    return changed;
  } finally {
    devinDb.close();
  }
}

export function startSessionActivitySync(): void {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const changed = await syncSessionActivityOnce();
      if (changed > 0) {
        console.log(`[session-activity] время последнего сообщения обновлено у ${changed} чат(ов)`);
      }
    } catch (error) {
      console.error('[session-activity] сверка не удалась:', error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  };
  void tick();
  timer = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
  timer.unref?.();
}

export function stopSessionActivitySync(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

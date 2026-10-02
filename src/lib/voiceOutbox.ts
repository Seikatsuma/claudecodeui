import { transcribeVoice } from './voiceApi';

/**
 * Голосовые записи, которые не должны пропасть, пока нет связи.
 *
 * Звук пишется в IndexedDB телефона кусками прямо во время записи (если
 * экран погас или вкладку убили - до этого момента всё уже на диске), а после
 * остановки собирается в одну запись и лежит в очереди, пока сервер не принял
 * её. Принял - сервер сам кладёт её в архив и в Telegram (см. AGENTS.md,
 * «Архив голосовых записей»), так что из очереди запись можно убирать.
 */

const DB_NAME = 'voice-outbox';
const CHUNKS = 'chunks'; // { id: `${recId}:${seq}`, recId, seq, at, blob }
const PENDING = 'pending'; // { id, at, type, blob }
const ORPHAN_AFTER_MS = 30_000;
const RETRY_EVERY_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 12 * 60 * 1000;
const MIN_BLOB_BYTES = 800;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHUNKS)) {
        db.createObjectStore(CHUNKS, { keyPath: 'id' }).createIndex('recId', 'recId');
      }
      if (!db.objectStoreNames.contains(PENDING)) db.createObjectStore(PENDING, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // Неудачу не запоминаем: следующая попытка откроет базу заново.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

export function newRecordingId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Кусок звука - на диск сразу. Сбой хранилища записи не мешает. */
export async function saveChunk(recId: string, seq: number, blob: Blob): Promise<void> {
  try {
    const s = await store(CHUNKS, 'readwrite');
    await done(s.put({ id: `${recId}:${String(seq).padStart(6, '0')}`, recId, seq, at: Date.now(), blob }));
  } catch (e) {
    console.warn('[voice-outbox] chunk not saved', e);
  }
}

async function chunksOf(recId: string): Promise<{ id: string; at: number; blob: Blob }[]> {
  const s = await store(CHUNKS, 'readonly');
  const rows = (await done(s.index('recId').getAll(recId))) as { id: string; at: number; blob: Blob }[];
  return rows.sort((a, b) => (a.id < b.id ? -1 : 1));
}

async function dropChunks(recId: string): Promise<void> {
  const s = await store(CHUNKS, 'readwrite');
  const keys = (await done(s.index('recId').getAllKeys(recId))) as IDBValidKey[];
  await Promise.all(keys.map((k) => done(s.delete(k))));
}

/** Запись остановлена: куски -> одна запись в очереди. Возвращает её номер. */
export async function sealRecording(recId: string, type: string, fallback: Blob[]): Promise<string | null> {
  try {
    const rows = await chunksOf(recId);
    // Куски на диске полнее того, что в памяти, только если память подвела;
    // берём тот набор, где звука больше.
    const fromDisk = rows.map((r) => r.blob);
    const sizeOf = (bs: Blob[]) => bs.reduce((n, b) => n + b.size, 0);
    const parts = sizeOf(fromDisk) >= sizeOf(fallback) ? fromDisk : fallback;
    const blob = new Blob(parts, { type });
    if (blob.size < MIN_BLOB_BYTES) {
      await dropChunks(recId);
      return null;
    }
    const s = await store(PENDING, 'readwrite');
    await done(s.put({ id: recId, at: Date.now(), type, blob }));
    await dropChunks(recId);
    return recId;
  } catch (e) {
    console.warn('[voice-outbox] could not seal recording', e);
    return null;
  }
}

export async function removePending(id: string): Promise<void> {
  try {
    const s = await store(PENDING, 'readwrite');
    await done(s.delete(id));
  } catch (e) {
    console.warn('[voice-outbox] could not remove', e);
  }
}

function extOf(type: string): string {
  return type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
}

/**
 * Связь пропала, а не сервер ответил отказом: именно такую запись надо
 * оставить в очереди. Таймаут ожидания расшифровки сюда не относится - к его
 * концу сервер запись давно принял и отправил в Telegram.
 */
export function isConnectionFailure(e: unknown, res?: Response): boolean {
  if (res) return [408, 429, 502, 503, 504].includes(res.status);
  return !(e instanceof DOMException && e.name === 'AbortError');
}

let flushing = false;
let activeRecId: string | null = null;
/** Записи, которые прямо сейчас отправляет кнопка микрофона: очередь их не трогает. */
export const uploadingNow = new Set<string>();

export function markRecordingActive(recId: string | null): void {
  activeRecId = recId;
}

/** Куски записи, которую убило вместе со страницей, - в очередь. */
async function adoptOrphans(): Promise<void> {
  const s = await store(CHUNKS, 'readonly');
  const all = (await done(s.getAll())) as { recId: string; at: number; blob: Blob }[];
  const lastAt = new Map<string, number>();
  const type = new Map<string, string>();
  for (const c of all) {
    lastAt.set(c.recId, Math.max(lastAt.get(c.recId) ?? 0, c.at));
    if (!type.has(c.recId)) type.set(c.recId, c.blob.type);
  }
  for (const [recId, at] of lastAt) {
    if (recId === activeRecId || Date.now() - at < ORPHAN_AFTER_MS) continue;
    await sealRecording(recId, type.get(recId) || 'audio/webm', []);
  }
}

/** Отправить всё, что лежит в очереди. Сервер сам расшифрует и положит в Telegram. */
export async function flushOutbox(): Promise<void> {
  if (flushing || typeof indexedDB === 'undefined') return;
  flushing = true;
  try {
    await adoptOrphans();
    const s = await store(PENDING, 'readonly');
    const items = (await done(s.getAll())) as { id: string; at: number; type: string; blob: Blob }[];
    for (const item of items.sort((a, b) => a.at - b.at)) {
      if (navigator.onLine === false) break;
      if (uploadingNow.has(item.id)) continue;
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), UPLOAD_TIMEOUT_MS);
      try {
        const res = await transcribeVoice(item.blob, `recording.${extOf(item.type)}`, abort.signal);
        // Любой ответ сервера, кроме обрыва на пути, значит: запись принята.
        if (isConnectionFailure(null, res)) break;
        await removePending(item.id);
      } catch (e) {
        if (isConnectionFailure(e)) break; // связи нет - остальные подождут
        await removePending(item.id); // таймаут ожидания расшифровки: сервер запись уже принял
      } finally {
        clearTimeout(timeout);
      }
    }
  } catch (e) {
    console.warn('[voice-outbox] flush failed', e);
  } finally {
    flushing = false;
  }
}

let started = false;

/** Досылка: при запуске, когда появилась сеть, при возврате в приложение и раз в полминуты. */
export function startOutboxFlush(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const kick = () => void flushOutbox();
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick();
  });
  setInterval(kick, RETRY_EVERY_MS);
  kick();
}

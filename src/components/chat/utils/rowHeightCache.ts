/**
 * Запомненная высота строки ленты между открытиями чата.
 *
 * Зачем (Егор, 10.10.26: «открываю чат — отбрасывает чуть выше; листаю вниз
 * до упора — возвращает на то же место, подгружается и дёргается»). Строки
 * вне экрана рендерятся с примерной высотой (`contain-intrinsic-size: auto
 * 96–240px`), настоящую получают только при разметке: после открытия сумма
 * оценок не совпадает с реальной высотой ленты, и каждая смена высоты —
 * возврат места якорем, то есть рывок. Записанная после разметки высота
 * подставляется при следующем открытии той же строки: оценка совпадает с
 * реальностью, лента стоит, низ находится сразу.
 *
 * Хранилище — localStorage (переживает перезапуск сайта), ключ строки — тот же
 * `getIntrinsicMessageKey`, что и у React (`data-mid` на `.chat-message`).
 * Высота зависит от ширины: на каждый ключ лежит до четырёх записей по ширине
 * окна (телефон портрет/ландшафт, компьютер). Пишется только реальная
 * размеченная высота (см. `useRowHeightRecorder` — пропущенные
 * `content-visibility`-строки отсеиваются), поэтому закэшированная оценка не
 * бывает хуже дефолтной. Устаревшая запись (строка изменилась — дописан ответ,
 * другой текст) безвредна: после разметки браузер возвращает реальную высоту,
 * а запись обновляется.
 *
 * Не кэшируются: свёртка «Ход работы» (её высота зависит от раскрытия —
 * `data-mid` там не ставится) и строки без устойчивого ключа.
 */

const STORAGE_KEY = 'ccui.rh.v1';
const MAX_KEYS = 4000;
const FLUSH_MS = 2000;
/** Записи с шириной окна в пределах этого разброса считаются одной строкой. */
const WIDTH_TOLERANCE = 48;
/** Максимум записей по ширине на один ключ. */
const MAX_PER_KEY = 4;
/** Строка ниже — мусор, не пишем. */
const MIN_HEIGHT = 8;

interface HeightEntry {
  /** Ширина окна (`window.innerWidth`) при записи. */
  w: number;
  /** Размеченная высота `.chat-message`, px. */
  h: number;
}

let heights: Map<string, HeightEntry[]> | null = null;
let dirty = false;
let flushTimer: number | null = null;

function load(): Map<string, HeightEntry[]> {
  const map = new Map<string, HeightEntry[]>();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return map;
    const parsed = JSON.parse(raw) as Record<string, HeightEntry[]>;
    for (const [key, entries] of Object.entries(parsed)) {
      if (!Array.isArray(entries)) continue;
      const clean = entries.filter(
        (e) => e && typeof e.w === 'number' && typeof e.h === 'number' && e.h >= MIN_HEIGHT,
      );
      if (clean.length > 0) map.set(key, clean.slice(-MAX_PER_KEY));
    }
  } catch {
    // Битая запись — кэш начинается с нуля, лента просто снова на оценках.
  }
  return map;
}

function ensureLoaded(): Map<string, HeightEntry[]> {
  if (!heights) heights = load();
  return heights;
}

function scheduleFlush() {
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    flushRowHeightCache();
  }, FLUSH_MS);
}

export function flushRowHeightCache() {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!dirty || !heights) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(heights)));
    dirty = false;
  } catch {
    // Переполненное хранилище — работаем на памяти, без записи.
  }
}

/** Высота строки с прошлого открытия — для `contain-intrinsic-size` до разметки. */
export function peekRowHeight(key: string | null | undefined): number | undefined {
  if (!key || typeof window === 'undefined') return undefined;
  const entries = ensureLoaded().get(key);
  if (!entries || entries.length === 0) return undefined;
  const width = window.innerWidth;
  let best: HeightEntry | undefined;
  for (const entry of entries) {
    if (Math.abs(entry.w - width) > WIDTH_TOLERANCE) continue;
    if (!best || Math.abs(entry.w - width) < Math.abs(best.w - width)) best = entry;
  }
  return best?.h;
}

/** Записать реальную размеченную высоту строки. Вызывается из ResizeObserver. */
export function noteRowHeight(key: string, height: number) {
  if (!key || !Number.isFinite(height) || height < MIN_HEIGHT || typeof window === 'undefined') return;
  const map = ensureLoaded();
  const width = window.innerWidth;
  const entries = map.get(key);
  if (entries) {
    for (const entry of entries) {
      if (Math.abs(entry.w - width) <= WIDTH_TOLERANCE) {
        if (entry.h !== height) {
          entry.h = height;
          entry.w = width;
          dirty = true;
          scheduleFlush();
        }
        // Свежесть ключа для LRU-выброса.
        map.delete(key);
        map.set(key, entries);
        return;
      }
    }
    entries.push({ w: width, h: height });
    if (entries.length > MAX_PER_KEY) entries.shift();
    map.delete(key);
    map.set(key, entries);
  } else {
    map.set(key, [{ w: width, h: height }]);
  }
  // Бюджет: самые давно не использовавшиеся уходят пачкой.
  if (map.size > MAX_KEYS) {
    const overflow = map.size - MAX_KEYS + Math.floor(MAX_KEYS / 5);
    let removed = 0;
    for (const oldKey of map.keys()) {
      map.delete(oldKey);
      if (++removed >= overflow) break;
    }
  }
  dirty = true;
  scheduleFlush();
}

// Уход со страницы и сворачивание — записать накопленное сразу.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushRowHeightCache);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushRowHeightCache();
  });
}

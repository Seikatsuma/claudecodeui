import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * Прогрев строк ленты в паузах — чтобы первое листание шло так же гладко, как второе.
 *
 * Зачем (Егор, 27.09.26: «листаю, листаю — зависает и откидывает; пролистал
 * весь чат — и только тогда всё плавно»). Строки вне экрана браузер не
 * размечает (`content-visibility: auto`, index.css) и держит примерную высоту
 * 96–240 px. Настоящую разметку строка получает в тот момент, когда подъезжает
 * к экрану, — то есть прямо во время листания: кадр подвисает, а высота строки
 * меняется, и удержание места (`useScrollAnchor`) возвращает сдвиг — на iPhone
 * после остановки броска, это и есть «откидывает». Разметив строку однажды,
 * браузер запоминает её высоту (`contain-intrinsic-size: auto …`) и дальше
 * снова пропускает — поэтому второй проход гладкий. Замер 27.09.26
 * (`~/tmp-ccui/perf/open_scroll_probe.py`): первый проход вверх по чату — 12
 * подвисаний, 1189 мс, 45 строк сменили высоту на ходу; второй — ноль.
 *
 * Как устроено. После открытия чата и после каждой новой порции строк мы в
 * паузах главного потока (requestIdleCallback; в Safari его нет — таймер)
 * размечаем непрогретые строки кусками не дольше SLICE_BUDGET_MS: класс
 * `chat-message--warm` включает строку, чтение `offsetHeight` заставляет
 * браузер разметить её сейчас, а не во время листания. Класс держится один
 * кадр — ровно чтобы браузер запомнил настоящую высоту, — и снимается. Порядок —
 * от экрана вверх (туда листают), потом вниз. Сдвиг высоты над экраном
 * возвращает `useScrollAnchor`, как и любой другой.
 *
 * Цена: только строки открытого чата, каждая один раз; скрытая вкладка не
 * прогревается. Готовых сообщений других чатов это не касается.
 */

const ROW_SELECTOR = '.chat-message';
const WARM_CLASS = 'chat-message--warm';
/** Столько главного потока за один заход; строка тяжелее — всё равно одна за заход. */
const SLICE_BUDGET_MS = 6;
/** Не мешать первому показу чата: прогрев начинается чуть позже. */
const START_DELAY_MS = 300;
/**
 * Порция пришла, пока человек листает, — её строки прогреваем почти сразу:
 * до них всего несколько экранов (замер 27.09.26: с 300 мс 9 строк порции
 * успевали доехать до экрана непрогретыми).
 */
const NEXT_BATCH_DELAY_MS = 50;
/**
 * Греем только рядом с экраном: столько экранов вверх (туда листают) и вниз.
 * Остальное — по мере листания. Иначе «показать всю переписку» заставила бы
 * разметить в фоне тысячи строк, до которых человек может и не дойти.
 */
const RANGE_SCREENS_UP = 6;
const RANGE_SCREENS_DOWN = 2;
/**
 * Лента движется (палец, инерция, колесо) — не греем: работа в паузах, а не
 * посреди листания. Замер 27.09.26: заходы во время листания вернули 21 смену
 * высоты на ходу против 6, когда грели только в паузах.
 */
const MOTION_IDLE_MS = 150;
/** Без requestIdleCallback (Safari) — пауза между заходами. */
const FALLBACK_GAP_MS = 50;

type IdleHandle = { kind: 'idle' | 'timeout'; id: number };

interface UseRowPrewarmArgs {
  scrollContainerRef: RefObject<HTMLDivElement>;
  enabled: boolean;
  /** Меняется, когда в ленте появились новые строки (порция, новый ход). */
  contentKey: number;
}

function supportsContentVisibility(): boolean {
  return typeof CSS !== 'undefined'
    && typeof CSS.supports === 'function'
    && CSS.supports('content-visibility', 'auto');
}

/** Первая строка, нижний край которой ниже верха экрана (строки идут по порядку). */
function firstRowOnScreen(rows: HTMLElement[], viewTop: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  let found = rows.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const row = rows[mid];
    if (row.offsetTop + row.offsetHeight > viewTop) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found;
}

export function useRowPrewarm({ scrollContainerRef, enabled, contentKey }: UseRowPrewarmArgs) {
  // Живёт дольше одного прохода эффекта: прогретая строка не прогревается снова.
  const warmedRef = useRef<WeakSet<HTMLElement>>(new WeakSet());
  // Первый прогрев после открытия чата уже назначался.
  const startedRef = useRef(false);

  useEffect(() => {
    // Лента опустела (другой чат в той же вкладке) — следующее открытие снова первое.
    if (contentKey === 0) startedRef.current = false;
    const maybeContainer = scrollContainerRef.current;
    if (!enabled || !maybeContainer || !supportsContentVisibility()) return undefined;
    const container: HTMLDivElement = maybeContainer;

    const warmed = warmedRef.current;
    const held: HTMLElement[] = [];
    let handle: IdleHandle | null = null;
    let cancelled = false;
    let lastScrollAt = 0;

    const release = () => {
      for (const el of held.splice(0)) el.classList.remove(WARM_CLASS);
    };

    const cancelHandle = () => {
      if (!handle) return;
      if (handle.kind === 'idle' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(handle.id);
      } else {
        window.clearTimeout(handle.id);
      }
      handle = null;
    };

    const schedule = (delay = 0) => {
      if (cancelled || handle) return;
      if (delay === 0 && typeof window.requestIdleCallback === 'function') {
        handle = { kind: 'idle', id: window.requestIdleCallback(slice, { timeout: 1000 }) };
      } else {
        handle = { kind: 'timeout', id: window.setTimeout(slice, delay || FALLBACK_GAP_MS) };
      }
    };

    function slice(deadline?: IdleDeadline) {
      handle = null;
      if (cancelled) return;
      // Вкладка скрыта (display: none) — размеры нулевые; вернёмся при показе.
      if (container.clientHeight === 0) return;
      if (performance.now() - lastScrollAt < MOTION_IDLE_MS) {
        schedule(MOTION_IDLE_MS);
        return;
      }

      const rows = Array.from(container.querySelectorAll<HTMLElement>(ROW_SELECTOR));
      const pivot = firstRowOnScreen(rows, container.scrollTop);
      const rangeTop = container.scrollTop - RANGE_SCREENS_UP * container.clientHeight;
      const rangeBottom = container.scrollTop + (RANGE_SCREENS_DOWN + 1) * container.clientHeight;
      const budget = deadline
        ? Math.max(1, Math.min(SLICE_BUDGET_MS, deadline.timeRemaining()))
        : SLICE_BUDGET_MS;
      const startedAt = performance.now();
      let left = false;

      // От экрана вверх, затем от экрана вниз.
      const visit = (el: HTMLElement) => {
        if (warmed.has(el)) return true;
        if (held.length > 0 && performance.now() - startedAt >= budget) {
          left = true;
          return false;
        }
        el.classList.add(WARM_CLASS);
        void el.offsetHeight; // разметка сейчас, а не когда строка подъедет к экрану
        warmed.add(el);
        held.push(el);
        return true;
      };
      for (let i = pivot - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (row.offsetTop + row.offsetHeight < rangeTop || !visit(row)) break;
      }
      if (!left) {
        for (let i = pivot; i < rows.length; i += 1) {
          const row = rows[i];
          if (row.offsetTop > rangeBottom || !visit(row)) break;
        }
      }

      if (held.length > 0) {
        // Кадр отрисовки с включённой строкой — браузер запоминает её высоту;
        // таймер после кадра снимает класс.
        requestAnimationFrame(() => window.setTimeout(release, 0));
      }
      if (left) schedule(typeof window.requestIdleCallback === 'function' ? 0 : FALLBACK_GAP_MS);
    }

    // Листают — в зону входят новые строки: заход после остановки.
    const onScroll = () => {
      lastScrollAt = performance.now();
      schedule(MOTION_IDLE_MS);
    };

    schedule(startedRef.current ? NEXT_BATCH_DELAY_MS : START_DELAY_MS);
    startedRef.current = true;
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelled = true;
      container.removeEventListener('scroll', onScroll);
      cancelHandle();
      release();
    };
  }, [contentKey, enabled, scrollContainerRef]);
}

import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';

/**
 * Лента держит место на экране сама — одинаково во всех браузерах.
 *
 * Зачем (Егор, 15.09.26: «листаю вверх — возвращает в одну и ту же точку и не
 * даёт загрузить остальное»). Высота над экраном меняется постоянно: сверху
 * вставляется порция ранних сообщений, сообщения вне экрана рисуются с
 * примерной высотой (`content-visibility: auto`) и получают настоящую, когда
 * подъезжают, раскрывается «Ход работы». Chrome гасит такие сдвиги сам
 * (`overflow-anchor`), Safari на iPhone — нет. Прежний возврат места ставил
 * позицию по снимку, сделанному ДО запроса к серверу, и сверял её ещё раз через
 * кадр: всё, что человек пролистал за время запроса, отматывалось назад.
 *
 * Как устроено. Опора — первая строка ленты на экране; запоминается её
 * положение внутри ленты (`offsetTop`, от прокрутки не зависит). Когда высота
 * ленты меняется (ResizeObserver срабатывает после разметки, до отрисовки),
 * сдвиг опоры возвращается прокруткой — ровно на столько, на сколько её сдвинуло.
 * Встроенное удержание Chrome выключено (`overflow-anchor: none` в index.css),
 * иначе сдвиг возвращался бы дважды.
 *
 * Палец на стекле или лента едет по инерции — запись `scrollTop` на iPhone
 * обрывает бросок. Тогда сдвиг держится отрицательным отступом ленты
 * (`margin-top`), а в прокрутку переносится, когда движение остановилось:
 * отступ снимается и прокрутка прибавляется в одном кадре, на экране ничего не
 * шевелится. Приём из TanStack Virtual (PR #1189, issue #1287).
 */

const ROW_SELECTOR = '.chat-row';
const ROWS_WRAPPER_SELECTOR = '.chat-rows';
/** Столько без событий прокрутки — движение (и инерция) закончилось. */
const MOTION_IDLE_MS = 140;
/**
 * Палец лежит без движения дольше этого — движения нет. Страховка: при уходе
 * приложения в фон посреди жеста iOS может не прислать touchend, и отложенный
 * сдвиг висел бы вечно.
 */
const TOUCH_STALE_MS = 1000;

interface Anchor {
  row: HTMLElement;
  /** Положение строки внутри ленты без временного отступа. */
  top: number;
  /** Прокрутка в момент, когда опора запомнена. */
  scrollTop: number;
}

interface UseScrollAnchorArgs {
  scrollContainerRef: RefObject<HTMLDivElement>;
  enabled: boolean;
  /** Пока лента встаёт в низ при открытии чата — место не держим. */
  suspendedRef: MutableRefObject<boolean>;
  markProgrammaticScroll: (targetScrollTop: number) => void;
  /** Отложенный сдвиг перенесён в прокрутку — лента снова стоит честно. */
  onSettled?: () => void;
}

// Инвариант: `offsetTop` строк отсчитывается от самой панели прокрутки
// (`.chat-messages-pane` — `relative`). Если сделать `.chat-rows` или
// `.chat-row` позиционированными, опора молча начнёт врать.
function pickAnchorRow(container: HTMLDivElement): HTMLElement | null {
  const rows = Array.from(container.querySelectorAll<HTMLElement>(ROW_SELECTOR));
  if (rows.length === 0) return null;
  const viewTop = container.scrollTop;
  let lo = 0;
  let hi = rows.length - 1;
  let found = rows.length - 1;
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
  // Самую верхнюю строку опорой не берём: в неё вливаются ранние действия, и
  // React пересоздаёт её под новым ключом — опора пропала бы из документа.
  if (found === 0 && rows.length > 1) return rows[1];
  return rows[found];
}

export function useScrollAnchor({
  scrollContainerRef,
  enabled,
  suspendedRef,
  markProgrammaticScroll,
  onSettled,
}: UseScrollAnchorArgs) {
  const anchorRef = useRef<Anchor | null>(null);
  const deferredRef = useRef(0);
  const lastHeightRef = useRef(-1);
  // Высота самого окна ленты и «стояли в самом низу» — на момент последней сверки.
  const lastClientHeightRef = useRef(-1);
  const wasAtBottomRef = useRef(false);
  const touchingRef = useRef(false);
  const lastTouchAtRef = useRef(0);
  // Последнее движение начато пальцем. Колесо и полоса прокрутки ничего не
  // обрывают записью scrollTop — там сдвиг возвращаем сразу, иначе при быстром
  // листании колесом лента стояла у «ложного верха», пока не отпустишь
  // (замер 15.09.26: до 8 шагов). Как в TanStack Virtual PR #1280.
  const touchProvenanceRef = useRef(false);
  const lastScrollAtRef = useRef(0);
  const flushTimerRef = useRef<number | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const wrapperOf = (container: HTMLDivElement) =>
    container.querySelector<HTMLElement>(ROWS_WRAPPER_SELECTOR);

  const record = useCallback((container: HTMLDivElement) => {
    const row = pickAnchorRow(container);
    anchorRef.current = row
      ? { row, top: row.offsetTop + deferredRef.current, scrollTop: container.scrollTop }
      : null;
    wasAtBottomRef.current = deferredRef.current === 0
      && container.scrollHeight - container.scrollTop - container.clientHeight <= 2;
  }, []);

  const inMotion = useCallback((container: HTMLDivElement) => (
    (touchingRef.current && performance.now() - lastTouchAtRef.current < TOUCH_STALE_MS)
    || (touchProvenanceRef.current && performance.now() - lastScrollAtRef.current < MOTION_IDLE_MS)
    // Упругий отскок у края (Safari): запись прокрутки в нём теряется.
    || container.scrollTop < 0
  ), []);

  const writeScrollTop = useCallback((container: HTMLDivElement, target: number) => {
    container.scrollTop = target;
    markProgrammaticScroll(container.scrollTop);
  }, [markProgrammaticScroll]);

  const flush = useCallback(() => {
    flushTimerRef.current = null;
    const container = scrollContainerRef.current;
    const shift = deferredRef.current;
    if (!container || shift === 0) return;
    if (inMotion(container)) {
      flushTimerRef.current = window.setTimeout(flush, MOTION_IDLE_MS);
      return;
    }
    const wrapper = wrapperOf(container);
    deferredRef.current = 0;
    if (wrapper) wrapper.style.marginTop = '';
    writeScrollTop(container, container.scrollTop + shift);
    lastHeightRef.current = wrapper ? wrapper.offsetHeight : container.scrollHeight;
    record(container);
    onSettledRef.current?.();
  }, [inMotion, record, scrollContainerRef, writeScrollTop]);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = window.setTimeout(flush, MOTION_IDLE_MS);
  }, [flush]);

  /** Сверить опору: высота ленты поменялась — вернуть место, затем запомнить новую опору. */
  const reconcile = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    // Вкладка чата скрыта (display: none) — все размеры нулевые, опора бессмысленна.
    if (container.clientHeight === 0) {
      anchorRef.current = null;
      lastHeightRef.current = -1;
      lastClientHeightRef.current = -1;
      wasAtBottomRef.current = false;
      return;
    }
    const wrapper = wrapperOf(container);
    const height = wrapper ? wrapper.offsetHeight : container.scrollHeight;

    // Изменилось само окно ленты (над ним догрузилась полоса шапки, открылась
    // клавиатура), а человек стоял в самом низу — остаёмся в самом низу. Опора
    // держит верх окна, поэтому без этого текст на кадр-другой уезжал вниз,
    // пока догон в низ не вернёт (замер 27.09.26: +28 px на 30 мс при открытии).
    const clientHeight = container.clientHeight;
    const paneResized = lastClientHeightRef.current >= 0 && clientHeight !== lastClientHeightRef.current;
    lastClientHeightRef.current = clientHeight;
    if (
      paneResized
      && wasAtBottomRef.current
      && enabledRef.current
      && !suspendedRef.current
      && deferredRef.current === 0
      && !inMotion(container)
    ) {
      writeScrollTop(container, container.scrollHeight - clientHeight);
      lastHeightRef.current = height;
      record(container);
      return;
    }
    const anchor = anchorRef.current;
    if (
      enabledRef.current
      && !suspendedRef.current
      && anchor?.row.isConnected
      && lastHeightRef.current >= 0
      && height !== lastHeightRef.current
    ) {
      const delta = anchor.row.offsetTop + deferredRef.current - anchor.top;
      if (Math.abs(delta) >= 1) {
        if (wrapper && inMotion(container)) {
          deferredRef.current += delta;
          wrapper.style.marginTop = `${-deferredRef.current}px`;
          scheduleFlush();
        } else {
          // Лента стояла в самом низу, а выше что-то стало короче: браузер уже
          // сам подтянул прокрутку к новому низу. Прибавлять сдвиг к ней —
          // вернуть его дважды: лента уезжала от низа (замер 27.09.26: строка
          // 96 → 28 px над экраном — 65 px от низа). Считаем от прокрутки,
          // при которой опора запомнена.
          const maxScrollTop = container.scrollHeight - container.clientHeight;
          const clampedByBrowser = container.scrollTop < anchor.scrollTop
            && container.scrollTop >= maxScrollTop - 1;
          const base = clampedByBrowser ? anchor.scrollTop : container.scrollTop;
          writeScrollTop(container, base + delta);
        }
      }
    }
    lastHeightRef.current = height;
    record(container);
  }, [inMotion, record, scheduleFlush, scrollContainerRef, suspendedRef, writeScrollTop]);

  /** Сбросить отложенный сдвиг без записи прокрутки — перед прыжком в низ. */
  const clearDeferredShift = useCallback(() => {
    const container = scrollContainerRef.current;
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (deferredRef.current === 0 || !container) return;
    deferredRef.current = 0;
    const wrapper = wrapperOf(container);
    if (wrapper) wrapper.style.marginTop = '';
  }, [scrollContainerRef]);

  const getDeferredShift = useCallback(() => deferredRef.current, []);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !enabled) return undefined;
    const wrapper = wrapperOf(container);

    const onScroll = () => {
      lastScrollAtRef.current = performance.now();
      reconcile();
    };
    const onWheel = () => { touchProvenanceRef.current = false; };
    const onTouchStart = () => {
      touchingRef.current = true;
      touchProvenanceRef.current = true;
      lastTouchAtRef.current = performance.now();
    };
    const onTouchMove = () => { lastTouchAtRef.current = performance.now(); };
    const onTouchEnd = () => {
      touchingRef.current = false;
      if (deferredRef.current !== 0) scheduleFlush();
    };
    // Приложение ушло в фон посреди жеста — касание кончилось, отступ снимаем.
    const onVisibilityChange = () => {
      touchingRef.current = false;
      lastScrollAtRef.current = 0;
      if (deferredRef.current !== 0) flush();
    };
    const onScrollEnd = () => {
      if (deferredRef.current !== 0 && !touchingRef.current) {
        lastScrollAtRef.current = 0;
        flush();
      }
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    container.addEventListener('wheel', onWheel, { passive: true });
    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: true });
    container.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onVisibilityChange);
    container.addEventListener('touchcancel', onTouchEnd, { passive: true });
    container.addEventListener('scrollend', onScrollEnd);

    let observer: ResizeObserver | null = null;
    if (wrapper && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => reconcile());
      observer.observe(wrapper);
      observer.observe(container);
    }
    reconcile();

    return () => {
      container.removeEventListener('scroll', onScroll);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onVisibilityChange);
      container.removeEventListener('touchcancel', onTouchEnd);
      container.removeEventListener('scrollend', onScrollEnd);
      observer?.disconnect();
      clearDeferredShift();
      anchorRef.current = null;
      lastHeightRef.current = -1;
      lastClientHeightRef.current = -1;
      wasAtBottomRef.current = false;
    };
  }, [clearDeferredShift, enabled, flush, reconcile, scheduleFlush, scrollContainerRef]);

  return { clearDeferredShift, getDeferredShift };
}

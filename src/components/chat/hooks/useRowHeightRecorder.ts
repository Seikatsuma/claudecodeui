import { useEffect } from 'react';
import type { RefObject } from 'react';

import { noteRowHeight } from '../utils/rowHeightCache';

/**
 * Пишет в кэш реальную высоту каждой размеченной строки ленты
 * (`rowHeightCache.ts` — там же зачем). Источник — ResizeObserver: он видит и
 * строки, размеченные браузером у экрана, и прогретые `useRowPrewarm` (их кадр
 * разметки приходит сюда же). Оценку отсеиваем `checkVisibility({
 * contentVisibilityAuto: true })`: пропущенная строка отдаёт примерную высоту,
 * и записывать её как настоящую нельзя.
 *
 * Ключ строки — `data-mid` (`getIntrinsicMessageKey`, ставится в
 * MessageComponent). Строки без ключа — свёртка «Ход работы» и прочие меняющие
 * высоту по действию — мимо кэша.
 */
export function useRowHeightRecorder({
  scrollContainerRef,
  enabled,
}: {
  scrollContainerRef: RefObject<HTMLDivElement>;
  enabled: boolean;
}) {
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !enabled) return undefined;
    if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return undefined;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const key = el.dataset.mid;
        if (!key) continue;
        // Строка ещё пропущена content-visibility — высота оценочная, не писать.
        if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ contentVisibilityAuto: true })) {
          continue;
        }
        noteRowHeight(key, Math.round(entry.contentRect.height));
      }
    });

    const observed = new WeakSet<HTMLElement>();
    const attach = (root: ParentNode) => {
      root.querySelectorAll<HTMLElement>('.chat-message[data-mid]').forEach((el) => {
        if (observed.has(el)) return;
        observed.add(el);
        observer.observe(el);
      });
    };
    attach(container);

    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          if (node.matches('.chat-message[data-mid]') && !observed.has(node)) {
            observed.add(node);
            observer.observe(node);
          }
          attach(node);
        });
      }
    });
    mutations.observe(container, { childList: true, subtree: true });

    return () => {
      mutations.disconnect();
      observer.disconnect();
    };
  }, [enabled, scrollContainerRef]);
}

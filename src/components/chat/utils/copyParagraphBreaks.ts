/**
 * Пустая строка между абзацами при копировании ответа выделением.
 *
 * Абзацы ответа разделены только отступом (`mb-2.5`), а отступ в буфер обмена
 * не попадает: Егор выделял ответ на iPhone и вставлял в Telegram — жирный
 * сохранялся, а пункты слипались строка к строке (25.09.26: «чтобы внешне не
 * менялось, но при копировании копировалось с переносом строки»).
 *
 * Буфер не подменяем: так пропал бы жирный, который приложения берут из
 * «богатой» копии браузера, а она на iOS устроена по-своему. Вместо этого на
 * время самого копирования между выделенными блоками ставится пустая строка
 * `<div><br></div>` — ровно то, чем браузер сам обозначает пустую строку, — а
 * до ближайшей отрисовки она убирается. Браузер собирает копию синхронно после
 * обработчика `copy`, кадр рисуется позже, поэтому на экране ничего не
 * мелькает; нулевая высота — страховка на случай, если кадр всё же вклинится.
 *
 * Пустая строка ставится только между блоками верхнего уровня одного ответа
 * (абзац, заголовок, список, цитата, код, таблица) — там, где в исходной
 * разметке стоит пустая строка. Пункты одного списка идут, как и на экране,
 * подряд.
 */

export const MARKDOWN_ROOT_ATTR = 'data-md-copy-root';

const SPACER_ATTR = 'data-md-copy-spacer';

type Restore = () => void;

// Номер пункта — как на экране: от `start` списка, с учётом `value` у пункта.
const insertListNumbers = (range: Range, restores: Restore[]) => {
  document.querySelectorAll<HTMLOListElement>(`[${MARKDOWN_ROOT_ATTR}] ol`).forEach((ol) => {
    if (!range.intersectsNode(ol)) return;
    const items = Array.from(ol.children).filter((el): el is HTMLLIElement => el.tagName === 'LI');
    let counter = ol.start || 1;
    let touched = false;
    items.forEach((li) => {
      if (li.hasAttribute('value')) counter = li.value;
      const number = counter;
      counter += 1;
      if (!range.intersectsNode(li)) return;
      // Абзац пункта — это div, номер ставится в него,
      // иначе номер окажется отдельной строкой над текстом.
      const first = li.firstElementChild;
      const host = first && first.tagName === 'DIV' && li.firstChild === first ? first : li;
      const label = document.createElement('span');
      label.setAttribute(SPACER_ATTR, '');
      label.textContent = `${number}. `;
      host.insertBefore(label, host.firstChild);
      restores.push(() => label.remove());
      // Выделение пальцем или мышью от первой буквы пункта начинается внутри
      // текста, правее вставленного номера, и номер первого пункта в копию не
      // попадал. Если до начала выделения в пункте ничего нет — захватить номер.
      if (range.comparePoint(label, 0) < 0) {
        const gap = document.createRange();
        gap.setStartAfter(label);
        gap.setEnd(range.startContainer, range.startOffset);
        if (gap.toString().trim() === '') range.setStartBefore(label);
      }
      touched = true;
    });
    if (touched) {
      const previous = ol.style.listStyleType;
      ol.style.listStyleType = 'none';
      restores.push(() => {
        ol.style.listStyleType = previous;
      });
    }
  });
};

const makeSpacer = (): HTMLElement => {
  const spacer = document.createElement('div');
  spacer.setAttribute(SPACER_ATTR, '');
  spacer.setAttribute('aria-hidden', 'true');
  spacer.style.height = '0';
  spacer.style.overflow = 'hidden';
  spacer.appendChild(document.createElement('br'));
  return spacer;
};

// Выделение после вставки строк надо поставить заново. Chrome числа границ
// сдвигает, но внутренний снимок выделения остаётся прежним и обрывает копию
// там, где раньше был его конец: из полного ответа в буфер попадала половина.
// Переустановка тем же отдельным Range снимок обновляет.
const reselect = (selection: Selection, range: Range) => {
  selection.removeAllRanges();
  selection.addRange(range);
};

const insertSpacers = (): { restores: Restore[]; selection: Selection; range: Range } | null => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0).cloneRange();
  const restores: Restore[] = [];
  document.querySelectorAll<HTMLElement>(`[${MARKDOWN_ROOT_ATTR}]`).forEach((root) => {
    if (!range.intersectsNode(root)) return;
    const blocks = Array.from(root.children).filter(
      (el) => !el.hasAttribute(SPACER_ATTR) && range.intersectsNode(el),
    );
    for (let i = 1; i < blocks.length; i += 1) {
      const spacer = makeSpacer();
      root.insertBefore(spacer, blocks[i]);
      restores.push(() => spacer.remove());
    }
  });
  insertListNumbers(range, restores);
  if (restores.length > 0) reselect(selection, range);
  return { restores, selection, range };
};

const handleCopy = () => {
  let result: ReturnType<typeof insertSpacers> = null;
  try {
    result = insertSpacers();
  } catch {
    return;
  }
  if (!result || result.restores.length === 0) return;
  const { restores, selection, range } = result;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    restores.forEach((restore) => restore());
    // Выделение человека остаётся ровно тем, что он выделил.
    try {
      reselect(selection, range);
    } catch {
      /* выделение уже сменилось — не трогаем */
    }
  };
  requestAnimationFrame(cleanup);
  // Вкладка в фоне не получает кадров — убрать и без них.
  setTimeout(cleanup, 100);
};

let installed = false;

export const installCopyParagraphBreaks = () => {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  // Захват: сработать раньше любых других обработчиков копирования.
  document.addEventListener('copy', handleCopy, true);
};

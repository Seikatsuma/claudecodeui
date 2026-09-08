export function normalizeInlineCodeFences(text: string) {
  if (!text || typeof text !== 'string') return text;
  try {
    return text.replace(/```[ \t]*([^\n\r]+?)[ \t]*```/g, '`$1`');
  } catch {
    return text;
  }
}

/**
 * Отбивает списки и заголовки пустой строкой, если её не поставила модель.
 *
 * Разметка Markdown устроена строго: нумерованный список начинает новый блок
 * только если он начинается с единицы. Поэтому текст вида
 *
 *     Полезные, но не срочные (11)
 *     11. «Сегодня»: карточка …
 *     12. «Дети»: верхние метрики …
 *
 * склеивался в один сплошной абзац — все пункты шли подряд через точку, и
 * читать это было нечем. Ровно то же происходило с заголовком, который
 * модель написала вплотную к предыдущей строке.
 *
 * Здесь недостающая пустая строка ставится сама. Внутри блоков кода ничего
 * не трогается: там перевод строки значим, и лишняя пустая строка ломает
 * отступы.
 */
export function separateMarkdownBlocks(text: string): string {
  if (!text || typeof text !== 'string') return text;

  const lines = text.split('\n');
  const out: string[] = [];
  let insideFence = false;

  const isListItem = (line: string) => /^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+\S/.test(line);
  const isHeading = (line: string) => /^[ \t]{0,3}#{1,6}[ \t]+\S/.test(line);
  const isBlank = (line: string) => line.trim() === '';
  // Продолжение пункта — строка с отступом под уже начатым списком.
  const isIndented = (line: string) => /^[ \t]+\S/.test(line);

  for (const line of lines) {
    if (/^[ \t]{0,3}(?:```|~~~)/.test(line)) {
      insideFence = !insideFence;
      out.push(line);
      continue;
    }
    if (insideFence) {
      out.push(line);
      continue;
    }

    const previous = out.length > 0 ? out[out.length - 1] : '';
    const needsGap =
      !isBlank(previous) &&
      !isListItem(previous) &&
      !isIndented(previous) &&
      (isListItem(line) || isHeading(line));

    if (needsGap) out.push('');
    out.push(line);
  }

  return out.join('\n');
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes Codex's outer plan transport envelope while preserving its Markdown.
 * The closing tag is optional because streamed plans expose the opening tag
 * before the complete response arrives.
 */
export function stripProposedPlanEnvelope(text: string) {
  if (!text || typeof text !== 'string') return text;

  const openingTag = /^\s*<proposed_plan>[ \t]*(?:\r?\n)?/i;
  if (!openingTag.test(text)) return text;

  const withoutOpeningTag = text.replace(openingTag, '');
  return withoutOpeningTag.replace(/(?:\r?\n)?[ \t]*<\/proposed_plan>\s*$/i, '');
}

export function formatUsageLimitText(text: string) {
  try {
    if (typeof text !== 'string') return text;
    return text.replace(/Claude AI usage limit reached\|(\d{10,13})/g, (match, ts) => {
      let timestampMs = parseInt(ts, 10);
      if (!Number.isFinite(timestampMs)) return match;
      if (timestampMs < 1e12) timestampMs *= 1000;
      const reset = new Date(timestampMs);

      const timeStr = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(reset);

      const offsetMinutesLocal = -reset.getTimezoneOffset();
      const sign = offsetMinutesLocal >= 0 ? '+' : '-';
      const abs = Math.abs(offsetMinutesLocal);
      const offH = Math.floor(abs / 60);
      const offM = abs % 60;
      const gmt = `GMT${sign}${offH}${offM ? ':' + String(offM).padStart(2, '0') : ''}`;
      const tzId = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      const cityRaw = tzId.split('/').pop() || '';
      const city = cityRaw
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, (char) => char.toUpperCase());
      const tzHuman = city ? `${gmt} (${city})` : gmt;

      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const dateReadable = `${reset.getDate()} ${months[reset.getMonth()]} ${reset.getFullYear()}`;

      return `Claude usage limit reached. Your limit will reset at **${timeStr} ${tzHuman}** - ${dateReadable}`;
    });
  } catch {
    return text;
  }
}

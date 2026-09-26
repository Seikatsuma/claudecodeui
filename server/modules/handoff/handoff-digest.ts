/**
 * Сжатый текст переписки чата — материал, из которого модель пишет выжимку
 * для нового чата («Продолжить в новом чате»).
 *
 * Файл переписки у долгого чата — десятки мегабайт: вывод команд, чтение
 * файлов, размышления, служебные записи. Модели, которая пишет выжимку, из
 * этого нужны слова человека, ответы агента и следы действий (какие файлы
 * правились, какие команды шли). Остальное отбрасывается здесь, без модели.
 *
 * Что берётся и почему (сверено с открытыми практиками передачи дел, 23.09.26):
 * - Сообщения человека — все и почти дословно: встроенное сжатие Claude Code
 *   держит раздел «All user messages», потому что именно в них поправки и
 *   смена намерения.
 * - Ответы агента — текстом, без размышлений: размышления — черновик, выводы
 *   в тексте.
 * - Действия — одной строкой: путь правленого файла, описание команды, запрос
 *   поиска, задание помощника. Вывод инструментов не берётся (Anthropic:
 *   «clearing tool calls and results» — первое, что выбрасывает сжатие),
 *   кроме коротких ошибок: неудачные попытки дороже всего открывать заново.
 * - Сжатие внутри чата уже было — берётся последняя сводка сжатия и всё после
 *   неё (ровно то, что агент чата сейчас «помнит»), а из части до неё — только
 *   сообщения человека: сводки сжатия теряют поправки чаще всего остального.
 */
import { createReadStream } from 'node:fs';
import readline from 'node:readline';

import { isTranscriptServiceText, stripInjectedContext } from '@/shared/utils.js';

/** Потолок одного сообщения человека: длинные вставки (логи, тексты) режутся. */
const HUMAN_MESSAGE_MAX_CHARS = 6000;
/** Потолок одного текстового ответа агента. */
const ASSISTANT_TEXT_MAX_CHARS = 4000;
/** Потолок сводки сжатия (их пишет сама модель, обычно 5–20 тыс. знаков). */
const COMPACT_SUMMARY_MAX_CHARS = 40000;
/** Короткая ошибка инструмента — сколько знаков оставить. */
const TOOL_ERROR_MAX_CHARS = 240;
/** Сколько последних правленых файлов перечислять в шапке выжимки. */
const CHANGED_FILES_LIMIT = 40;

type AnyRecord = Record<string, any>;

type DigestEntry =
  | { kind: 'human'; at: string | null; text: string }
  | { kind: 'assistant'; at: string | null; text: string }
  | { kind: 'action'; text: string }
  | { kind: 'compact'; at: string | null; text: string };

/** Итог разбора переписки: текст для модели и факты, собранные без модели. */
export type TranscriptDigest = {
  /** Текст для модели: сообщения по порядку, по строке на действие. */
  text: string;
  /** Файлы, которые правились в чате (последние сверху), — для шапки выжимки. */
  changedFiles: string[];
  /** Сколько сообщений человека попало в текст. */
  humanMessages: number;
  /** Было ли внутри чата сжатие (тогда ранняя часть — только слова человека). */
  hadCompaction: boolean;
};

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)} …[обрезано, всего ${text.length} зн.]`;
}


function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part: AnyRecord) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part: AnyRecord) => part.text as string)
    .join('\n');
}

function hasImage(content: unknown): boolean {
  return Array.isArray(content) && content.some((part: AnyRecord) => part?.type === 'image');
}

function oneLine(text: string, max: number): string {
  return clip(text.replace(/\s+/g, ' ').trim(), max);
}

/** Одна строка о вызове инструмента. Чтение и поиск по файлам не пишутся: их много, смысла мало. */
function describeToolUse(block: AnyRecord): string | null {
  const name = String(block.name ?? '');
  const input: AnyRecord = block.input && typeof block.input === 'object' ? block.input : {};
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return typeof input.file_path === 'string' || typeof input.notebook_path === 'string'
        ? `${name === 'Write' ? 'записан файл' : 'правка файла'} ${input.file_path ?? input.notebook_path}`
        : null;
    case 'Bash': {
      const described = typeof input.description === 'string' && input.description.trim();
      const command = typeof input.command === 'string' ? input.command : '';
      return described
        ? `команда: ${oneLine(described, 160)} — \`${oneLine(command, 160)}\``
        : `команда: \`${oneLine(command, 220)}\``;
    }
    case 'Agent':
    case 'Task':
      return `помощник: ${oneLine(String(input.description ?? input.prompt ?? ''), 200)}`;
    case 'WebSearch':
      return `поиск в сети: ${oneLine(String(input.query ?? ''), 200)}`;
    case 'WebFetch':
      return `открыта страница: ${oneLine(String(input.url ?? ''), 200)}`;
    case 'Skill':
      return `навык: ${oneLine(String(input.skill ?? input.name ?? ''), 120)}`;
    default:
      if (name.startsWith('mcp__')) return `внешний инструмент: ${name.replace(/^mcp__/, '')}`;
      return null;
  }
}

function formatTime(at: string | null): string {
  if (!at) return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `[${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}] `;
}

/**
 * Разбирает строки переписки одного чата. Отдельно от чтения файла — чтобы
 * проверять разбор в тестах на строках, без файлов.
 */
export function digestTranscriptLines(lines: Iterable<string>, providerSessionId: string | null): TranscriptDigest {
  const builder = createDigestBuilder(providerSessionId);
  for (const line of lines) builder.add(line);
  return builder.finish();
}

/**
 * Разбор по одной строке: файл переписки не держится в памяти целиком, в
 * памяти только уже сжатые записи.
 */
function createDigestBuilder(providerSessionId: string | null) {
  const entries: DigestEntry[] = [];
  const changedFiles = new Map<string, number>();
  let order = 0;

  const add = (line: string): void => {
    if (!line.trim()) return;
    let entry: AnyRecord;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    // В файле бывают строки других разговоров (продолжения, ветки) — только свой.
    if (providerSessionId && entry.sessionId && entry.sessionId !== providerSessionId) return;
    if (entry.isSidechain) return;
    const at = typeof entry.timestamp === 'string' ? entry.timestamp : null;
    const content = entry.message?.content;

    if (entry.type === 'user') {
      if (entry.isCompactSummary) {
        const summary = stripInjectedContext(textOfContent(content));
        if (summary) entries.push({ kind: 'compact', at, text: clip(summary, COMPACT_SUMMARY_MAX_CHARS) });
        return;
      }
      if (entry.isMeta) return;
      if (entry.toolUseResult !== undefined || (Array.isArray(content) && content.some((p: AnyRecord) => p?.type === 'tool_result'))) {
        // Из результатов берём только короткие ошибки — след неудачной попытки.
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part?.type === 'tool_result' && part.is_error) {
              const errorText = typeof part.content === 'string' ? part.content : textOfContent(part.content);
              if (errorText.trim()) entries.push({ kind: 'action', text: `ошибка: ${oneLine(errorText, TOOL_ERROR_MAX_CHARS)}` });
            }
          }
        }
        return;
      }
      const raw = textOfContent(content).trim();
      if (isTranscriptServiceText(raw)) return;
      const text = stripInjectedContext(raw);
      if (!text && !hasImage(content)) return;
      const withImage = hasImage(content) ? `${text}${text ? ' ' : ''}[приложено изображение]` : text;
      entries.push({ kind: 'human', at, text: clip(withImage, HUMAN_MESSAGE_MAX_CHARS) });
      return;
    }

    if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          entries.push({ kind: 'assistant', at, text: clip(block.text.trim(), ASSISTANT_TEXT_MAX_CHARS) });
        } else if (block?.type === 'tool_use') {
          const described = describeToolUse(block);
          if (described) entries.push({ kind: 'action', text: described });
          const file = block.input?.file_path ?? block.input?.notebook_path;
          if (typeof file === 'string' && ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(block.name)) {
            changedFiles.set(file, order++);
          }
        }
      }
    }
  };

  const finish = (): TranscriptDigest => {
    const lastCompact = entries.map((entry) => entry.kind).lastIndexOf('compact');
    const out: string[] = [];
    let humanMessages = 0;
    entries.forEach((entry, index) => {
      const beforeCompaction = lastCompact >= 0 && index < lastCompact;
      if (beforeCompaction && entry.kind !== 'human') return;
      switch (entry.kind) {
        case 'human':
          humanMessages += 1;
          out.push(`\n${formatTime(entry.at)}ЧЕЛОВЕК: ${entry.text}`);
          break;
        case 'assistant':
          out.push(`${formatTime(entry.at)}АГЕНТ: ${entry.text}`);
          break;
        case 'action': {
          const line = `  · ${entry.text}`;
          // Одинаковые действия подряд (десять одинаковых правок одного файла) — одной строкой.
          if (out[out.length - 1] !== line) out.push(line);
          break;
        }
        case 'compact':
          out.push(`\n${formatTime(entry.at)}СВОДКА СЖАТИЯ (так агент чата помнил всё, что было до этого места):\n${entry.text}\n`);
          break;
      }
    });

    if (lastCompact > 0) {
      out.unshift('(До последнего сжатия чата ниже оставлены только сообщения человека; остальное до него пересказано в сводке сжатия.)');
    }

    return {
      text: out.join('\n').trim(),
      changedFiles: [...changedFiles.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, CHANGED_FILES_LIMIT)
        .map(([file]) => file),
      humanMessages,
      hadCompaction: lastCompact >= 0,
    };
  };

  return { add, finish };
}

/** Читает файл переписки построчно (файлы бывают по сотне мегабайт) и разбирает его. */
export async function digestTranscriptFile(filePath: string, providerSessionId: string | null): Promise<TranscriptDigest> {
  const builder = createDigestBuilder(providerSessionId);
  const reader = readline.createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of reader) builder.add(line);
  return builder.finish();
}

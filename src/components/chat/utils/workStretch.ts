import type { ChatMessage } from '../types/types';
import { groupConsecutiveTools, isEmptyThinking, type MessageListItem } from './toolGrouping';

/**
 * «Ход работы»: всё, что ИИ делал между сообщением человека и своим ответом,
 * одним свёрнутым элементом ленты.
 *
 * Егор 13.09.26 на ленту из десятков строк «Думал несколько секунд: I need to…»,
 * «Read / путь», «Bash / …»: «слишком много лишнего… посмотри как делает сам чат
 * Claude и как пишет VS Code… оставь описание только ключевых размышлений и
 * свёрнуто, описывай их на русском. Должно быть только то, что мне нужно знать в
 * размышлениях и то что он сделал, только нужные отчётности».
 *
 * Образец — Claude Code для VS Code и приложение Claude: работа идёт свёрнутыми
 * строками, а ответ модели — это и есть отчёт, он виден целиком. Здесь вся
 * работа между двумя «настоящими» сообщениями (текст человека, текст ответа,
 * ошибка, вопрос с кнопками) становится одним элементом.
 *
 * Какие из мыслей показать, решает не этот файл, а разбор по смыслу при
 * раскрытии (WorkStretchContainer → /api/user/thought-digest): важные этапы
 * видны все, сколько бы их ни было, рабочие мелочи — нет.
 */
export interface WorkStretchItem {
  _isStretch: true;
  messages: ChatMessage[];
  /** Все непустые мысли свёртки по порядку — кандидаты на показ. */
  thoughts: ChatMessage[];
  actionCount: number;
  /** Сколько действий завершилось ошибкой — в свёрнутой строке это видно сразу. */
  errorCount: number;
  timestamp: ChatMessage['timestamp'];
}

/**
 * Мысль, которую есть смысл отдавать на разбор: не пустая и не служебная
 * короткая реплика («жду», «проверю»). Язык не важен — модель размышляет
 * по-английски, на русский переводит разбор.
 *
 * Потолка в три мысли больше нет. Егор 14.09.26: «если он думал несколько
 * часов, пусть распишет каждый пункт, который важный, ценный — этап какой-то,
 * research закончил, критику запустил. Это я хочу видеть. До этого он писал
 * абсолютно всё, и это было лишним».
 */
export function isReadableThought(message: ChatMessage): boolean {
  if (!message.isThinking || isEmptyThinking(message)) return false;
  const letters = String(message.content ?? '').match(/\p{L}/gu) ?? [];
  return letters.length >= 20;
}

/** Текст уже по-русски — переводить не нужно. */
export function isMostlyRussian(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return true;
  const cyrillic = letters.filter((ch) => /[Ѐ-ӿ]/.test(ch)).length;
  return cyrillic / letters.length >= 0.5;
}

/**
 * Что делается сейчас — описание последнего действия («Проверяю, дошла ли
 * правка до сайта»), которое ИИ пишет к каждому вызову.
 *
 * Показывается прямо в свёрнутой строке: Егор 14.09.26 «я не видел размышлений
 * минут 15, я должен понимать, на каких ты этапах». Раскрывать свёртку ради
 * этого не нужно, и перевод не требуется — описания и так по-русски.
 *
 * Тот же разбор `description` из входа инструмента нужен и для живой плашки
 * статуса, пока действие ещё выполняется (см. `toolInputDescription` ниже,
 * используется в useChatRealtimeHandlers) — Егор 17.09.26: строка внизу должна
 * показывать «прям название, что ты в данный момент производишь», а не имя
 * инструмента.
 */
export function toolInputDescription(rawInput: unknown): string | null {
  let input: unknown = rawInput;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      return null;
    }
  }
  const description = input && typeof input === 'object'
    ? (input as { description?: unknown }).description
    : undefined;
  return typeof description === 'string' && description.trim() ? description.trim() : null;
}

export function lastStepDescription(messages: ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message.isToolUse) continue;
    const description = toolInputDescription(message.toolInput);
    if (description) return description;
  }
  return null;
}

export function isWorkStretchItem(item: unknown): item is WorkStretchItem {
  return Boolean(item && typeof item === 'object' && (item as WorkStretchItem)._isStretch === true);
}

/**
 * Вызовы, которые человек должен увидеть сам, а не искать в свёртке: план на
 * утверждение и вопрос с вариантами ответа.
 */
const ALWAYS_VISIBLE_TOOLS = new Set(['ExitPlanMode', 'exit_plan_mode', 'AskUserQuestion']);

/** Шаг помощника — всё, что пришло с пометкой вызова Agent/Task. */
export function isHelperMessage(message: ChatMessage): boolean {
  return typeof message.parentToolUseId === 'string' && message.parentToolUseId.length > 0;
}

function isWorkMessage(message: ChatMessage): boolean {
  if (message.isThinking) return true;
  // Всё, что делает и пишет помощник, — работа, а не ответ чата: его реплика
  // «Устойчиво 3/3, запускаю полный прогон» раньше рвала «Ход работы» и
  // стояла в ленте как ответ ИИ.
  if (isHelperMessage(message)) return true;
  // Запрос разрешения требует действия человека — он не прячется в свёртку.
  if (message.isToolUse && !message.isInteractivePrompt && !ALWAYS_VISIBLE_TOOLS.has(String(message.toolName ?? ''))) {
    return true;
  }
  return false;
}

export function groupWorkStretches<T extends ChatMessage>(messages: T[]): Array<T | WorkStretchItem> {
  const items: Array<T | WorkStretchItem> = [];
  let run: T[] = [];

  const flush = () => {
    if (run.length === 0) return;
    // Считаются только шаги самого чата: шаги помощника приходят лишь живьём
    // и после перечитывания переписки пропадают, число «прыгало» бы.
    const own = run.filter((message) => !isHelperMessage(message));
    const actionCount = own.filter((message) => message.isToolUse).length;
    const errorCount = own.filter((message) => message.isToolUse && message.toolResult?.isError).length;
    const thoughts = own.filter(isReadableThought);
    // Только пустые размышления — показывать нечего, ни строки, ни свёртки.
    if (actionCount > 0 || thoughts.length > 0 || own.length < run.length) {
      items.push({
        _isStretch: true,
        messages: run,
        thoughts,
        actionCount,
        errorCount,
        timestamp: run[0].timestamp,
      });
    }
    run = [];
  };

  for (const message of messages) {
    if (isWorkMessage(message)) {
      run.push(message);
      continue;
    }
    flush();
    items.push(message);
  }
  flush();
  return items;
}

function pluralRu(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * Подпись свёрнутой строки: «Ход работы · 5 этапов · 9 действий · 1 ошибка».
 *
 * Число этапов известно только после разбора; до него строка честно говорит
 * «размышления», а не число сырых мыслей, которых покажется меньше.
 */
export function describeWorkStretch(item: {
  actionCount: number;
  errorCount?: number;
  /** Сколько важных этапов нашёл разбор; undefined — разбора ещё не было. */
  stageCount?: number;
  hasThoughts?: boolean;
}): string {
  const parts = ['Ход работы'];
  if (typeof item.stageCount === 'number') {
    if (item.stageCount > 0) parts.push(`${item.stageCount} ${pluralRu(item.stageCount, 'этап', 'этапа', 'этапов')}`);
  } else if (item.hasThoughts && item.actionCount === 0) {
    parts.push('размышления');
  }
  if (item.actionCount > 0) {
    parts.push(`${item.actionCount} ${pluralRu(item.actionCount, 'действие', 'действия', 'действий')}`);
  }
  const errors = item.errorCount ?? 0;
  if (errors > 0) parts.push(`${errors} ${pluralRu(errors, 'ошибка', 'ошибки', 'ошибок')}`);
  return parts.join(' · ');
}

/**
 * Что показать внутри раскрытого «Хода работы»: показываемые мысли и шаги по
 * порядку, подряд идущие одинаковые действия — одной строкой.
 *
 * Мысли передаются в склейку как ВИДИМЫЕ. Первая версия звала склейку с
 * «размышления скрыты», и та пропускала мысли между действиями как невидимые:
 * подпись обещала «19 мыслей», а раскрытая свёртка показывала одни действия
 * (снимок живой страницы 13.09.26).
 */
export function workStretchRows(
  stretch: Pick<WorkStretchItem, 'messages'>,
  shownThoughts: ReadonlySet<ChatMessage>,
): MessageListItem[] {
  const visible = stretch.messages.filter((message) => {
    // Мысли помощника не показываются (без перевода и разбора); его действия и
    // реплики видны — реплику WorkStretchContainer рисует строкой, не пузырём.
    if (isHelperMessage(message) && message.isThinking) return false;
    return !message.isThinking || shownThoughts.has(message);
  });
  return groupConsecutiveTools(visible, true);
}

export interface LiveTailLine {
  key: string;
  kind: 'stage' | 'step' | 'note';
  text: string;
  /** Название помощника («Проверяющий, круг 2»), если шаг его. */
  helper: string | null;
  /** Действие ещё выполняется. */
  running: boolean;
  isError: boolean;
  /** Строка — сам запуск помощника (его шаги идут ниже с отступом). */
  isAgentCall?: boolean;
}

const LIVE_NOTE_MAX_CHARS = 220;

function isAgentCall(message: ChatMessage): boolean {
  const name = String(message.toolName ?? '');
  return Boolean(message.isToolUse) && (name === 'Agent' || name === 'Task');
}

/**
 * Живой хвост «Хода работы», пока чат работает: последние этапы мысли и шаги,
 * включая шаги помощников, — чтобы было видно, на чём ИИ думает сейчас.
 *
 * Егор 19.09.26: «в процессе я бы видел больше размышлений, чтобы понимать, на
 * чём он думает. Но так, чтобы потом чат не засорялся — всё сжималось в папки
 * как сейчас». Хвост есть только у последней свёртки и только пока идёт
 * работа; закончилась — остаётся одна свёрнутая строка.
 *
 * `stageText` — русский текст мысли, если разбор счёл её важным этапом; мелочи
 * и ещё не разобранные мысли в хвост не попадают.
 */
export function workStretchLiveTail(
  stretch: Pick<WorkStretchItem, 'messages'>,
  stageText: (message: ChatMessage) => string | null,
  limit = 6,
): LiveTailLine[] {
  const helperNames = new Map<string, string>();
  for (const message of stretch.messages) {
    if (isAgentCall(message) && message.toolId) {
      helperNames.set(message.toolId, toolInputDescription(message.toolInput) ?? 'помощник');
    }
  }

  const lines: LiveTailLine[] = [];
  stretch.messages.forEach((message, index) => {
    const helper = isHelperMessage(message) ? helperNames.get(message.parentToolUseId as string) ?? 'помощник' : null;
    const key = `${message.toolId ?? message.id ?? ''}-${index}`;
    if (message.isThinking) {
      if (helper) return;
      const text = stageText(message);
      if (text) lines.push({ key, kind: 'stage', text, helper: null, running: false, isError: false });
      return;
    }
    if (message.isToolUse) {
      const description = toolInputDescription(message.toolInput);
      const toolName = String(message.toolName ?? 'Действие');
      // Codex code-mode tools do not carry Claude's human `description`.
      // Repeating their plumbing names in the live tail (exec, Bash, exec…)
      // hides the useful commentary text. The action still remains counted,
      // visible when expanded, and represented by the bottom activity bar.
      if (!description && (toolName === 'exec' || toolName === 'Bash')) return;
      const text = description ?? toolName;
      lines.push({
        key,
        kind: 'step',
        text,
        helper,
        running: !message.toolResult,
        isError: Boolean(message.toolResult?.isError),
        isAgentCall: !helper && isAgentCall(message),
      });
      return;
    }
    if (helper && message.type === 'assistant') {
      const raw = String(message.content ?? '').replace(/\s+/g, ' ').trim();
      if (!raw) return;
      const text = raw.length > LIVE_NOTE_MAX_CHARS ? `${raw.slice(0, LIVE_NOTE_MAX_CHARS - 1)}…` : raw;
      lines.push({ key, kind: 'note', text, helper, running: false, isError: false });
    }
  });
  return lines.slice(-limit);
}

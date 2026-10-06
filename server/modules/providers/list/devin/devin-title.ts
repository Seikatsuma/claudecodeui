/**
 * Короткое имя чата Devin для узкой панели слева (Егор 06.10.26: «названия
 * чуть короче и ключевые слова различающие в начале — в списке виден только
 * початок строки»). Выжимка, которую CLI пишет в `sessions.title`, бывает
 * длинной и начинается с общих слов («Code UI версии на сервере Осии
 * Криблеевой занимают 25 ГБ») — различительное съезжает за край. Поэтому
 * имя пишет отдельный разовый вызов `devin -p` (токены Devin, не Claude —
 * то же правило, что у выжимки переноса), а сырой `title` служит лишь
 * черновиком-подсказкой и запасным вариантом при сбоях модели.
 */

/**
 * Сколько символов имён реально видно в панели. Модель просят короче, но
 * хвост за пределом режется здесь — по границе слова, не посреди.
 */
export const CHAT_TITLE_MAX_CHARS = 48;

/** Попыток сгенерировать имя на чат; дальше — запасной вариант из `sessions.title`. */
export const TITLE_MAX_ATTEMPTS = 4;
/** Пауза между попытками при сбое разового вызова. */
export const TITLE_RETRY_MS = 15 * 60 * 1000;
/** Таймаут разового вызова названия — короче handoff-дайджеста, имя мелкое. */
export const TITLE_ASK_TIMEOUT_MS = 90 * 1000;

/** Сырой материал для имени: первые различные сообщения человека + черновик CLI. */
export type DevinTitleInput = {
  userMessages: string[];
  devinTitle?: string;
};

const MESSAGE_CHARS_FOR_TITLE = 400;
const MESSAGES_FOR_TITLE = 3;
const SERIALIZED_TOOL_TITLE = /functions\.[\w-]+:\d+/;

/** Потребитель: `devin-session-synchronizer.provider.ts` — сборка промпта для разового вызова. */
export function buildChatTitlePrompt(input: DevinTitleInput): string {
  const messages = input.userMessages
    .slice(0, MESSAGES_FOR_TITLE)
    .map((message) => message.replace(/\s+/g, ' ').trim().slice(0, MESSAGE_CHARS_FOR_TITLE))
    .filter(Boolean);
  const draft = input.devinTitle?.replace(/\s+/g, ' ').trim().slice(0, 120);
  return [
    'Назови чат человека с ИИ-помощником. Название показывается в узком списке слева — видно примерно 35–40 символов, хвост обрезается.',
    '',
    'Требования к названию:',
    `- до 6 слов и до ~${CHAT_TITLE_MAX_CHARS} символов;`,
    'первым — самое различающее слово: проект, продукт, имя, число, сервер, технология;',
    'не начинай с общих слов («слушай», «посмотри», «надо», «разбор», «анализ», «создание», «настройка», «помощь»): сначала сущность, потом действие;',
    'образец стиля: «25 ГБ — версии Code UI», «Devin — названия чатов»;',
    'без кавычек, эмодзи и точки в конце; язык — язык переписки.',
    '',
    ...(draft ? [`Черновое название от системы: «${draft}»`, ''] : []),
    'Начало переписки:',
    ...messages.map((message, index) => `${index + 1}. «${message}»`),
    '',
    'Ответь только названием, одной строкой.',
  ].join('\n');
}

/**
 * Ответ модели → пригодное имя или null. Отбраковываем: пустое, сырой JSON,
 * сериализацию вызова инструмента, эхо первого сообщения (замораживать
 * обрезок промпта нельзя — его и так показывает naive-имя). Длинное имя не
 * бракуем, а укорачиваем по слову: смысл уже выбран моделью.
 *
 * Потребитель: `devin-session-synchronizer.provider.ts`.
 */
export function cleanGeneratedTitle(raw: string, firstUserMessage?: string): string | null {
  let title = (raw.split('\n').find((line) => line.trim()) ?? '').trim();
  title = title.replace(/\s+/g, ' ').replace(/[.…\s]+$/g, '').trim();
  // Снимаем только ПАРНЫЕ внешние кавычки: «Название» → Название, а
  // «Кнопка «показать ещё»» внутреннюю цитату не калечим.
  if (title.length > 2 && /^[«"“”']/.test(title) && /[»"“”']$/.test(title)) {
    title = title.slice(1, -1).trim();
  }
  if (
    title.length < 2
    || SERIALIZED_TOOL_TITLE.test(title)
    || title.startsWith('{')
    || title.startsWith('[')
  ) {
    return null;
  }
  if (firstUserMessage && isEchoTitle(title, firstUserMessage)) {
    return null;
  }
  if (title.length > CHAT_TITLE_MAX_CHARS) {
    const cut = title.slice(0, CHAT_TITLE_MAX_CHARS);
    title = (cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut).trim();
  }
  return title.length >= 2 ? title : null;
}

/**
 * Потребители: `cleanGeneratedTitle` здесь и `echoesFirstPrompt` в
 * синхронизаторе — одинаковая проверка «название = обрезок первой реплики».
 */
export function isEchoTitle(title: string, messageContent: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  const normalizedTitle = normalize(title);
  const normalizedContent = normalize(messageContent);
  return normalizedContent.startsWith(normalizedTitle)
    || normalizedTitle.startsWith(normalizedContent);
}

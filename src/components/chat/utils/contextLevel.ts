/**
 * Насколько разросся чат — по заполненности окна модели (счётчик у поля ввода).
 *
 * Егор 27.09.26: «на 500 тысячах кнопка переноса загорается жёлтым, неярко —
 * скорее всего пора переходить; на 700–800 — красным: точно пора. Лишних
 * оповещений не нужно». Пороги — доли окна, а не токены: 50% и 70% окна
 * в 1 млн — ровно 500 и 700 тыс.; у модели с окном 200 тыс. — 100 и 140.
 *
 * Почему 700, а не 800 (разбор 27.09.26, 1395 сообщений Егора в 133 чатах):
 * упрёков «ИИ ошибся» в лучшей зоне 200–400 тыс. — 19–24%, на 400–500 — 30%,
 * на 500–900 — плато 33–38%. Сам чат сжимается на ≈ 967 тыс.; от 700 тыс. до
 * этого остаётся ≈ 25–50 сообщений, от 800 — вдвое меньше: успеть перейти.
 */
export type ContextLevel = 'normal' | 'yellow' | 'red';

export const CONTEXT_YELLOW_SHARE = 0.5;
export const CONTEXT_RED_SHARE = 0.7;
const DEFAULT_WINDOW = 1_000_000;

const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

/** Заполненность окна 0…1 по данным счётчика (used / total). */
export function contextShare(tokenBudget: Record<string, unknown> | null | undefined): number {
  if (!tokenBudget) return 0;
  const used = num(tokenBudget.used);
  const total = num(tokenBudget.total) || DEFAULT_WINDOW;
  return used / total;
}

export function contextLevel(tokenBudget: Record<string, unknown> | null | undefined): ContextLevel {
  const share = contextShare(tokenBudget);
  if (share >= CONTEXT_RED_SHARE) return 'red';
  if (share >= CONTEXT_YELLOW_SHARE) return 'yellow';
  return 'normal';
}

/**
 * Десяток процентов окна, с которого сервер собирает выжимку заранее
 * (5 = половина окна, когда кнопка желтеет; дальше 6, 7, 8, 9). До половины — 0:
 * заготовка не нужна, нажатие соберёт выжимку заново.
 */
export function prepareStep(tokenBudget: Record<string, unknown> | null | undefined): number {
  const share = contextShare(tokenBudget);
  if (share < CONTEXT_YELLOW_SHARE) return 0;
  return Math.min(9, Math.floor(share * 10));
}

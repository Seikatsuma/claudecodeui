/**
 * Одна оборванная труба не должна ронять весь сервер.
 *
 * 09.09 служба падала дважды за утро: сначала от нехватки памяти, потом с
 * `Error: write EPIPE` — «Unhandled 'error' event». Второе особенно обидно:
 * это всего лишь запись в сокет, который к тому моменту закрылся с другой
 * стороны. Обработчика на него не было нигде, поэтому Node останавливал
 * процесс целиком — вместе с чатами всех, кто в этот момент работал.
 *
 * Для человека это выглядело так: отправил сообщение — и ни ответа, ни
 * размышлений, ни ошибки. Ровно то, на что жаловался Егор: «такое ощущение,
 * как будто всё зависает».
 *
 * Здесь два правила:
 *
 * 1. Сетевые обрывы (труба закрылась, соединение сброшено, запись в уже
 *    закрытый поток) не убивают процесс. Это нормальная жизнь сети: браузер
 *    закрыли, телефон уснул, туннель моргнул. Пишем в журнал и работаем
 *    дальше.
 *
 * 2. Всё остальное — настоящая беда: состояние процесса больше не понятно, и
 *    продолжать опаснее, чем перезапуститься. Пишем в журнал и выходим с
 *    ненулевым кодом, чтобы systemd поднял службу заново.
 *
 * Необработанные отказы промисов не валят процесс никогда: в Node 22 они
 * убивают его по умолчанию, а у нас это чаще всего брошенный запрос к
 * провайдеру, из-за которого терять чужие сеансы незачем.
 */

/** Коды ошибок, которые означают «на том конце уже никого нет». */
const NETWORK_NOISE = new Set([
  'EPIPE',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPROTO',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_STREAM_DESTROYED',
  'ERR_SOCKET_CLOSED',
]);

function codeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`;
  }
  return String(error);
}

let installed = false;

export function installProcessGuards(): void {
  if (installed) return;
  installed = true;

  process.on('uncaughtException', (error) => {
    const code = codeOf(error);
    if (NETWORK_NOISE.has(code)) {
      console.warn(`[Устойчивость] Оборвано соединение (${code}) — работаем дальше.`);
      return;
    }
    console.error('[Устойчивость] Необработанная ошибка, перезапускаемся:', describe(error));
    // Даём журналу дописаться и уходим — systemd поднимет службу заново.
    setTimeout(() => process.exit(1), 100).unref();
  });

  process.on('unhandledRejection', (reason) => {
    const code = codeOf(reason);
    if (NETWORK_NOISE.has(code)) {
      console.warn(`[Устойчивость] Оборвано соединение в промисе (${code}) — работаем дальше.`);
      return;
    }
    console.error('[Устойчивость] Необработанный отказ промиса:', describe(reason));
  });
}

/**
 * Ожидание свежей догрузки хвоста после реконнекта перед вердиктом
 * «ответ не получен» (ChatInterface, 06.10.26).
 *
 * Почему не просто пауза: грейс 8 с (RECONNECT_GRACE_MS) короче срока одного
 * запроса хвоста (LATEST_TAIL_REQUEST_TIMEOUT_MS = 10 с). На проснувшемся
 * iPhone первый запрос висит в мёртвом соединении до таймаута — приговор по
 * устаревшей ленте объявлял потерю под готовым ответом, и по совету «отправьте
 * ещё раз» уходил дубль. Здесь судим только после того, как догрузка реально
 * применилась (fetchedAt ≥ момента реконнекта) или вышел потолок ожидания.
 */
export const VERDICT_MAX_WAIT_MS = 30_000;
export const VERDICT_RECHECK_MS = 400;

export type ReconnectVerdictReadiness =
  | 'fresh-tail'      // хвост перечитан после реконнекта — можно судить
  | 'disarmed'        // ожидание снято извне (ответ продолжился и т.п.)
  | 'processing'      // ход живёт — никакой потери
  | 'disconnected'    // связь снова оборвалась — судит следующий реконнект
  | 'no-session'      // сессии нет — судить нечего
  | 'deadline';       // хвост так и не доехал за потолок — судим по тому, что есть

export async function waitForFreshTailAfterReconnect(opts: {
  /** id чата на момент проверки. */
  sessionId: () => string | null;
  /** идёт ли сейчас работа (сервер подтвердил через подписку/события). */
  isProcessing: () => boolean;
  /** сокет жив ли сейчас. */
  isConnected: () => boolean;
  /** ожидание всё ещё в силе (false — внешний код уже решил). */
  stillArmed: () => boolean;
  /** время последней ПРИМЕНЁННОЙ догрузки хвоста (slot.fetchedAt), 0 если не было. */
  getFetchedAt: (sessionId: string) => number;
  /** просит сервер перечитать хвост; резолвится после текущей попытки. */
  requestLatest: (sessionId: string) => Promise<unknown>;
  /** момент, когда сокет переподключился. */
  reconnectedAt: number;
  deadlineMs?: number;
  recheckMs?: number;
  /** для тестов — подменяемое ожидание. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<ReconnectVerdictReadiness> {
  const deadline = Date.now() + (opts.deadlineMs ?? VERDICT_MAX_WAIT_MS);
  const recheckMs = opts.recheckMs ?? VERDICT_RECHECK_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  while (Date.now() < deadline) {
    if (!opts.stillArmed()) return 'disarmed';
    if (opts.isProcessing()) return 'processing';
    if (!opts.isConnected()) return 'disconnected';
    const sid = opts.sessionId();
    if (!sid) return 'no-session';
    if (opts.getFetchedAt(sid) >= opts.reconnectedAt) return 'fresh-tail';
    try {
      await opts.requestLatest(sid);
    } catch {
      // сеть совсем не едет — следующий круг решит по сроку
    }
    await sleep(recheckMs);
  }

  if (!opts.stillArmed()) return 'disarmed';
  if (opts.isProcessing()) return 'processing';
  if (!opts.isConnected()) return 'disconnected';
  return 'deadline';
}

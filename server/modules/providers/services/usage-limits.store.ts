/**
 * Живые лимиты подписки, снятые с потока ответа.
 *
 * CLI присылает событие `rate_limit_event` в каждом ответе — там текущая
 * загрузка окон (пятичасового, недельного, модельного). Мы его и запоминаем:
 * так значения обновляются сами, при каждом сообщении, и ни одного лишнего
 * запроса к API не делается. Отдельный «освежающий» прогон по таймеру был бы
 * хуже: он расходует ровно ту квоту, которую показывает.
 *
 * Хранится в памяти процесса, по каталогу настроек — то есть по аккаунту
 * Клода. Терять эти значения при перезапуске не страшно: файл ~/.claude.json
 * остаётся запасным источником, а первое же сообщение снова наполнит память.
 */
type LiveWindow = {
  utilization: number;
  resetsAt: number | null;
};

type LiveLimits = {
  capturedAtMs: number;
  windows: Record<string, LiveWindow>;
};

const byAccountDir = new Map<string, LiveLimits>();

function readWindow(value: unknown): LiveWindow | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const { utilization, resetsAt } = value as { utilization?: unknown; resetsAt?: unknown };
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) {
    return null;
  }
  return {
    utilization,
    resetsAt: typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? resetsAt : null,
  };
}

/**
 * Запоминает событие лимитов из потока.
 *
 * Форма события у CLI шире, чем описано в типах SDK: кроме плоских полей он
 * присылает `unifiedWindows` со всеми окнами разом. Читаем оба варианта —
 * типы отстают от бинаря, и полагаться только на них нельзя.
 */
export function recordRateLimitEvent(accountDir: string, info: unknown): void {
  if (!accountDir || !info || typeof info !== 'object') {
    return;
  }

  const raw = info as {
    utilization?: unknown;
    resetsAt?: unknown;
    rateLimitType?: unknown;
    unifiedWindows?: Record<string, unknown>;
  };

  const windows: Record<string, LiveWindow> = {};

  if (raw.unifiedWindows && typeof raw.unifiedWindows === 'object') {
    for (const [name, value] of Object.entries(raw.unifiedWindows)) {
      const parsed = readWindow(value);
      if (parsed) {
        windows[name] = parsed;
      }
    }
  }

  // Запасной разбор для плоской формы, описанной в типах SDK.
  if (Object.keys(windows).length === 0 && typeof raw.rateLimitType === 'string') {
    const parsed = readWindow(raw);
    if (parsed) {
      windows[raw.rateLimitType] = parsed;
    }
  }

  if (Object.keys(windows).length === 0) {
    return;
  }

  byAccountDir.set(accountDir, { capturedAtMs: Date.now(), windows });
}

/** Последние снятые с потока лимиты этого аккаунта, если они были. */
export function getLiveLimits(accountDir: string): LiveLimits | null {
  return byAccountDir.get(accountDir) ?? null;
}

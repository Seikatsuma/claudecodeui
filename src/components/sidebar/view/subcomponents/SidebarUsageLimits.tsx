import { ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../../utils/api';
import { cn } from '../../../../lib/utils';

type UsageLimit = {
  kind: string;
  percent: number;
  severity: string;
  resetsAt: string | null;
  modelName: string | null;
  expired: boolean;
};

type UsageLimitsPayload = {
  fetchedAtMs: number | null;
  limits: UsageLimit[];
};

/** Перечитывать чаще незачем: значения обновляет сам CLI, не мы. */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** Позже этого возраста кэш считается несвежим и это подписывается. */
const STALE_AFTER_MS = 30 * 60 * 1000;

function formatResetsIn(resetsAt: string | null): string | null {
  if (!resetsAt) {
    return null;
  }
  const left = Date.parse(resetsAt) - Date.now();
  if (!Number.isFinite(left) || left <= 0) {
    return null;
  }
  const minutes = Math.round(left / 60000);
  if (minutes < 60) {
    return `${minutes} мин`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} ч`;
  }
  return `${Math.round(hours / 24)} дн`;
}

/**
 * Расход подписки тремя полосами — как в панели Клода для VS Code: окно на
 * пять часов, недельное окно и лимит конкретной модели.
 *
 * Значения готовит сам CLI и складывает в ~/.claude.json, поэтому показ ничего
 * не стоит: своего запроса к API нет, а он расходовал бы ровно ту квоту,
 * которую показывает. Обратная сторона — данные могут отстать, поэтому возраст
 * подписывается честно, а окно, которое уже сбросилось, не показывается вовсе:
 * лучше ничего, чем неверное число.
 */
export default function SidebarUsageLimits() {
  const { t } = useTranslation('sidebar');
  const [payload, setPayload] = useState<UsageLimitsPayload | null>(null);
  const [isOpen, setIsOpen] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await api.user.usageLimits();
      if (!response.ok) {
        return;
      }
      setPayload((await response.json()) as UsageLimitsPayload);
    } catch {
      // Расход — справочная величина: молчаливый пропуск лучше, чем ошибка
      // на весь экран из-за неё.
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  // Показываем только два окна: пятичасовое и недельное.
  //
  // Лимит конкретной модели Егору не нужен — «лимиты fable не нужно
  // показывать, а вот 7 дней и 5 часов нужны». Сервер продолжает отдавать все
  // окна: отбор — дело показа, а не источника данных.
  const VISIBLE_KINDS = ['session', 'weekly_all'];
  const rows = (payload?.limits ?? []).filter(
    (limit) => !limit.expired && VISIBLE_KINDS.includes(limit.kind),
  );
  if (rows.length === 0) {
    return null;
  }

  const isStale = payload?.fetchedAtMs
    ? Date.now() - payload.fetchedAtMs > STALE_AFTER_MS
    : false;

  const labelFor = (limit: UsageLimit): string => {
    if (limit.kind === 'session') {
      return t('usage.session', { defaultValue: 'Сеанс (5 ч)' });
    }
    if (limit.kind === 'weekly_all') {
      return t('usage.weekly', { defaultValue: 'Неделя (7 дней)' });
    }
    return t('usage.other', { defaultValue: 'Прочий лимит' });
  };

  return (
    <div className="flex-shrink-0 border-b border-border/60 px-3 py-2">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        className="flex w-full items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronDown className={cn('h-3 w-3 transition-transform', !isOpen && '-rotate-90')} />
        {t('usage.title', { defaultValue: 'Расход' })}
        {isStale && (
          <span className="ml-auto font-normal normal-case text-muted-foreground/70">
            {t('usage.stale', { defaultValue: 'данные не свежие' })}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="mt-2 space-y-2">
          {rows.map((limit) => {
            const resetsIn = formatResetsIn(limit.resetsAt);
            return (
              <div key={`${limit.kind}-${limit.modelName ?? ''}`}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-foreground">
                    {labelFor(limit)}
                  </span>
                  <span className="flex-shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {limit.percent}%
                  </span>
                </div>
                <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full rounded-full transition-[width]',
                      limit.severity === 'critical'
                        ? 'bg-destructive'
                        : limit.severity === 'warning'
                          ? 'bg-amber-500'
                          : 'bg-primary',
                    )}
                    style={{ width: `${limit.percent}%` }}
                  />
                </div>
                {resetsIn && (
                  <p className="mt-0.5 text-[10px] text-muted-foreground/80">
                    {t('usage.resetsIn', { defaultValue: 'Обновится через {{time}}', time: resetsIn })}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

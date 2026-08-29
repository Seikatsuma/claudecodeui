import { useTranslation } from 'react-i18next';

import type { WeeklyUsageSnapshot } from '../../hooks/useWeeklyUsage';

type WeeklyUsageIndicatorProps = {
  snapshot: WeeklyUsageSnapshot | null;
  isLoading: boolean;
};

const RING_SIZE = 22;
const RING_STROKE = 2.5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const formatTokenCount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  }
  return String(Math.round(value));
};

// Same normal/warning/critical bands the account's own usage banners use
// elsewhere in the app, applied to the ring color so a glance is enough.
const ringColorClass = (percent: number) => {
  if (percent >= 90) return 'text-destructive';
  if (percent >= 70) return 'text-amber-500 dark:text-amber-400';
  return 'text-primary';
};

const formatDateTime = (iso: string | null, locale: string) => {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
};

/**
 * Always-visible weekly usage indicator for the composer toolbar. Prefers
 * the Claude CLI's own cached weekly-limit percent (see
 * `claude-weekly-usage.service.ts`); when that isn't available yet it falls
 * back to showing the local 7-day token estimate as a plain count instead of
 * a percent, since there is no reliable local way to weigh that estimate
 * against the real, spend-based weekly cap.
 */
export default function WeeklyUsageIndicator({ snapshot, isLoading }: WeeklyUsageIndicatorProps) {
  const { t, i18n } = useTranslation('chat');

  if (isLoading && !snapshot) {
    return null;
  }

  const official = snapshot?.official ?? null;
  const estimate = snapshot?.estimate ?? null;

  if (!official && !estimate) {
    return null;
  }

  const percent = official ? Math.max(0, Math.min(100, Math.round(official.percent))) : null;
  const dashOffset = percent === null
    ? RING_CIRCUMFERENCE
    : RING_CIRCUMFERENCE * (1 - percent / 100);

  const tooltipLines: string[] = [];
  if (official) {
    tooltipLines.push(t('weeklyUsage.official', { percent: Math.round(official.percent) }));
    const updatedAt = formatDateTime(official.fetchedAt, i18n.language);
    if (updatedAt) {
      tooltipLines.push(t('weeklyUsage.updatedAt', { date: updatedAt }));
    }
    const resetsAt = formatDateTime(official.resetsAt, i18n.language);
    if (resetsAt) {
      tooltipLines.push(t('weeklyUsage.resetsAt', { date: resetsAt }));
    }
  } else {
    tooltipLines.push(t('weeklyUsage.unavailable'));
  }
  if (estimate) {
    tooltipLines.push('');
    tooltipLines.push(t('weeklyUsage.estimateHeading'));
    tooltipLines.push(t('weeklyUsage.estimateTokens', { tokens: formatTokenCount(estimate.totalTokens) }));
    tooltipLines.push(t('weeklyUsage.estimateNote'));
  }
  const tooltip = tooltipLines.join('\n');

  const badgeLabel = percent !== null
    ? `${percent}%`
    : estimate
      ? formatTokenCount(estimate.totalTokens)
      : null;

  return (
    <button
      type="button"
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      title={tooltip}
      aria-label={percent !== null ? t('weeklyUsage.ariaLabel', { percent }) : t('weeklyUsage.estimateHeading')}
    >
      <span
        className={`relative grid h-5 w-5 flex-shrink-0 place-items-center ${percent !== null ? ringColorClass(percent) : 'text-muted-foreground'}`}
      >
        <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} className="-rotate-90">
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={RING_STROKE}
            className="stroke-muted-foreground/20"
          />
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            stroke="currentColor"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
          />
        </svg>
      </span>
      {badgeLabel && <span className="font-medium text-foreground">{badgeLabel}</span>}
    </button>
  );
}

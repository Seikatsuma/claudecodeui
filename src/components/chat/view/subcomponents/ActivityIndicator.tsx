import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Shimmer } from '../../../../shared/view/ui';
import type { SessionActivity } from '../../../../hooks/useSessionProtection';

type ActivityIndicatorProps = {
  activity: SessionActivity | null;
  onAbort?: () => void;
  isInputFocused?: boolean;
};

const EXIT_ANIMATION_MS = 220;

/**
 * Подписи фаз. Каждая соответствует событию, которое действительно пришло по
 * потоку (см. ActivityPhase в useSessionProtection), поэтому по индикатору
 * можно судить о происходящем, а не гадать.
 *
 * Прежняя версия перебирала шесть выдуманных слов по таймеру каждые 4
 * секунды. Выглядело живо, но означало ровно ничего: «Analyzing…» появлялось
 * и когда модель рассуждала, и когда запрос молча завис.
 */
const PHASE_LABELS: Record<string, { key: string; fallback: string }> = {
  thinking: { key: 'claudeStatus.phase.thinking', fallback: 'Думает' },
  writing: { key: 'claudeStatus.phase.writing', fallback: 'Пишет ответ' },
  tool: { key: 'claudeStatus.phase.tool', fallback: 'Работает' },
  agents: { key: 'claudeStatus.phase.agents', fallback: 'Работают агенты' },
  waiting: { key: 'claudeStatus.phase.waiting', fallback: 'Ожидает модель' },
};

/**
 * Minimal response-in-progress indicator, in the spirit of the inline status
 * lines in Claude Code / Codex / OpenCode: a shimmering activity label, the
 * elapsed time, and an interrupt affordance. Rendered only while the viewed
 * session has an entry in the processing map; it disappears the instant that
 * entry is removed.
 */
export default function ActivityIndicator({ activity, onAbort, isInputFocused = false }: ActivityIndicatorProps) {
  const { t } = useTranslation('chat');
  const [renderedActivity, setRenderedActivity] = useState<SessionActivity | null>(activity);
  const [isExiting, setIsExiting] = useState(false);
  const startedAt = renderedActivity?.startedAt ?? null;
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (activity) {
      setRenderedActivity(activity);
      setIsExiting(false);
      return;
    }

    if (!renderedActivity) return;

    setIsExiting(true);
    const timer = setTimeout(() => {
      setRenderedActivity(null);
      setIsExiting(false);
    }, EXIT_ANIMATION_MS);

    return () => clearTimeout(timer);
  }, [activity, renderedActivity]);

  useEffect(() => {
    if (startedAt === null) return;
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (!renderedActivity) return null;

  // Приоритет: строка статуса от провайдера → живая фаза потока → честное
  // «ожидает», пока не пришло ни одного события. Ничего не выдумывается.
  const phase = renderedActivity.phase;
  const detail = renderedActivity.detail;
  let phaseLabel: string;
  if (phase === 'tool' && detail) {
    phaseLabel = t('claudeStatus.phase.toolNamed', { tool: detail, defaultValue: `Работает: ${detail}` });
  } else if (phase === 'agents' && detail) {
    phaseLabel = t('claudeStatus.phase.agentsCount', {
      count: Number(detail) || 1,
      defaultValue: `Работают агенты: ${detail}`,
    });
  } else {
    const entry = PHASE_LABELS[phase ?? 'waiting'] ?? PHASE_LABELS.waiting;
    phaseLabel = t(entry.key, { defaultValue: entry.fallback });
  }
  const label = (renderedActivity.statusText || phaseLabel).replace(/\.+$/, '');

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const elapsedLabel = minutes < 1
    ? t('claudeStatus.elapsed.seconds', { count: seconds, defaultValue: '{{count}}s' })
    : t('claudeStatus.elapsed.minutesSeconds', { minutes, seconds, defaultValue: '{{minutes}}m {{seconds}}s' });
  const tabSurfaceClassName = [
    'chat-activity-tab inline-flex h-8 items-center rounded-b-none rounded-t-lg border border-b-0 bg-card px-3 text-xs transition-all duration-200',
    isInputFocused
      ? 'border-primary/30 shadow-[0_-1px_2px_hsl(var(--foreground)/0.08),1px_0_2px_hsl(var(--foreground)/0.06),-1px_0_2px_hsl(var(--foreground)/0.06)]'
      : 'border-border/50 shadow-[0_-1px_1px_hsl(var(--foreground)/0.04),1px_0_1px_hsl(var(--foreground)/0.03),-1px_0_1px_hsl(var(--foreground)/0.03)]',
  ].join(' ');

  return (
    <div
      className={`pointer-events-none bg-transparent ${
        isExiting ? 'chat-activity-exit' : 'chat-activity-enter'
      }`}
    >
      <div className="flex items-end justify-between gap-2">
        <div className={`${tabSurfaceClassName} gap-2`}>
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
          <Shimmer className="font-medium">{`${label}…`}</Shimmer>
          <span className="tabular-nums text-muted-foreground/60">{elapsedLabel}</span>
        </div>

        {renderedActivity.canInterrupt && onAbort && (
          <button
            type="button"
            onClick={onAbort}
            className={`${tabSurfaceClassName} pointer-events-auto gap-1.5 text-muted-foreground hover:bg-card hover:text-destructive`}
            aria-label={t('claudeStatus.stop', { defaultValue: 'Stop' })}
          >
            <svg className="h-2.5 w-2.5 fill-current" viewBox="0 0 24 24" aria-hidden>
              <rect x="5" y="5" width="14" height="14" rx="2" />
            </svg>
            <span>{t('claudeStatus.stop', { defaultValue: 'Stop' })}</span>
            <kbd className="hidden rounded border border-border/60 px-1 text-[10px] text-muted-foreground/70 sm:inline-block">
              esc
            </kbd>
          </button>
        )}
      </div>
    </div>
  );
}

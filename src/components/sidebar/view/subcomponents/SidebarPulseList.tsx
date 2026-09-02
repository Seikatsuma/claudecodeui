import { useMemo } from 'react';
import { Activity, Loader2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Tooltip } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import type { SessionActivityMap } from '../../../../hooks/useSessionProtection';
import type { Project, ProjectSession } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';
import { getSessionDate, formatCompactAge } from '../../utils/utils';
import { getSessionTitle } from '../../../../utils/pageTitle';
import LLMProviderLogo from '../../../llm-provider-logo/LLMProviderLogo';

type PulseRow = {
  project: Project;
  session: SessionWithProvider;
  isProcessing: boolean;
  needsAttention: boolean;
};

type SidebarPulseListProps = {
  projects: Project[];
  getProjectSessions: (project: Project) => SessionWithProvider[];
  activeSessions: SessionActivityMap;
  attentionSessionIds: ReadonlySet<string>;
  selectedSession: ProjectSession | null;
  currentTime: Date;
  searchFilter: string;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectId: string) => void;
  t: TFunction;
};

/**
 * "Pulse" — a flat, cross-project list of sessions that are currently
 * running/busy (actively processing a request) or waiting on the user
 * (needs-attention). Built directly from the same `activeSessions` /
 * `attentionSessionIds` inputs that already drive the green/amber status dot
 * on each session row elsewhere in the sidebar (see SidebarSessionItem), so
 * "shows up in Pulse" and "has a status dot" never disagree.
 *
 * Deliberately flat (not grouped by project like the regular project list) —
 * the whole point is a single across-all-projects glance at what's active
 * right now, so each row carries its own project name instead of relying on
 * a section header.
 */
export default function SidebarPulseList({
  projects,
  getProjectSessions,
  activeSessions,
  attentionSessionIds,
  selectedSession,
  currentTime,
  searchFilter,
  onProjectSelect,
  onSessionSelect,
  t,
}: SidebarPulseListProps) {
  const allRows = useMemo(() => {
    const rows: PulseRow[] = [];

    for (const project of projects) {
      for (const session of getProjectSessions(project)) {
        const isProcessing = activeSessions.has(session.id);
        const needsAttention = attentionSessionIds.has(session.id);
        if (!isProcessing && !needsAttention) {
          continue;
        }
        rows.push({ project, session, isProcessing, needsAttention });
      }
    }

    // Busy sessions first (they're the ones actively doing work), then most
    // recently active within each group.
    rows.sort((a, b) => {
      if (a.isProcessing !== b.isProcessing) {
        return a.isProcessing ? -1 : 1;
      }
      return getSessionDate(b.session).getTime() - getSessionDate(a.session).getTime();
    });

    return rows;
  }, [projects, getProjectSessions, activeSessions, attentionSessionIds]);

  const normalizedSearch = searchFilter.trim().toLowerCase();
  const visibleRows = normalizedSearch
    ? allRows.filter((row) => {
        const title = getSessionTitle(row.session).toLowerCase();
        const projectName = (row.project.displayName || row.project.projectId).toLowerCase();
        return title.includes(normalizedSearch) || projectName.includes(normalizedSearch);
      })
    : allRows;

  if (allRows.length === 0) {
    return (
      <div className="px-4 py-12 text-center md:py-8">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-border/70 bg-muted/50 md:mb-3">
          <Activity className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">
          {t('pulse.emptyTitle', { defaultValue: 'No active sessions right now' })}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t('pulse.emptyDescription', {
            defaultValue: 'Sessions that are running or waiting on you will show up here.',
          })}
        </p>
      </div>
    );
  }

  if (visibleRows.length === 0) {
    return (
      <div className="px-4 py-12 text-center md:py-8">
        <p className="text-sm text-muted-foreground">
          {t('pulse.noMatchingSessions', { defaultValue: 'No active sessions match this search.' })}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 px-2 pb-3">
      <div className="mx-1 flex items-center justify-between rounded-lg border border-border/60 bg-card/50 px-3 py-2 shadow-sm">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <Activity className="h-3.5 w-3.5" />
          </span>
          <span className="truncate text-xs font-normal text-foreground">
            {t('pulse.title', { defaultValue: 'Active now' })}
          </span>
        </div>
        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-normal text-emerald-700 dark:text-emerald-300">
          {allRows.length}
        </span>
      </div>

      <div className="space-y-1">
        {visibleRows.map(({ project, session, isProcessing, needsAttention }) => {
          const isSelected = selectedSession?.id === session.id;
          const title = getSessionTitle(session);
          const age = formatCompactAge(session.lastActivity, currentTime);

          return (
            <button
              key={session.id}
              type="button"
              onClick={() => {
                onProjectSelect(project);
                onSessionSelect(session, project.projectId);
              }}
              className={cn(
                'group flex w-full min-w-0 items-center gap-2 rounded-lg border px-2 py-2 text-left transition-colors',
                isSelected
                  ? 'border-primary/20 bg-primary/5'
                  : needsAttention
                    ? 'border-amber-500/30 bg-amber-50/5 hover:bg-amber-50/10 dark:bg-amber-900/5 dark:hover:bg-amber-900/10'
                    : 'border-border/30 hover:bg-accent/50',
              )}
            >
              <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-muted/60">
                <LLMProviderLogo provider={session.__provider} className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-normal leading-4 text-foreground" title={title}>
                    {title}
                  </span>
                  {isProcessing ? (
                    <Tooltip content={t('tooltips.processingSessionIndicator', { defaultValue: 'Processing session' })} position="top">
                      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                      </span>
                    </Tooltip>
                  ) : (
                    <Tooltip content={t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })} position="top">
                      <span
                        role="status"
                        aria-label={t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })}
                        className="h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-amber-500"
                      />
                    </Tooltip>
                  )}
                </span>
                <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] leading-3 text-muted-foreground">
                  <span className="truncate">{project.displayName}</span>
                  {age && (
                    <>
                      <span className="flex-shrink-0 text-muted-foreground/40">·</span>
                      <span className="flex-shrink-0 tabular-nums">{age}</span>
                    </>
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

import { useMemo } from 'react';
import { Clock, Folder, MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { MainContentStateViewProps } from '../../types/types';
import type { Project } from '../../../../types/app';
import type { SessionWithProvider } from '../../../sidebar/types/types';
import { formatCompactAge, getAllSessions, getProjectLastActivity, getSessionDate, getSessionName } from '../../../sidebar/utils/utils';

import MobileMenuButton from './MobileMenuButton';

const MAX_RECENT_PROJECTS = 6;

type RecentSessionHit = {
  project: Project;
  session: SessionWithProvider;
};

export default function MainContentStateView({ mode, isMobile, onMenuClick, projects, onProjectSelect, onSessionSelect }: MainContentStateViewProps) {
  const { t } = useTranslation();
  const currentTime = useMemo(() => new Date(), []);

  const isLoading = mode === 'loading';

  const recentProjects = useMemo(() => {
    const activeProjects = projects.filter((project) => getAllSessions(project).length > 0);
    const source = activeProjects.length > 0 ? activeProjects : projects;

    return [...source]
      .sort((a, b) => getProjectLastActivity(b).getTime() - getProjectLastActivity(a).getTime())
      .slice(0, MAX_RECENT_PROJECTS);
  }, [projects]);

  const lastSessionHit = useMemo<RecentSessionHit | null>(() => {
    let best: RecentSessionHit | null = null;

    for (const project of projects) {
      const [topSession] = getAllSessions(project);
      if (!topSession) {
        continue;
      }

      if (!best || getSessionDate(topSession) > getSessionDate(best.session)) {
        best = { project, session: topSession };
      }
    }

    return best;
  }, [projects]);

  const handleContinueLastChat = () => {
    if (!lastSessionHit) {
      return;
    }

    onProjectSelect(lastSessionHit.project);
    onSessionSelect({ ...lastSessionHit.session, __projectId: lastSessionHit.project.projectId });
  };

  return (
    <div className="flex h-full flex-col">
      {isMobile && (
        <div className="pwa-header-safe flex-shrink-0 border-b border-border/50 bg-background/80 p-2 backdrop-blur-sm sm:p-3">
          <MobileMenuButton onMenuClick={onMenuClick} compact />
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center text-muted-foreground">
            <div className="mx-auto mb-4 h-10 w-10">
              <div
                className="h-full w-full rounded-full border-[3px] border-muted border-t-primary"
                style={{
                  animation: 'spin 1s linear infinite',
                  WebkitAnimation: 'spin 1s linear infinite',
                  MozAnimation: 'spin 1s linear infinite',
                }}
              />
            </div>
            <h2 className="mb-1 text-lg font-semibold text-foreground">{t('mainContent.loading')}</h2>
            <p className="text-sm">{t('mainContent.settingUpWorkspace')}</p>
          </div>
        </div>
      ) : recentProjects.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="mx-auto max-w-md px-6 text-center">
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/50">
              <Folder className="h-7 w-7 text-muted-foreground" />
            </div>
            <h2 className="mb-2 text-xl font-semibold text-foreground">{t('mainContent.chooseProject')}</h2>
            <p className="mb-5 text-sm leading-relaxed text-muted-foreground">{t('mainContent.selectProjectDescription')}</p>
            <div className="rounded-xl border border-primary/10 bg-primary/5 p-3.5">
              <p className="text-sm text-primary">
                <strong>{t('mainContent.tip')}:</strong> {isMobile ? t('mainContent.createProjectMobile') : t('mainContent.createProjectDesktop')}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-6 py-10 sm:py-14">
            <div className="mb-6 text-center sm:mb-8">
              <h2 className="mb-1.5 text-xl font-semibold text-foreground">{t('mainContent.welcomeBackTitle')}</h2>
              <p className="text-sm text-muted-foreground">{t('mainContent.welcomeBackDescription')}</p>
            </div>

            {lastSessionHit && (
              <button
                type="button"
                onClick={handleContinueLastChat}
                className="group mb-6 flex w-full items-center gap-3 rounded-xl border border-primary/15 bg-primary/5 p-4 text-left transition-colors hover:border-primary/30 hover:bg-primary/10 sm:mb-8"
              >
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                  <MessageSquare className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-primary">{t('mainContent.continueLastChat')}</span>
                  </div>
                  <p className="truncate text-sm text-foreground/80">
                    {getSessionName(lastSessionHit.session, t)}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{lastSessionHit.project.displayName}</p>
                </div>
              </button>
            )}

            <div className="mb-3 flex items-center justify-between px-0.5">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('mainContent.recentProjects')}
              </h3>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {recentProjects.map((project) => {
                const sessionCount = Number(project.sessionMeta?.total ?? getAllSessions(project).length);
                const lastActivity = getProjectLastActivity(project);
                const age = lastActivity.getTime() > 0 ? formatCompactAge(lastActivity.toISOString(), currentTime) : '';

                return (
                  <button
                    key={project.projectId}
                    type="button"
                    onClick={() => onProjectSelect(project)}
                    className="group flex items-start gap-3 rounded-xl border border-border/60 bg-card p-4 text-left transition-colors hover:border-primary/30 hover:bg-accent/40"
                  >
                    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground transition-colors group-hover:text-foreground">
                      <Folder className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground" title={project.displayName}>
                        {project.displayName}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground" title={project.fullPath}>
                        {project.fullPath}
                      </p>
                      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground/80">
                        <span>{t('mainContent.sessionCount', { count: sessionCount })}</span>
                        {age && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="flex items-center gap-0.5">
                              <Clock className="h-3 w-3" />
                              {age}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

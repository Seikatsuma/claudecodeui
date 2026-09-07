import { type ReactNode, useState } from 'react';
import { Archive, Folder, MessageSquare, RotateCcw, Search, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ScrollArea } from '../../../../shared/view/ui';
import type { AppTab, Project, ProjectSession } from '../../../../types/app';
import type { ReleaseInfo } from '../../../../shared/types';
import type { ConversationSearchResults, SearchProgress } from '../../hooks/useSidebarController';
import type { ArchivedProjectListItem, ArchivedSessionListItem, RecentConversationListItem, SidebarSearchMode } from '../../types/types';
import LLMProviderLogo from '../../../llm-provider-logo/LLMProviderLogo';
import { formatCompactAge, getAllSessions } from '../../utils/utils';
import { getSessionTitle } from '../../../../utils/pageTitle';

import SidebarFooter from './SidebarFooter';
import SidebarHeader from './SidebarHeader';
import SidebarUsageLimits from './SidebarUsageLimits';
import SidebarProjectList, { type SidebarProjectListProps } from './SidebarProjectList';
import SidebarProjectPickerTrigger from './SidebarProjectPickerTrigger';
import SidebarProjectSessions from './SidebarProjectSessions';
import SidebarRecentConversations from './SidebarRecentConversations';
import SidebarWorkspaceTabs from './SidebarWorkspaceTabs';

function HighlightedSnippet({ snippet, highlights }: { snippet: string; highlights: { start: number; end: number }[] }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const h of highlights) {
    if (h.start > cursor) {
      parts.push(snippet.slice(cursor, h.start));
    }
    parts.push(
      <mark key={h.start} className="rounded-sm bg-yellow-200 px-0.5 text-foreground dark:bg-yellow-800">
        {snippet.slice(h.start, h.end)}
      </mark>
    );
    cursor = h.end;
  }
  if (cursor < snippet.length) {
    parts.push(snippet.slice(cursor));
  }
  return (
    <span className="min-w-0 flex-1 break-words text-xs leading-relaxed text-muted-foreground">
      {parts}
    </span>
  );
}

type ArchivedSessionGroup = {
  key: string;
  projectId: string | null;
  projectDisplayName: string;
  projectPath: string | null;
  isProjectArchived: boolean;
  sessions: ArchivedSessionListItem[];
  latestActivity: string | null;
};

/**
 * Groups archived sessions by project metadata so the archive view preserves
 * the same mental model as the active sidebar: projects first, then sessions.
 */
function groupArchivedSessionsByProject(sessions: ArchivedSessionListItem[]): ArchivedSessionGroup[] {
  const groups = new Map<string, ArchivedSessionGroup>();

  for (const session of sessions) {
    const key = session.projectId ?? session.projectPath ?? `session:${session.sessionId}`;
    const existingGroup = groups.get(key);

    if (existingGroup) {
      existingGroup.sessions.push(session);
      if (!existingGroup.latestActivity || (session.lastActivity && session.lastActivity > existingGroup.latestActivity)) {
        existingGroup.latestActivity = session.lastActivity;
      }
      continue;
    }

    groups.set(key, {
      key,
      projectId: session.projectId,
      projectDisplayName: session.projectDisplayName,
      projectPath: session.projectPath,
      isProjectArchived: session.isProjectArchived,
      sessions: [session],
      latestActivity: session.lastActivity,
    });
  }

  return [...groups.values()].sort((groupA, groupB) => {
    const a = groupA.latestActivity ?? '';
    const b = groupB.latestActivity ?? '';
    return b.localeCompare(a);
  });
}

type SidebarContentProps = {
  isPWA: boolean;
  isMobile: boolean;
  isLoading: boolean;
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
  pulseSessionsCount: number;
  archivedProjects: ArchivedProjectListItem[];
  archivedSessions: ArchivedSessionListItem[];
  archivedSessionsCount: number;
  isArchivedSessionsLoading: boolean;
  recentConversations: RecentConversationListItem[];
  recentConversationsTotal: number;
  recentConversationsHasMore: boolean;
  isRecentConversationsLoading: boolean;
  isLoadingMoreRecentConversations: boolean;
  recentConversationsError: boolean;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  conversationResults: ConversationSearchResults | null;
  isSearching: boolean;
  searchProgress: SearchProgress | null;
  onRestoreArchivedProject: (projectId: string) => void;
  onLoadMoreRecentConversations: () => void;
  onRetryRecentConversations: () => void;
  onArchivedSessionClick: (session: ArchivedSessionListItem) => void;
  onRestoreArchivedSession: (sessionId: string) => void;
  onDeleteArchivedSession: (session: ArchivedSessionListItem) => void;
  // Conversation result clicks pass back the DB projectId (or null when the
  // server couldn't resolve it). Consumers must handle the null case.
  onConversationResultClick: (projectId: string | null, sessionId: string, provider: string, messageTimestamp?: string | null, messageSnippet?: string | null) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onCollapseSidebar: () => void;
  updateAvailable: boolean;
  restartRequired: boolean;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  currentVersion: string;
  accountLabel: string | null;
  switchAccountUrl: string | null;
  accountEmail: string | null;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  projectListProps: SidebarProjectListProps;
  t: TFunction;
};

export default function SidebarContent({
  isPWA,
  isMobile,
  isLoading,
  projects,
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  shouldShowTasksTab,
  shouldShowBrowserTab,
  pulseSessionsCount,
  archivedProjects,
  archivedSessions,
  archivedSessionsCount,
  isArchivedSessionsLoading,
  recentConversations,
  recentConversationsTotal,
  recentConversationsHasMore,
  isRecentConversationsLoading,
  isLoadingMoreRecentConversations,
  recentConversationsError,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  searchMode,
  onSearchModeChange,
  conversationResults,
  isSearching,
  searchProgress,
  onRestoreArchivedProject,
  onLoadMoreRecentConversations,
  onRetryRecentConversations,
  onArchivedSessionClick,
  onRestoreArchivedSession,
  onDeleteArchivedSession,
  onConversationResultClick,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onCollapseSidebar,
  updateAvailable,
  restartRequired,
  releaseInfo,
  latestVersion,
  currentVersion,
  accountLabel,
  switchAccountUrl,
  accountEmail,
  onShowVersionModal,
  onShowSettings,
  projectListProps,
  t,
}: SidebarContentProps) {
  const hasSearchResults = Boolean(
    conversationResults
    && (conversationResults.titleResults.length > 0 || conversationResults.results.length > 0),
  );
  const groupedArchivedSessions = groupArchivedSessionsByProject(archivedSessions);
  const visibleArchivedItemsCount = archivedProjects.length + archivedSessions.length;
  const isRenamingOnMobile = isMobile && Boolean(
    projectListProps.editingProject || projectListProps.editingSession,
  );

  // Flat-mode: when exactly ONE project is starred, show its sessions directly
  // without the project-header/expand-step clutter.  0 or 2+ starred = normal mode.
  const starredProjects = projectListProps.projects.filter((p) =>
    projectListProps.isProjectStarred(p.projectId),
  );
  const singleStarredProject = starredProjects.length === 1 ? starredProjects[0] : null;


  // Which project to display in the flat session list (null = show starred project).
  // Picker sets this when user selects a different project from the overlay.
  const [pickerProject, setPickerProject] = useState<import('../../../../types/app').Project | null>(null);
  // The project whose sessions fill the flat view.
  const flatDisplayProject = singleStarredProject
    ? (pickerProject ?? singleStarredProject)
    : null;
  // Кнопка «все папки» переехала в полосу вкладок, на место убранной вкладки
  // Conversations. Собирается здесь, а не в шапке: ей нужен список проектов и
  // обработчик выбора, которые живут в этом компоненте.
  const projectPicker = singleStarredProject ? (
    <SidebarProjectPickerTrigger
      projects={projectListProps.projects}
      selectedProjectId={flatDisplayProject?.projectId ?? null}
      isProjectStarred={projectListProps.isProjectStarred}
      onProjectSelect={(project) => {
        if (project.projectId === singleStarredProject.projectId) {
          setPickerProject(null);
        } else {
          setPickerProject(project);
          projectListProps.onProjectSelect(project);
        }
      }}
      variant="tab"
      t={t}
    />
  ) : null;

  return (
    <div
      className="flex h-full flex-col bg-background/80 backdrop-blur-sm md:w-72 md:select-none"
      style={{}}
    >
      <SidebarHeader
        isPWA={isPWA}
        isMobile={isMobile}
        isLoading={isLoading}
        projectsCount={projects.length}
        pulseSessionsCount={pulseSessionsCount}
        archivedSessionsCount={archivedSessionsCount}
        isArchivedSessionsLoading={isArchivedSessionsLoading}
        searchFilter={searchFilter}
        onSearchFilterChange={onSearchFilterChange}
        onClearSearchFilter={onClearSearchFilter}
        projectPickerSlot={projectPicker}
        searchMode={searchMode}
        onSearchModeChange={onSearchModeChange}
        onRefresh={onRefresh}
        isRefreshing={isRefreshing}
        onCreateProject={onCreateProject}
        onCollapseSidebar={onCollapseSidebar}
        pulseProjects={projectListProps.projects}
        pulseGetProjectSessions={projectListProps.getProjectSessions}
        pulseActiveSessions={projectListProps.activeSessions}
        pulseAttentionSessionIds={projectListProps.attentionSessionIds}
        pulseSelectedSession={projectListProps.selectedSession}
        pulseCurrentTime={projectListProps.currentTime}
        onPulseProjectSelect={projectListProps.onProjectSelect}
        onPulseSessionSelect={projectListProps.onSessionSelect}
        t={t}
      />

      {(selectedProject || singleStarredProject) && (
        <div className="flex-shrink-0 border-b border-border/60 px-3 py-2">
          {selectedProject && (
            <div className="mb-1.5 min-w-0">
              <p
                className="truncate text-xs font-medium leading-tight text-foreground"
                title={selectedSession ? getSessionTitle(selectedSession) : selectedProject.displayName}
              >
                {selectedSession ? getSessionTitle(selectedSession) : selectedProject.displayName}
              </p>
              {selectedSession && (
                <p className="truncate text-[10px] leading-tight text-muted-foreground/70">
                  {selectedProject.displayName}
                </p>
              )}
            </div>
          )}
          <div className="flex items-center gap-1.5">
            {selectedProject && (
              <div className="flex-1">
                <SidebarWorkspaceTabs
                  activeTab={activeTab}
                  setActiveTab={setActiveTab}
                  shouldShowTasksTab={shouldShowTasksTab}
                  shouldShowBrowserTab={shouldShowBrowserTab}
                />
              </div>
            )}
          </div>
        </div>
      )}

      <SidebarUsageLimits />

      <ScrollArea className="flex-1 overflow-y-auto overscroll-contain md:px-1.5 md:py-2">
        {/*
          Ветки поиска по чатам и ленты бесед убраны вместе с режимом
          «conversations»: попасть в них было неоткуда после того, как
          вкладку заменили выбором папки.
        */}
        {searchMode === 'archived' ? (
          isArchivedSessionsLoading ? (
            <div className="space-y-2 px-2 py-1" aria-live="polite" aria-busy="true">
              <div className="flex items-center gap-2 px-1 py-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted/70">
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-muted-foreground/40 border-t-muted-foreground" />
                </div>
                <div>
                  <h3 className="text-xs font-medium text-foreground">
                    {t('archived.loadingTitle', 'Loading archive...')}
                  </h3>
                  <p className="text-[11px] text-muted-foreground">
                    {t('archived.loadingDescription', 'Fetching hidden workspaces and sessions you can restore later.')}
                  </p>
                </div>
              </div>
              {[0, 1].map((skeleton) => (
                <div key={skeleton} className="animate-pulse rounded-xl border border-border/50 bg-card/40 p-3">
                  <div className="flex items-center gap-2.5">
                    <div className="h-8 w-8 rounded-lg bg-muted" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="h-3 w-2/3 rounded bg-muted" />
                      <div className="h-2.5 w-5/6 rounded bg-muted/70" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : archivedProjects.length === 0 && groupedArchivedSessions.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <div className="mx-auto max-w-[240px] rounded-2xl border border-dashed border-border/80 bg-muted/20 px-5 py-7">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-border/70 bg-background shadow-sm">
                  <Archive className="h-[18px] w-[18px] text-muted-foreground" />
                </div>
                <h3 className="text-sm font-medium text-foreground">
                  {archivedSessionsCount > 0
                    ? t('archived.noMatchingSessions', 'No matching archived items')
                    : t('archived.emptyTitle', 'No archived items')}
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {archivedSessionsCount > 0
                    ? t('archived.tryDifferentSearch', 'Try a different search term.')
                    : t('archived.emptyDescription', 'Archived workspaces and sessions will appear here when you hide them from the active list.')}
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-2.5 px-2 pb-3">
              <div className="flex items-center justify-between px-1 pb-0.5 pt-0.5">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
                    <Archive className="h-3.5 w-3.5" />
                  </span>
                  <div>
                    <h2 className="text-xs font-medium leading-none text-foreground">
                      {t('archived.title', 'Archive')}
                    </h2>
                    <p className="mt-1 text-[10px] leading-none text-muted-foreground">
                      {t('archived.restoreHint', 'Restore items whenever you need them')}
                    </p>
                  </div>
                </div>
                <span
                  className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground"
                  title={visibleArchivedItemsCount !== archivedSessionsCount
                    ? `${visibleArchivedItemsCount} of ${archivedSessionsCount}`
                    : undefined}
                >
                  {visibleArchivedItemsCount !== archivedSessionsCount
                    ? `${visibleArchivedItemsCount}/${archivedSessionsCount}`
                    : archivedSessionsCount}
                </span>
              </div>
              {archivedProjects.map((project) => {
                const projectSessions = getAllSessions(project);

                return (
                  <section
                    key={project.projectId}
                    className="group/archive overflow-hidden rounded-xl border border-border/70 bg-card/45 shadow-[0_1px_0_hsl(var(--border)/0.2)] transition-colors hover:border-border"
                  >
                    <div className="flex items-center gap-2.5 px-2.5 py-2.5">
                      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/45 text-muted-foreground">
                        <Folder className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <h3 className="truncate text-[13px] font-medium text-foreground">
                            {project.displayName}
                          </h3>
                          {projectSessions.length > 0 && (
                            <span className="flex-shrink-0 rounded-md bg-muted/60 px-1.5 py-0.5 text-[9px] tabular-nums text-muted-foreground">
                              {projectSessions.length}
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70" title={project.fullPath}>
                          {project.fullPath}
                        </p>
                      </div>
                      <button
                        className="flex h-7 flex-shrink-0 items-center gap-1.5 rounded-lg border border-emerald-600/15 bg-emerald-500/10 px-2 text-[10px] font-medium text-emerald-700 transition-all hover:border-emerald-600/25 hover:bg-emerald-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 dark:text-emerald-300"
                        onClick={() => onRestoreArchivedProject(project.projectId)}
                        title={t('archived.restoreProject', 'Restore workspace')}
                        aria-label={`${t('archived.restoreProject', 'Restore workspace')}: ${project.displayName}`}
                      >
                        <RotateCcw className="h-3 w-3" />
                        {t('archived.restoreAction', 'Restore')}
                      </button>
                    </div>
                    {projectSessions.length > 0 && (
                      <div className="border-t border-border/45 bg-muted/[0.08]">
                        {projectSessions.map((session) => (
                          <button
                            key={String(session.id)}
                            className="flex w-full items-center gap-2.5 border-b border-border/35 px-2.5 py-2 text-left transition-colors last:border-b-0 hover:bg-accent/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                            onClick={() => onArchivedSessionClick({
                              sessionId: String(session.id),
                              provider: session.__provider,
                              projectId: project.projectId,
                              projectPath: project.fullPath,
                              projectDisplayName: project.displayName,
                              sessionTitle:
                                (typeof session.summary === 'string' && session.summary.trim().length > 0
                                  ? session.summary
                                  : typeof session.name === 'string' && session.name.trim().length > 0
                                    ? session.name
                                    : String(session.id)),
                              createdAt: typeof session.created_at === 'string' ? session.created_at : null,
                              updatedAt: typeof session.updated_at === 'string' ? session.updated_at : null,
                              lastActivity:
                                typeof session.lastActivity === 'string'
                                  ? session.lastActivity
                                  : typeof session.updated_at === 'string'
                                    ? session.updated_at
                                    : typeof session.created_at === 'string'
                                      ? session.created_at
                                      : null,
                              isProjectArchived: true,
                            })}
                          >
                            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-background/70">
                              <LLMProviderLogo provider={session.__provider} className="h-3.5 w-3.5" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs text-foreground">
                                {(typeof session.summary === 'string' && session.summary.trim().length > 0
                                  ? session.summary
                                  : typeof session.name === 'string' && session.name.trim().length > 0
                                    ? session.name
                                    : String(session.id))}
                              </p>
                              <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground/70">
                                <span className="uppercase tracking-wide">{session.__provider}</span>
                                <span aria-hidden>·</span>
                                <span className="tabular-nums">
                                  {formatCompactAge(
                                    typeof session.lastActivity === 'string'
                                      ? session.lastActivity
                                      : typeof session.updated_at === 'string'
                                        ? session.updated_at
                                        : typeof session.created_at === 'string'
                                          ? session.created_at
                                          : null,
                                    projectListProps.currentTime,
                                  )}
                                </span>
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
              {groupedArchivedSessions.map((group) => (
                <section
                  key={group.key}
                  className="group/archive overflow-hidden rounded-xl border border-border/70 bg-card/45 shadow-[0_1px_0_hsl(var(--border)/0.2)] transition-colors hover:border-border"
                >
                  <div className="flex items-center gap-2.5 px-2.5 py-2.5">
                    <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/45 text-muted-foreground">
                      <Folder className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <h3 className="truncate text-[13px] font-medium text-foreground">
                          {group.projectDisplayName}
                        </h3>
                        <span className="flex-shrink-0 rounded-md bg-muted/60 px-1.5 py-0.5 text-[9px] tabular-nums text-muted-foreground">
                          {group.sessions.length}
                        </span>
                      </div>
                      {group.projectPath && (
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70" title={group.projectPath}>
                          {group.projectPath}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="border-t border-border/45 bg-muted/[0.08]">
                    {group.sessions.map((session) => (
                      <div
                        key={session.sessionId}
                        className="group/session flex items-center gap-1 border-b border-border/35 px-2.5 py-2 last:border-b-0 hover:bg-accent/35"
                      >
                        <button
                          className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => onArchivedSessionClick(session)}
                        >
                          <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-background/70">
                            <LLMProviderLogo provider={session.provider} className="h-3.5 w-3.5" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs text-foreground">
                              {session.sessionTitle}
                            </p>
                            <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground/70">
                              <span className="uppercase tracking-wide">{session.provider}</span>
                              {session.lastActivity && (
                                <>
                                  <span aria-hidden>·</span>
                                  <span className="tabular-nums">
                                    {formatCompactAge(session.lastActivity, projectListProps.currentTime)}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                        </button>
                        <div className="flex flex-shrink-0 items-center gap-0.5">
                          <button
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-emerald-500/10 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 dark:hover:text-emerald-300"
                            onClick={() => onRestoreArchivedSession(session.sessionId)}
                            title={t('archived.restore', 'Restore session')}
                            aria-label={`${t('archived.restore', 'Restore session')}: ${session.sessionTitle}`}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                          <button
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40"
                            onClick={() => onDeleteArchivedSession(session)}
                            title={t('archived.deletePermanently', 'Delete permanently')}
                            aria-label={`${t('archived.deletePermanently', 'Delete permanently')}: ${session.sessionTitle}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )
        ) : flatDisplayProject ? (
          // Flat mode: exactly one starred project — render its sessions directly,
          // no project-name header needed for the primary (starred) project.
          <div className="pb-safe-area-inset-bottom md:space-y-1">
            {pickerProject && (
              // Non-default project selected from picker — show its name so the
              // user knows they're browsing a different project's sessions.
              <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
                <Folder className="h-3 w-3 flex-shrink-0" />
                <span className="min-w-0 flex-1 truncate">{pickerProject.displayName}</span>
                <button
                  type="button"
                  aria-label={t('projects.backToMain', { defaultValue: 'Back to main project' })}
                  title={t('projects.backToMain', { defaultValue: 'Back to main project' })}
                  className="flex-shrink-0 rounded p-0.5 transition-colors hover:bg-accent/60 hover:text-foreground"
                  onClick={() => setPickerProject(null)}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
            <SidebarProjectSessions
              project={flatDisplayProject}
              isExpanded={true}
              sessions={projectListProps.getProjectSessions(flatDisplayProject)}
              selectedSession={projectListProps.selectedSession}
              initialSessionsLoaded={projectListProps.initialSessionsLoaded.has(flatDisplayProject.projectId)}
              hasMoreSessions={Boolean(flatDisplayProject.sessionMeta?.hasMore)}
              isLoadingMoreSessions={projectListProps.loadingMoreProjects.has(flatDisplayProject.projectId)}
              activeSessions={projectListProps.activeSessions}
              attentionSessionIds={projectListProps.attentionSessionIds}
              currentTime={projectListProps.currentTime}
              editingSession={projectListProps.editingSession}
              editingSessionName={projectListProps.editingSessionName}
              onEditingSessionNameChange={projectListProps.onEditingSessionNameChange}
              onStartEditingSession={projectListProps.onStartEditingSession}
              onCancelEditingSession={projectListProps.onCancelEditingSession}
              onSaveEditingSession={projectListProps.onSaveEditingSession}
              onProjectSelect={projectListProps.onProjectSelect}
              onSessionSelect={projectListProps.onSessionSelect}
              onDeleteSession={projectListProps.onDeleteSession}
              onLoadMoreSessions={projectListProps.onLoadMoreSessions}
              onNewSession={projectListProps.onNewSession}
              t={t}
            />
          </div>
        ) : (
          <SidebarProjectList {...projectListProps} />
        )}
      </ScrollArea>

      {!isRenamingOnMobile && (
        <SidebarFooter
          updateAvailable={updateAvailable}
          restartRequired={restartRequired}
          releaseInfo={releaseInfo}
          latestVersion={latestVersion}
          currentVersion={currentVersion}
          accountLabel={accountLabel}
          switchAccountUrl={switchAccountUrl}
          accountEmail={accountEmail}
          onShowVersionModal={onShowVersionModal}
          onShowSettings={onShowSettings}
          t={t}
        />
      )}
    </div>
  );
}

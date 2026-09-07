import { Archive, Folder, FolderPlus, Plus, RefreshCw, Search, X, PanelLeftClose } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button, Input, Tooltip } from '../../../../shared/view/ui';
import { CLOUDCLI_WORDMARK_FONT_FAMILY } from '../../../../shared/constants';
import { IS_PLATFORM } from '../../../../shared/utils';
import { cn } from '../../../../lib/utils';
import type { SessionActivityMap } from '../../../../hooks/useSessionProtection';
import type { Project, ProjectSession } from '../../../../types/app';
import type { ReactNode } from 'react';
import type { SessionWithProvider, SidebarSearchMode } from '../../types/types';

import SidebarPulseTrigger from './SidebarPulseTrigger';

const MOD_KEY =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

type SidebarHeaderProps = {
  isPWA: boolean;
  isMobile: boolean;
  isLoading: boolean;
  projectsCount: number;
  pulseSessionsCount: number;
  archivedSessionsCount: number;
  isArchivedSessionsLoading: boolean;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SidebarSearchMode;
  /**
   * Кнопка «все папки», занявшая место убранной вкладки Conversations.
   * Приходит слотом, а не собирается здесь: ей нужен список проектов и
   * обработчик выбора, которые живут в SidebarContent, — тянуть их через
   * шапку значило бы протащить пяток пропсов ради одной кнопки.
   */
  projectPickerSlot?: ReactNode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onCollapseSidebar: () => void;
  // Data for the always-visible Pulse trigger/overlay — same inputs
  // SidebarPulseList already consumes elsewhere in the sidebar.
  pulseProjects: Project[];
  pulseGetProjectSessions: (project: Project) => SessionWithProvider[];
  pulseActiveSessions: SessionActivityMap;
  pulseAttentionSessionIds: ReadonlySet<string>;
  pulseSelectedSession: ProjectSession | null;
  pulseCurrentTime: Date;
  onPulseProjectSelect: (project: Project) => void;
  onPulseSessionSelect: (session: SessionWithProvider, projectId: string) => void;
  t: TFunction;
};

export default function SidebarHeader({
  isPWA,
  isMobile,
  isLoading,
  projectsCount,
  pulseSessionsCount,
  archivedSessionsCount,
  isArchivedSessionsLoading,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  searchMode,
  projectPickerSlot,
  onSearchModeChange,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onCollapseSidebar,
  pulseProjects,
  pulseGetProjectSessions,
  pulseActiveSessions,
  pulseAttentionSessionIds,
  pulseSelectedSession,
  pulseCurrentTime,
  onPulseProjectSelect,
  onPulseSessionSelect,
  t,
}: SidebarHeaderProps) {
  const showSearchTools = (projectsCount > 0 || pulseSessionsCount > 0 || archivedSessionsCount > 0 || isArchivedSessionsLoading) && !isLoading;
  const searchPlaceholder = searchMode === 'archived'
    ? t('search.archivedPlaceholder', 'Search archived sessions...')
    : t('projects.searchPlaceholder');

  const LogoBlock = () => (
    <div className="flex min-w-0 items-center gap-2.5">
      {/*
        Тот же /logo.svg, что на экранах входа и загрузки. Здесь раньше стоял
        нарисованный прямо в коде контур — из-за этого приложение показывало
        два разных знака: фирменный при входе и постороннюю заготовку в шапке,
        куда фирменный так и не вставили.
      */}
      <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-primary/90 shadow-sm">
        <img src="/logo.svg" alt="" aria-hidden className="h-4 w-4" />
      </div>
      <h1
        className="truncate text-sm font-bold tracking-tight text-foreground"
        style={{ fontFamily: CLOUDCLI_WORDMARK_FONT_FAMILY }}
      >
        {t('app.title')}
      </h1>
    </div>
  );

  return (
    <div className="flex-shrink-0">
      {/* Desktop header */}
      <div
        className="hidden px-3 pb-2 pt-3 md:block"
        style={{}}
      >
        <div className="flex items-center justify-between gap-2">
          {IS_PLATFORM ? (
            <a
              href="https://cloudcli.ai/dashboard"
              className="flex min-w-0 items-center gap-2.5 transition-opacity hover:opacity-80"
              title={t('tooltips.viewEnvironments')}
            >
              <LogoBlock />
            </a>
          ) : (
            <LogoBlock />
          )}

          <div className="flex flex-shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onRefresh}
              disabled={isRefreshing}
              title={t('tooltips.refresh')}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${
                  isRefreshing ? 'animate-spin' : ''
                }`}
              />
            </Button>
            <SidebarPulseTrigger
              variant="desktop"
              pulseSessionsCount={pulseSessionsCount}
              projects={pulseProjects}
              getProjectSessions={pulseGetProjectSessions}
              activeSessions={pulseActiveSessions}
              attentionSessionIds={pulseAttentionSessionIds}
              selectedSession={pulseSelectedSession}
              currentTime={pulseCurrentTime}
              onProjectSelect={onPulseProjectSelect}
              onSessionSelect={onPulseSessionSelect}
              t={t}
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onCreateProject}
              title={t('tooltips.createProject')}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onCollapseSidebar}
              title={t('tooltips.hideSidebar')}
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* Search bar */}
        {showSearchTools && (
          <div className="mt-2.5 space-y-2">
            {/* Search mode toggle */}
            <div className="flex rounded-lg bg-muted/50 p-0.5">
              <button
                onClick={() => onSearchModeChange('projects')}
                aria-pressed={searchMode === 'projects'}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-normal transition-all",
                  searchMode === 'projects'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Folder className="h-3 w-3" />
                {t('search.modeProjects')}
              </button>
              {projectPickerSlot}
              <Tooltip content={t('search.archiveOnlyTooltip', 'Archive only')} position="top">
                <button
                  onClick={() => onSearchModeChange('archived')}
                  aria-pressed={searchMode === 'archived'}
                  aria-label={t('search.archiveOnlyTooltip', 'Archive only')}
                  title={t('search.archiveOnlyTooltip', 'Archive only')}
                  className={cn(
                    "flex items-center justify-center rounded-md px-2.5 py-1.5 text-xs font-normal transition-all",
                    searchMode === 'archived'
                      ? "bg-background shadow-sm text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Archive className="h-3 w-3" />
                </button>
              </Tooltip>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                type="text"
                placeholder={searchPlaceholder}
                value={searchFilter}
                onChange={(event) => onSearchFilterChange(event.target.value)}
                className="nav-search-input h-9 rounded-xl border-0 pl-9 pr-14 text-sm transition-all duration-200 placeholder:text-muted-foreground/40 focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              {searchFilter ? (
                <button
                  onClick={onClearSearchFilter}
                  aria-label={t('tooltips.clearSearch')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 hover:bg-accent"
                >
                  <X className="h-3 w-3 text-muted-foreground" />
                </button>
              ) : (
                <kbd
                  aria-hidden
                  title={t('tooltips.openCommandPalette')}
                  className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground md:inline-flex"
                >
                  {MOD_KEY}
                  <span>K</span>
                </kbd>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Desktop divider */}
      <div className="nav-divider hidden md:block" />

      {/* Mobile header */}
      <div
        className="p-3 pb-2 md:hidden"
        style={isPWA && isMobile ? { paddingTop: '16px' } : {}}
      >
        <div className="flex items-center justify-between">
          {IS_PLATFORM ? (
            <a
              href="https://cloudcli.ai/dashboard"
              className="flex min-w-0 items-center gap-2.5 transition-opacity active:opacity-70"
              title={t('tooltips.viewEnvironments')}
            >
              <LogoBlock />
            </a>
          ) : (
            <LogoBlock />
          )}

          <div className="flex flex-shrink-0 gap-1.5">
            <button
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/50 transition-all active:scale-95"
              onClick={onRefresh}
              disabled={isRefreshing}
            >
              <RefreshCw className={`h-4 w-4 text-muted-foreground ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            <SidebarPulseTrigger
              variant="mobile"
              pulseSessionsCount={pulseSessionsCount}
              projects={pulseProjects}
              getProjectSessions={pulseGetProjectSessions}
              activeSessions={pulseActiveSessions}
              attentionSessionIds={pulseAttentionSessionIds}
              selectedSession={pulseSelectedSession}
              currentTime={pulseCurrentTime}
              onProjectSelect={onPulseProjectSelect}
              onSessionSelect={onPulseSessionSelect}
              t={t}
            />
            <button
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/90 text-primary-foreground transition-all active:scale-95"
              onClick={onCreateProject}
            >
              <FolderPlus className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Mobile search */}
        {showSearchTools && (
          <div className="mt-2.5 space-y-2">
            <div className="flex rounded-lg bg-muted/50 p-0.5">
              <button
                onClick={() => onSearchModeChange('projects')}
                aria-pressed={searchMode === 'projects'}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-normal transition-all",
                  searchMode === 'projects'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Folder className="h-3 w-3" />
                {t('search.modeProjects')}
              </button>
              {projectPickerSlot}
              <Tooltip content={t('search.archiveOnlyTooltip', 'Archive only')} position="top">
                <button
                  onClick={() => onSearchModeChange('archived')}
                  aria-pressed={searchMode === 'archived'}
                  aria-label={t('search.archiveOnlyTooltip', 'Archive only')}
                  title={t('search.archiveOnlyTooltip', 'Archive only')}
                  className={cn(
                    "flex items-center justify-center rounded-md px-2.5 py-1.5 text-xs font-normal transition-all",
                    searchMode === 'archived'
                      ? "bg-background shadow-sm text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Archive className="h-3 w-3" />
                </button>
              </Tooltip>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                type="text"
                placeholder={searchPlaceholder}
                value={searchFilter}
                onChange={(event) => onSearchFilterChange(event.target.value)}
                className="nav-search-input h-10 rounded-xl border-0 pl-10 pr-9 text-sm transition-all duration-200 placeholder:text-muted-foreground/40 focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              {searchFilter && (
                <button
                  onClick={onClearSearchFilter}
                  aria-label={t('tooltips.clearSearch')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 hover:bg-accent"
                >
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Mobile divider */}
      <div className="nav-divider md:hidden" />
    </div>
  );
}

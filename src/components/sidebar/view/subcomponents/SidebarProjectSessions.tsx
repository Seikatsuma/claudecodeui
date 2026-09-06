import { useMemo, useState } from 'react';
import { Plus, Sparkles } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '../../../../shared/view/ui';
import { api } from '../../../../utils/api';
import type { SessionActivityMap } from '../../../../hooks/useSessionProtection';
import type { Project, ProjectSession, LLMProvider } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';

import SidebarSessionItem from './SidebarSessionItem';

// Mirrors MIN_UNGROUPED_SESSIONS_TO_OFFER on the server - below this there is
// nothing meaningful to cluster, so the button stays hidden instead of
// inviting a click that can only report "not enough sessions".
const MIN_UNGROUPED_SESSIONS_FOR_AUTO_GROUP = 3;

type SessionGroupBucket = {
  groupId: string;
  groupLabel: string;
  sessions: SessionWithProvider[];
};

/**
 * Splits a project's sessions into topic buckets (in first-seen order, which
 * tracks recency since `sessions` already arrives newest-first) plus the
 * remaining ungrouped sessions, so the list can render group headers without
 * a second server round-trip.
 */
function bucketSessionsByGroup(sessions: SessionWithProvider[]): {
  groups: SessionGroupBucket[];
  ungrouped: SessionWithProvider[];
} {
  const groupOrder: string[] = [];
  const groupsById = new Map<string, SessionGroupBucket>();
  const ungrouped: SessionWithProvider[] = [];

  for (const session of sessions) {
    const groupId = typeof session.groupId === 'string' ? session.groupId : null;
    if (!groupId) {
      ungrouped.push(session);
      continue;
    }

    let bucket = groupsById.get(groupId);
    if (!bucket) {
      bucket = {
        groupId,
        groupLabel: (typeof session.groupLabel === 'string' && session.groupLabel.trim()) || groupId,
        sessions: [],
      };
      groupsById.set(groupId, bucket);
      groupOrder.push(groupId);
    }
    bucket.sessions.push(session);
  }

  return { groups: groupOrder.map((id) => groupsById.get(id) as SessionGroupBucket), ungrouped };
}

type SidebarProjectSessionsProps = {
  project: Project;
  isExpanded: boolean;
  sessions: SessionWithProvider[];
  selectedSession: ProjectSession | null;
  initialSessionsLoaded: boolean;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  activeSessions: SessionActivityMap;
  attentionSessionIds: ReadonlySet<string>;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  onLoadMoreSessions: (projectId: string) => void;
  onNewSession: (project: Project) => void;
  t: TFunction;
};

function SessionListSkeleton() {
  return (
    <>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="rounded-md p-2">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 h-3 w-3 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-1">
              <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${60 + index * 15}%` }} />
              <div className="h-2 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

export default function SidebarProjectSessions({
  project,
  isExpanded,
  sessions,
  selectedSession,
  initialSessionsLoaded,
  hasMoreSessions,
  isLoadingMoreSessions,
  activeSessions,
  attentionSessionIds,
  currentTime,
  editingSession,
  editingSessionName,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  onLoadMoreSessions,
  onNewSession,
  t,
}: SidebarProjectSessionsProps) {
  const [isOrganizing, setIsOrganizing] = useState(false);
  const [organizeStatus, setOrganizeStatus] = useState<string | null>(null);

  const { groups, ungrouped } = useMemo(() => bucketSessionsByGroup(sessions), [sessions]);
  const ungroupedCount = ungrouped.length;

  if (!isExpanded) {
    return null;
  }

  const hasSessions = sessions.length > 0;
  const canOfferAutoGroup = ungroupedCount >= MIN_UNGROUPED_SESSIONS_FOR_AUTO_GROUP;

  const handleOrganizeByTopic = async () => {
    if (isOrganizing) {
      return;
    }
    setIsOrganizing(true);
    setOrganizeStatus(null);
    try {
      const response = await api.organizeProjectSessions(project.projectId);
      const data = await response.json();
      const result = data?.data ?? data;
      const groupedCount = Number(result?.groupedCount ?? 0);
      setOrganizeStatus(
        groupedCount > 0
          ? t('sessions.organizedByTopic', '{{count}} sessions grouped', { count: groupedCount })
          : t('sessions.noTopicsFound', 'No clear topics found'),
      );
    } catch {
      setOrganizeStatus(t('sessions.organizeFailed', 'Could not organize sessions'));
    } finally {
      setIsOrganizing(false);
    }
  };

  const renderSession = (session: SessionWithProvider) => (
    <SidebarSessionItem
      key={session.id}
      project={project}
      session={session}
      selectedSession={selectedSession}
      isProcessing={activeSessions.has(session.id)}
      needsAttention={attentionSessionIds.has(session.id)}
      currentTime={currentTime}
      editingSession={editingSession}
      editingSessionName={editingSessionName}
      onEditingSessionNameChange={onEditingSessionNameChange}
      onStartEditingSession={onStartEditingSession}
      onCancelEditingSession={onCancelEditingSession}
      onSaveEditingSession={onSaveEditingSession}
      onProjectSelect={onProjectSelect}
      onSessionSelect={onSessionSelect}
      onDeleteSession={onDeleteSession}
      t={t}
    />
  );

  return (
    <div className="ml-3 space-y-1 border-l border-border pl-3">
      <div className="px-3 pb-1 pt-1 md:hidden">
        <button
          className="flex h-8 w-full items-center justify-center gap-2 rounded-md bg-primary text-xs font-medium text-primary-foreground transition-all duration-150 hover:bg-primary/90 active:scale-[0.98]"
          onClick={() => {
            onProjectSelect(project);
            onNewSession(project);
          }}
        >
          <Plus className="h-3 w-3" />
          {t('sessions.newSession')}
        </button>
      </div>

      <Button
        variant="default"
        size="sm"
        className="hidden h-8 w-full justify-start gap-2 bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 md:flex"
        onClick={() => onNewSession(project)}
      >
        <Plus className="h-3 w-3" />
        {t('sessions.newSession')}
      </Button>

      {canOfferAutoGroup && (
        <div className="px-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-full justify-start gap-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={handleOrganizeByTopic}
            disabled={isOrganizing}
            title={t('sessions.organizeByTopicHint', 'Group sessions by topic using AI')}
          >
            <Sparkles className={`h-3 w-3 ${isOrganizing ? 'animate-pulse' : ''}`} />
            {isOrganizing
              ? t('sessions.organizing', 'Organizing…')
              : t('sessions.organizeByTopic', 'Organize by topic')}
          </Button>
          {organizeStatus && (
            <p className="mt-1 px-1 text-[10px] text-muted-foreground/80">{organizeStatus}</p>
          )}
        </div>
      )}

      {!initialSessionsLoaded ? (
        <SessionListSkeleton />
      ) : !hasSessions ? (
        <div className="px-3 py-2 text-left">
          <p className="text-xs text-muted-foreground">{t('sessions.noSessions')}</p>
        </div>
      ) : (
        <>
          {groups.map((group) => (
            <div key={group.groupId} className="space-y-1 pb-1">
              <div className="flex items-center gap-1.5 px-2 pt-1">
                <span className="h-1 w-1 flex-shrink-0 rounded-full bg-primary/60" aria-hidden />
                <p className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
                  {group.groupLabel}
                </p>
                <span className="flex-shrink-0 text-[10px] tabular-nums text-muted-foreground/50">
                  {group.sessions.length}
                </span>
              </div>
              {group.sessions.map(renderSession)}
            </div>
          ))}

          {ungrouped.map(renderSession)}

          {hasMoreSessions && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-center text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onLoadMoreSessions(project.projectId)}
              disabled={isLoadingMoreSessions}
            >
              {isLoadingMoreSessions ? t('sessions.loadingSessions') : t('sessions.loadMore', { defaultValue: 'Load more sessions' })}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

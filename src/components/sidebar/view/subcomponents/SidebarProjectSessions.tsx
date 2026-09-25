import { useMemo } from 'react';
import { MessageSquareText, Plus, SearchX } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '../../../../shared/view/ui';
import type { SessionActivityMap } from '../../../../hooks/useSessionProtection';
import type { Project, ProjectSession, LLMProvider } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';
import { getSessionTime, groupByRecency } from '../../utils/utils';

import { useSessionMessageSearch } from '../../../command-palette/sources/useSessionMessageSearch';

import SidebarSessionItem from './SidebarSessionItem';
import { useSessionListView } from '../../hooks/useSessionListView';
import { useServerScope } from '../../hooks/useServerScope';

/*
 * Поиск по чатам в списке слева.
 *
 * Раньше строка поиска сверху фильтровала только ПАПКИ по имени, а в режиме
 * одной папки (у Егора он и включён) не делала вообще ничего: набираешь
 * «созидатели» — список не меняется. Теперь поиск идёт по названиям чатов, а
 * ниже подгружаются чаты, где искомое встречается в самой переписке.
 *
 * Названия бывают и по-русски, и латиницей (папка «sozidateli-bot»), а Егор
 * пишет голосом по-русски, поэтому сравнение идёт ещё и в транслите.
 */
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function normalizeForSearch(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function toLatin(value: string): string {
  return [...value].map((ch) => TRANSLIT[ch] ?? ch).join('');
}

function sessionTitleMatches(title: string, query: string): boolean {
  const q = normalizeForSearch(query);
  if (!q) return true;
  const t = normalizeForSearch(title);
  return t.includes(q) || toLatin(t).includes(toLatin(q));
}

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
  /**
   * Список чатов открыт сам по себе, без строки проекта над ним.
   *
   * В обычном режиме список — ветка дерева: он сдвинут вправо и отчёркнут
   * вертикальной линией, чтобы было видно, к какой папке относится. Когда
   * папка одна и её строки на экране нет, сдвигать не от чего: линия висит в
   * воздухе, а всё содержимое стоит в 25 точках от левого края при 12 справа
   * — Егор это и заметил, «с одной стороны ближе к грани, чем с другой».
   */
  flat?: boolean;
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
  /** Текст из строки поиска над списком. Пусто — показывать всё. */
  searchQuery?: string;
  /**
   * Чужая папка для отдельных чатов списка: чат, перенесённый в этот блок из
   * папки другого блока, стоит в общем списке, но открывается, переименовывается
   * и удаляется в своей папке. Нет записи — чат этой папки.
   */
  sessionProjects?: ReadonlyMap<string, Project>;
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
  flat = false,
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
  searchQuery = '',
  sessionProjects,
  t,
}: SidebarProjectSessionsProps) {
  const trimmedQuery = searchQuery.trim();
  const isSearching = trimmedQuery.length > 0;
  const visibleSessions = useMemo(
    () => (isSearching
      ? sessions.filter((session) => sessionTitleMatches(String(session.summary || session.name || session.title || ''), trimmedQuery))
      : sessions),
    [isSearching, sessions, trimmedQuery],
  );
  // По тексту переписки ищет сервер; из его ответа убираем то, что уже
  // нашлось по названию, чтобы один чат не стоял в списке дважды.
  const [serverScope] = useServerScope();
  const { items: messageMatches, searching: messageSearching } = useSessionMessageSearch(
    project.projectId,
    trimmedQuery,
    isExpanded && isSearching,
    true,
    serverScope,
  );
  const extraMessageMatches = useMemo(() => {
    const shown = new Set(visibleSessions.map((session) => session.id));
    return messageMatches.filter((match) => !shown.has(match.sessionId));
  }, [messageMatches, visibleSessions]);

  const [listView] = useSessionListView();

  const { groups, ungrouped } = useMemo(
    () => (listView === 'recent'
      ? { groups: [] as SessionGroupBucket[], ungrouped: visibleSessions }
      : bucketSessionsByGroup(visibleSessions)),
    [listView, visibleSessions],
  );

  // Чаты без темы раскладываются по дням, а то, над чем Клод работает прямо
  // сейчас, поднимается наверх отдельной группой. Плоский список из полусотни
  // одинаковых строк не отвечал на два вопроса, ради которых в него и
  // заходят: что считается прямо сейчас и где вчерашняя работа.
  const dayBuckets = useMemo(() => {
    // lastActivity — время последнего завершённого сообщения, оно не
    // обновляется, пока сессия обрабатывает запрос, поэтому порядок внутри
    // «Сейчас работает» берём из реального времени старта обработки
    // (startedAt), а не из унаследованной сортировки ungrouped по lastActivity.
    const running = ungrouped
      .filter((session) => activeSessions.has(session.id))
      .sort((a, b) => {
        const aStarted = activeSessions.get(a.id)?.startedAt ?? 0;
        const bStarted = activeSessions.get(b.id)?.startedAt ?? 0;
        return bStarted - aStarted;
      });
    const idle = ungrouped.filter((session) => !activeSessions.has(session.id));
    return [
      ...(running.length > 0
        ? [{ key: 'running' as const, title: 'Сейчас работает', items: running }]
        : []),
      ...groupByRecency(idle, currentTime, (session) => getSessionTime(session) || null),
    ];
  }, [ungrouped, activeSessions, currentTime]);

  if (!isExpanded) {
    return null;
  }

  const hasSessions = visibleSessions.length > 0;
  const renderSession = (session: SessionWithProvider) => (
    <SidebarSessionItem
      key={session.id}
      project={sessionProjects?.get(session.id) ?? project}
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
    <div className={flat ? 'space-y-1' : 'ml-3 space-y-1 border-l border-border pl-3'}>
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

      {/* Кнопки «Сгруппировать по темам» больше нет: Егор 13.09.26 обвёл её
          на снимке — «надо убрать совсем». Уже созданные темы по-прежнему
          показываются заголовками групп. */}
      {!initialSessionsLoaded ? (
        <SessionListSkeleton />
      ) : !hasSessions && isSearching ? (
        extraMessageMatches.length === 0 ? (
          <div className="flex items-start gap-2 px-3 py-2 text-left">
            <SearchX className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              {messageSearching
                ? `В названиях чатов «${trimmedQuery}» нет. Ищу в тексте переписки…`
                : trimmedQuery.length < 2
                  ? `В названиях чатов «${trimmedQuery}» нет.`
                  : `«${trimmedQuery}» нет ни в названиях чатов, ни в переписке.`}
            </p>
          </div>
        ) : null
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

          {dayBuckets.map((bucket) => (
            <div key={bucket.key} className="space-y-1 pb-1">
              <div className="flex items-center gap-1.5 px-2 pt-1">
                {bucket.key === 'running' ? (
                  <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-green-500" aria-hidden />
                ) : (
                  <span className="h-1 w-1 flex-shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />
                )}
                <p className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
                  {t(`sessions.group.${bucket.key}`, { defaultValue: bucket.title })}
                </p>
                <span className="flex-shrink-0 text-[10px] tabular-nums text-muted-foreground/50">
                  {bucket.items.length}
                </span>
              </div>
              {bucket.items.map(renderSession)}
            </div>
          ))}

          {hasMoreSessions && !isSearching && (
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

      {isSearching && extraMessageMatches.length > 0 && (
        <div className="space-y-1 pb-1">
          <div className="flex items-center gap-1.5 px-2 pt-2">
            <MessageSquareText className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" aria-hidden />
            <p className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
              Найдено в названиях и переписке
            </p>
            <span className="flex-shrink-0 text-[10px] tabular-nums text-muted-foreground/50">
              {extraMessageMatches.length}
            </span>
          </div>
          {extraMessageMatches.map((match) => (
            <button
              key={match.sessionId}
              type="button"
              className="block w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-accent/60"
              onClick={() => onSessionSelect(
                { id: match.sessionId, summary: match.label, __provider: match.provider, __projectId: project.projectId },
                project.projectId,
              )}
            >
              <span className="block truncate text-sm text-foreground">{match.label}</span>
              {match.snippet && (
                <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{match.snippet}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {isSearching && messageSearching && (hasSessions || extraMessageMatches.length > 0) && (
        <p className="px-3 py-1 text-[11px] text-muted-foreground/70">Ищу ещё в тексте переписки…</p>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Folder, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { MainContentStateViewProps } from '../../types/types';
import type { Project, ServerScope } from '../../../../types/app';
import type { SessionWithProvider } from '../../../sidebar/types/types';
import { formatCompactAge, getAllSessions, getProjectLastActivity, getSessionDate, getSessionName } from '../../../sidebar/utils/utils';
import { effectiveScope, scopeProjectsToServer, useSecondServerLabel, useServerScope } from '../../../sidebar/hooks/useServerScope';
import { cn } from '../../../../lib/utils';
import { api } from '../../../../utils/api';

import MobileMenuButton from './MobileMenuButton';

/*
 * Главный экран, когда чат не открыт (Егор 25.09.26: «добавь открытие нового
 * чата; две нижние плашки папок я не использую; последний чат — классная
 * функция, но чтобы было понятно, что это за чат, и видно остальные чаты;
 * не перегружено, чтобы сразу мог»).
 *
 * Сверху вниз: «Продолжить последний чат» (название, на чём остановились,
 * тема, давность или «работает») → «Новый чат» → «Недавние чаты» (пять строк,
 * как в списке Telegram: название и время, ниже — последние слова) → «Все
 * чаты» открывает панель. Папки — только у того, кто ими пользуется: две и
 * больше звёздочек, тот же признак, по которому панель слева показывает
 * список папок вместо плоского списка чатов.
 */

const RECENT_CHATS_LIMIT = 5;
const MAX_FOLDERS = 6;

type SessionHit = {
  project: Project;
  session: SessionWithProvider;
  /** Чат второго блока («2-й сервер») — у строки тонкая светящаяся полоска. */
  isSecond: boolean;
};

type SessionPreview = {
  lastUserText: string | null;
  lastAssistantText: string | null;
};

type ChatStatus =
  | { kind: 'running'; startedAt: number | null }
  | { kind: 'newReply' }
  | { kind: 'idle' };

function mostUsedProject(projects: Project[]): Project | null {
  return projects.reduce<Project | null>((best, project) => (
    !best || (project.sessionMeta?.total ?? 0) > (best.sessionMeta?.total ?? 0) ? project : best
  ), null);
}

export default function MainContentStateView({
  mode,
  isMobile,
  onMenuClick,
  projects,
  onProjectSelect,
  onSessionSelect,
  onStartNewChat,
  processingSessions,
  attentionSessionIds,
}: MainContentStateViewProps) {
  const [storedServerScope] = useServerScope();
  const secondServerLabel = useSecondServerLabel();
  const serverScope = secondServerLabel ? storedServerScope : 'main';
  const { t } = useTranslation();

  // Экран может простоять открытым долго — «3 ч» не должно застывать.
  const [currentTime, setCurrentTime] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(new Date()), 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  const isLoading = mode === 'loading';

  // Тот же отбор по блоку («Проекты» / «2-й сервер»), что у панели слева.
  const scopedProjects = useMemo(
    () => scopeProjectsToServer(projects, serverScope, Boolean(secondServerLabel)),
    [projects, serverScope, secondServerLabel],
  );

  // Чаты ОБОИХ блоков вперемешку, по времени (Егор 26.09.26: «пусть стартовое
  // окно показывает чаты двух групп»). Блок чата — как у панели: своё значение
  // чата важнее значения папки.
  const recentHits = useMemo<SessionHit[]>(() => {
    const hits: SessionHit[] = [];
    for (const project of projects) {
      const projectScope: ServerScope = project.serverScope ?? 'main';
      for (const session of getAllSessions(project)) {
        const isSecond = Boolean(secondServerLabel)
          && effectiveScope(session.serverScope as ServerScope | null | undefined, projectScope) === 'second';
        hits.push({ project, session, isSecond });
      }
    }
    return hits
      .sort((a, b) => getSessionDate(b.session).getTime() - getSessionDate(a.session).getTime())
      .slice(0, RECENT_CHATS_LIMIT + 1);
  }, [projects, secondServerLabel]);

  // Метка второго блока — как у почтовых программ с общим ящиком (Canary Mail,
  // Thunderbird): тонкая цветная полоска у края строки, название блока — в
  // подсказке. Не точка: точки уже значат «работает» и «новый ответ».
  // Видна, только если вглядеться; у чатов этого сервера метки нет.
  const renderScopeMark = (hit: SessionHit, inset: string) => (hit.isSecond ? (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute left-0 w-[3px] rounded-r-full bg-violet-400/60 shadow-[0_0_6px_rgba(167,139,250,0.45)]',
        inset,
      )}
    />
  ) : null);

  const [lastHit, ...otherHits] = recentHits;

  const starredProjects = useMemo(
    () => scopedProjects.filter((project) => Boolean(project.isStarred)),
    [scopedProjects],
  );
  // Папки нужны, только когда ими пользуются: 2+ звёздочки — панель слева
  // тоже показывает список папок. Одна или ни одной — всё в главной папке.
  const showFolders = serverScope === 'main' && starredProjects.length >= 2;

  // Куда заводится новый чат — туда же, куда «Новый сеанс» плоской панели:
  // во втором блоке — папка второго сервера, иначе единственная звёздочка,
  // без звёздочек — папка с наибольшим числом чатов.
  const newChatProject = useMemo<Project | null>(() => {
    if (serverScope === 'second') {
      return mostUsedProject(scopedProjects.filter((project) => project.serverScope === 'second'))
        ?? lastHit?.project
        ?? null;
    }
    if (starredProjects.length === 1) {
      return starredProjects[0];
    }
    if (starredProjects.length === 0) {
      return mostUsedProject(scopedProjects);
    }
    return lastHit?.project ?? starredProjects[0];
  }, [serverScope, scopedProjects, starredProjects, lastHit]);

  const folders = useMemo(() => {
    if (!showFolders) {
      return [];
    }
    return [...scopedProjects]
      .sort((a, b) => getProjectLastActivity(b).getTime() - getProjectLastActivity(a).getTime())
      .slice(0, MAX_FOLDERS);
  }, [showFolders, scopedProjects]);

  // Последние слова по каждому чату — отдельным запросом: строки видны сразу,
  // превью догружается (обычно доли секунды). Ключ включает время чата, чтобы
  // превью обновилось, когда в чате появилось новое сообщение.
  const previewKey = recentHits
    .map((hit) => `${hit.session.id}@${getSessionDate(hit.session).getTime()}`)
    .join(',');
  const [previews, setPreviews] = useState<Record<string, SessionPreview>>({});
  useEffect(() => {
    if (!previewKey) {
      return;
    }
    const ids = previewKey.split(',').map((part) => part.slice(0, part.lastIndexOf('@')));
    let cancelled = false;
    (async () => {
      try {
        const response = await api.sessionPreviews(ids);
        if (!response.ok) {
          return;
        }
        const payload = await response.json();
        const next = payload?.data?.previews;
        if (!cancelled && next && typeof next === 'object') {
          setPreviews((previous) => ({ ...previous, ...next }));
        }
      } catch {
        // Без превью экран остаётся рабочим: названия и время уже на месте.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [previewKey]);

  const statusOf = (sessionId: string): ChatStatus => {
    const activity = processingSessions?.get(sessionId);
    if (activity) {
      return { kind: 'running', startedAt: activity.startedAt ?? null };
    }
    if (attentionSessionIds?.has(sessionId)) {
      return { kind: 'newReply' };
    }
    return { kind: 'idle' };
  };

  const openChat = (hit: SessionHit) => {
    onProjectSelect(hit.project);
    onSessionSelect({ ...hit.session, __projectId: hit.project.projectId });
  };

  // Цвет — только у точки: сам текст статуса такой же тихий, как время.
  const renderStatus = (hit: SessionHit) => {
    const status = statusOf(hit.session.id);
    if (status.kind === 'running') {
      // «работает · 12 мин» — сколько идёт ход; первую минуту без числа.
      const age = status.startedAt && currentTime.getTime() - status.startedAt >= 60 * 1000
        ? formatCompactAge(status.startedAt, currentTime)
        : '';
      return (
        <span className="flex flex-shrink-0 items-center gap-1.5 text-[13px] text-muted-foreground">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden />
          {t('mainContent.statusRunning')}
          {age ? ` · ${age}` : ''}
        </span>
      );
    }
    if (status.kind === 'newReply') {
      return (
        <span className="flex flex-shrink-0 items-center gap-1.5 text-[13px] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
          {t('mainContent.statusNewReply')}
        </span>
      );
    }
    const age = formatCompactAge(getSessionDate(hit.session).toISOString(), currentTime);
    return age ? <span className="flex-shrink-0 text-[13px] text-muted-foreground/80">{age}</span> : null;
  };

  // Последние слова человека; без подписи «Вы:» — на экране и так только его чаты.
  const previewOf = (sessionId: string): string | null => {
    const preview = previews[sessionId];
    return preview?.lastUserText ?? preview?.lastAssistantText ?? null;
  };

  const handleNewChat = () => {
    if (newChatProject) {
      onStartNewChat?.(newChatProject);
    }
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
      ) : scopedProjects.length === 0 ? (
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
          <div className="mx-auto w-full max-w-xl px-4 pb-10 pt-5 sm:px-6 sm:pt-12">
            {lastHit && (
              <button
                type="button"
                onClick={() => openChat(lastHit)}
                title={lastHit.isSecond ? secondServerLabel ?? undefined : undefined}
                className="relative block w-full rounded-2xl border border-primary/20 bg-primary/[0.06] px-4 py-3.5 text-left transition-colors hover:border-primary/35 hover:bg-primary/10 active:scale-[0.99]"
              >
                {renderScopeMark(lastHit, 'top-4 bottom-4')}
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                    {t('mainContent.lastChat')}
                    {lastHit.session.groupLabel ? ` · ${lastHit.session.groupLabel}` : ''}
                    {showFolders ? ` · ${lastHit.project.displayName}` : ''}
                  </span>
                  {renderStatus(lastHit)}
                </div>
                <p className="mt-1.5 line-clamp-2 text-[17px] font-semibold leading-snug text-foreground">
                  {getSessionName(lastHit.session, t)}
                </p>
                {previewOf(lastHit.session.id) && (
                  <p className="mt-1 line-clamp-2 text-[14px] leading-snug text-muted-foreground">
                    {previewOf(lastHit.session.id)}
                  </p>
                )}
              </button>
            )}

            {newChatProject && (
              <button
                type="button"
                onClick={handleNewChat}
                className={cn(
                  'flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-primary/10 px-5 text-[15px] font-medium text-primary transition-colors hover:bg-primary/15 active:bg-primary/20',
                  lastHit ? 'mt-3' : '',
                )}
              >
                <Plus className="h-[18px] w-[18px]" />
                <span className="truncate">
                  {showFolders
                    ? t('mainContent.newChatIn', { name: newChatProject.displayName })
                    : t('mainContent.newChat')}
                </span>
              </button>
            )}

            {otherHits.length > 0 && (
              <section className="mt-6">
                <h3 className="mb-2 px-1 text-[13px] text-muted-foreground">
                  {t('mainContent.recentChats')}
                </h3>
                <div className="divide-y divide-border/50 overflow-hidden rounded-2xl border border-border/60 bg-card">
                  {otherHits.map((hit) => {
                    const secondLine = previewOf(hit.session.id) ?? hit.session.groupLabel ?? null;
                    return (
                      <button
                        key={`${hit.project.projectId}:${hit.session.id}`}
                        type="button"
                        onClick={() => openChat(hit)}
                        title={hit.isSecond ? secondServerLabel ?? undefined : undefined}
                        className="relative block w-full px-4 py-2.5 text-left transition-colors hover:bg-accent/40 active:bg-accent/60"
                      >
                        {renderScopeMark(hit, 'top-3 bottom-3')}
                        <div className="flex items-baseline gap-3">
                          <span className="min-w-0 flex-1 truncate text-[15px] text-foreground">
                            {getSessionName(hit.session, t)}
                          </span>
                          {renderStatus(hit)}
                        </div>
                        {secondLine && (
                          <p className="mt-0.5 truncate text-[13px] text-muted-foreground/80">{secondLine}</p>
                        )}
                      </button>
                    );
                  })}
                  {isMobile && (
                    <button
                      type="button"
                      onClick={onMenuClick}
                      className="flex w-full items-center justify-between px-4 py-2.5 text-left text-[15px] text-muted-foreground transition-colors hover:bg-accent/40 active:bg-accent/60"
                    >
                      {t('mainContent.allChats')}
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </section>
            )}

            {folders.length > 0 && (
              <section className="mt-6">
                <h3 className="mb-2 px-1 text-[13px] text-muted-foreground">
                  {t('mainContent.folders')}
                </h3>
                <div className="divide-y divide-border/50 overflow-hidden rounded-2xl border border-border/60 bg-card">
                  {folders.map((project) => {
                    const lastActivity = getProjectLastActivity(project);
                    const age = lastActivity.getTime() > 0 ? formatCompactAge(lastActivity.toISOString(), currentTime) : '';

                    return (
                      <button
                        key={project.projectId}
                        type="button"
                        onClick={() => onProjectSelect(project)}
                        className="flex w-full items-baseline gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent/40 active:bg-accent/60"
                        title={project.fullPath}
                      >
                        <span className="min-w-0 flex-1 truncate text-[15px] text-foreground">{project.displayName}</span>
                        {age && <span className="flex-shrink-0 text-[13px] text-muted-foreground/80">{age}</span>}
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

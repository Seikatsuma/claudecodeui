import { useCallback, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import Sidebar from '../sidebar/view/Sidebar';
import MainContent from '../main-content/view/MainContent';
import CommandPalette from '../command-palette/CommandPalette';
import SessionTabsBar from '../session-tabs/SessionTabsBar';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { PaletteOpsProvider, usePaletteOpsRegister } from '../../contexts/PaletteOpsContext';
import { useTasksSettings } from '../../contexts/TasksSettingsContext';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import { useOpenSessionTabs } from '../../hooks/useOpenSessionTabs';
import { useQueuedMessageAutoSend } from '../../hooks/useQueuedMessageAutoSend';
import { useBrowserUseEnabled } from '../../hooks/useBrowserUseEnabled';
import { ensureLatestBuild, watchServiceWorkerUpdates } from '../../lib/appUpdate';
import { api } from '../../utils/api';
import type { AppTab } from '../../types/app';

type RunningSessionApiItem = {
  sessionId?: unknown;
  startedAt?: unknown;
  statusText?: unknown;
  canInterrupt?: unknown;
};

type RunningSessionsApiPayload = {
  data?: {
    sessions?: RunningSessionApiItem[];
  };
};

const parseStartedAt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export default function AppContent() {
  return (
    <PaletteOpsProvider>
      <AppContentInner />
    </PaletteOpsProvider>
  );
}

function AppContentInner() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { t } = useTranslation('common');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage, subscribe } = useWebSocket();

  const {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    syncProcessingSessions,
  } = useSessionProtection();

  const {
    projects,
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    externalMessageUpdate,
    newSessionTrigger,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    openSettings,
    refreshProjectsSilently,
    registerOptimisticSession,
    sidebarSharedProps,
    handleNewSession,
    handleProjectSelect,
    handleSessionSelect,
    handleSessionDelete,
  } = useProjectsState({
    sessionId,
    navigate,
    subscribe,
    isMobile,
    activeSessions: processingSessions,
  });

  // Whether the TaskMaster "Tasks" and "Browser" workspace tabs should be
  // offered. Computed here (not inside MainContent) so both the main content
  // area and the sidebar's compact tab switcher gate on the same values.
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);
  const shouldShowBrowserTab = useBrowserUseEnabled();

  // The sidebar's workspace tab switcher lives inside the mobile drawer too;
  // picking a tab there should close the drawer like picking a project or
  // session does, so the user actually sees the tab they just switched to.
  const handleSidebarTabSelect = useCallback(
    (tab: AppTab) => {
      setActiveTab(tab);
      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, setActiveTab, setSidebarOpen],
  );

  // Open-session tabs (VS Code-style strip above the chat area): a session
  // gets a tab the moment it's actually viewed — sidebar click, search
  // result, notification, deep link — never eagerly for the whole sidebar.
  const activeSessionId = selectedSession?.id ?? sessionId ?? null;
  const { openTabs, switchToTab, closeTab, removeTabsForSessions } = useOpenSessionTabs({
    projects,
    activeSessionId,
    activeSession: selectedSession,
    navigate,
  });

  const handleSessionDeleteWithTabCleanup = useCallback(
    (deletedSessionId: string) => {
      handleSessionDelete(deletedSessionId);
      removeTabsForSessions([deletedSessionId]);
    },
    [handleSessionDelete, removeTabsForSessions],
  );

  // Queued messages for sessions that finish while another session (or none)
  // is being viewed are sent from here; the viewed session's composer handles
  // its own queue.
  useQueuedMessageAutoSend({
    processingSessions,
    activeSessionId,
    ws,
    sendMessage,
    markSessionProcessing,
  });

  const refreshRunningSessions = useCallback(async () => {
    try {
      const response = await api.runningSessions();
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as RunningSessionsApiPayload;
      const sessions = Array.isArray(payload.data?.sessions) ? payload.data.sessions : [];

      syncProcessingSessions(
        sessions
          .map((session) => {
            if (typeof session.sessionId !== 'string' || !session.sessionId) {
              return null;
            }

            return {
              sessionId: session.sessionId,
              startedAt: parseStartedAt(session.startedAt),
              statusText: typeof session.statusText === 'string' ? session.statusText : undefined,
              canInterrupt: typeof session.canInterrupt === 'boolean' ? session.canInterrupt : undefined,
            };
          })
          .filter((session): session is NonNullable<typeof session> => Boolean(session)),
      );
    } catch (error) {
      console.error('[AppContent] Failed to sync running sessions:', error);
    }
  }, [syncProcessingSessions]);

  useEffect(() => {
    void refreshRunningSessions();
  }, [refreshRunningSessions]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshRunningSessions();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [refreshRunningSessions]);

  usePaletteOpsRegister({
    openSettings,
    refreshProjects: refreshProjectsSilently,
  });

  // Открытая страница не должна оставаться на старой сборке (см. appUpdate).
  useEffect(() => {
    watchServiceWorkerUpdates();
    void ensureLatestBuild();
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void ensureLatestBuild();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return undefined;
    }

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.type !== 'notification:navigate') {
        return;
      }

      if (typeof message.provider === 'string' && message.provider.trim()) {
        localStorage.setItem('selected-provider', message.provider);
      }

      setActiveTab('chat');
      setSidebarOpen(false);
      void refreshProjectsSilently();

      if (typeof message.sessionId === 'string' && message.sessionId) {
        navigate(`/session/${message.sessionId}`);
        return;
      }

      navigate('/');
    };

    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [navigate, refreshProjectsSilently, setActiveTab, setSidebarOpen]);

  // Pending tool permissions are recovered through the `chat.subscribe` flow:
  // the `chat_subscribed` ack carries them on session open and on reconnect,
  // so no separate permission-recovery message is needed here.

  // Adjust the app container to stay above the virtual keyboard on iOS Safari.
  // On Chrome for Android the layout viewport already shrinks when the keyboard opens,
  // so inset-0 adjusts automatically. On iOS the layout viewport stays full-height and
  // the keyboard overlays it — we use the Visual Viewport API to track keyboard height
  // and apply it as a CSS variable that shifts the container's bottom edge up.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    // Installed on the home screen, iOS reports a visual viewport that is
    // permanently shorter than `innerHeight` (the home-indicator strip), with
    // no keyboard anywhere. Read as keyboard height, that lifted the whole
    // shell and left a dead band under the chat - and the composer already
    // keeps clear of the indicator with its own bottom padding, so the gap was
    // pure duplication. In a browser tab the same difference is the toolbars,
    // which genuinely do cover the bottom, so nothing changes there.
    const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches === true
      || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;

    // Whatever gap exists while nothing is focused is the device's own, not a
    // keyboard. Measured rather than assumed: the strip differs by model and
    // orientation, and iOS has changed what it reports between versions.
    let restingGap = 0;
    const isTyping = () => {
      const active = document.activeElement;
      return active instanceof HTMLElement
        && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
    };
    const calibrate = () => {
      if (isStandalone && !isTyping()) {
        restingGap = Math.max(0, window.innerHeight - vv.height);
      }
    };

    const update = () => {
      // Only resize matters — keyboard open/close changes vv.height.
      // Do NOT listen to scroll: on iOS Safari, scrolling content changes
      // vv.offsetTop which would make --keyboard-height fluctuate during
      // normal scrolling, causing the container to bounce up and down.
      const gap = Math.max(0, window.innerHeight - vv.height);
      const kb = isStandalone ? Math.max(0, gap - restingGap) : gap;
      document.documentElement.style.setProperty('--keyboard-height', `${kb}px`);
    };
    // Run once on mount, not only on the next resize: if the browser's own
    // toolbars are already showing when the app loads (the normal state on a
    // phone), innerHeight already exceeds the visible height, and without this
    // first call the offset stayed 0 until something happened to fire a
    // resize - leaving the composer's bottom row tucked under the toolbar with
    // no way to scroll to it, since the shell is fixed and the document does
    // not scroll.
    calibrate();
    update();


    // Меряем высоту НАСТОЯЩИМ элементом: значение из getComputedStyle для
    // единиц вроде dvh WebKit отдаёт устаревшим, а offsetHeight заставляет
    // пересчитать раскладку и говорит правду.
    const measureCssHeight = (unit: string): number => {
      const probeNode = document.createElement('div');
      probeNode.style.cssText =
        `position:fixed;top:0;left:0;width:0;height:${unit};visibility:hidden;pointer-events:none`;
      document.body.appendChild(probeNode);
      const value = probeNode.offsetHeight;
      probeNode.remove();
      return value;
    };

    // Разовый отчёт с устройства: что именно сообщает браузер.
    //
    // Раньше отчёт слался только из приложения с экрана «Домой». Но пустая
    // полоса снизу видна и в обычном браузере телефона, а на сервере ни то,
    // ни другое не воспроизводится: в отладочном браузере поле ввода
    // упирается в низ, просвет 4 точки. Поэтому шлём отовсюду — и указываем,
    // откуда именно. Убрать вместе с /api/layout-probe.
    {
      window.setTimeout(() => {
        const root = document.getElementById('root');
        const shell = document.querySelector('.fixed.inset-0');
        const styles = getComputedStyle(document.documentElement);
        const composer = document.querySelector('.chat-composer-shell');
        const composerRect = composer ? composer.getBoundingClientRect() : null;
        // Последний видимый элемент внизу экрана — что бы там ни было
        // открыто: подвал меню, поле ввода, карточка «С возвращением».
        let lowestBottom = -1;
        document.querySelectorAll('*').forEach((node) => {
          const rect = node.getBoundingClientRect();
          if (rect.width > 40 && rect.height > 8 && rect.bottom > lowestBottom
              && rect.bottom <= window.innerHeight + 1) {
            lowestBottom = rect.bottom;
          }
        });
        const probe = new URLSearchParams({
            innerH: String(window.innerHeight),
            vvH: String(Math.round(vv.height)),
            vvTop: String(Math.round(vv.offsetTop)),
            dvh: String(Math.round(document.documentElement.clientHeight)),
            screenH: String(window.screen.height),
            restingGap: String(restingGap),
            kbVar: styles.getPropertyValue('--keyboard-height').trim(),
            safeTop: styles.getPropertyValue('--safe-area-inset-top').trim(),
            safeBottom: styles.getPropertyValue('--safe-area-inset-bottom').trim(),
            rootH: String(root ? Math.round(root.getBoundingClientRect().height) : -1),
            shellTop: String(shell ? Math.round(shell.getBoundingClientRect().top) : -1),
            shellBottom: String(shell ? Math.round(shell.getBoundingClientRect().bottom) : -1),
            composerBottom: String(composerRect ? Math.round(composerRect.bottom) : -1),
            composerTop: String(composerRect ? Math.round(composerRect.top) : -1),
            lowestBottom: String(Math.round(lowestBottom)),
            bodyH: String(Math.round(document.body.getBoundingClientRect().height)),
            rootTop: String(root ? Math.round(root.getBoundingClientRect().top) : -1),
            rootBottom: String(root ? Math.round(root.getBoundingClientRect().bottom) : -1),
            availH: String(window.screen.availHeight),
            headerPad: styles.getPropertyValue('--header-total-padding').trim(),
            dpr: String(window.devicePixelRatio),
            // Чему РЕАЛЬНО равны обе меры высоты на этом устройстве: именно
            // расхождение между ними и оставляло пустую полосу.
            vh100: String(measureCssHeight('100vh')),
            dvh100: String(measureCssHeight('100dvh')),
            изПриложения: String(isStandalone),
            браузер: navigator.userAgent.slice(0, 60),
            // Решающее число: где окно приложения стоит на экране.
            // 0 — значит пустая полоса снизу, 62 — значит сверху.
            screenY: String(window.screenY),
            outerH: String(window.outerHeight),
        });
        void fetch(`/api/layout-probe?${probe.toString()}`).catch(() => {});
      }, 2500);
    }
    vv.addEventListener('resize', update);
    // Re-measure the device's own gap only at moments when a keyboard cannot
    // be the cause: a turned phone, and coming back to the app.
    const recalibrate = () => {
      calibrate();
      update();
    };
    window.addEventListener('orientationchange', recalibrate);
    document.addEventListener('visibilitychange', recalibrate);
    return () => {
      vv.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', recalibrate);
      document.removeEventListener('visibilitychange', recalibrate);
    };
  }, []);

  return (
    <div
      className="fixed inset-0 flex bg-background"
      // inset-0 alone sizes this to the LAYOUT viewport, which on mobile
      // Safari stays at its full height even while the browser's toolbars are
      // covering the bottom of the screen - so the composer's last row ended
      // up underneath them, unreachable because the shell is fixed and the
      // page itself does not scroll. Clamping to 100dvh ties the shell to the
      // viewport that is actually visible right now, and the browser
      // recalculates it by itself whenever the toolbars or the window change,
      // at any size. The keyboard offset stays on top of that for iOS, where
      // the keyboard overlays rather than shrinks the layout viewport.
      style={{
        bottom: 'var(--keyboard-height, 0px)',
        maxHeight: 'calc(100dvh - var(--keyboard-height, 0px))',
      }}
    >
      {!isMobile ? (
        <div className="h-full flex-shrink-0 border-r border-border/50">
          <Sidebar
            {...sidebarSharedProps}
            onSessionDelete={handleSessionDeleteWithTabCleanup}
            activeTab={activeTab}
            setActiveTab={handleSidebarTabSelect}
            shouldShowTasksTab={shouldShowTasksTab}
            shouldShowBrowserTab={shouldShowBrowserTab}
          />
        </div>
      ) : (
        <div
          className={`fixed inset-0 z-50 flex transition-all duration-150 ease-out ${sidebarOpen ? 'visible opacity-100' : 'invisible opacity-0'
            }`}
        >
          <button
            className="fixed inset-0 bg-background/60 backdrop-blur-sm transition-opacity duration-150 ease-out"
            onClick={(event) => {
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            onTouchStart={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            aria-label={t('versionUpdate.ariaLabels.closeSidebar')}
          />
          <div
            className={`relative h-full w-[85vw] max-w-sm transform border-r border-border/40 bg-card transition-transform duration-150 ease-out sm:w-80 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
              }`}
            onClick={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
          >
            <Sidebar
            {...sidebarSharedProps}
            onSessionDelete={handleSessionDeleteWithTabCleanup}
            activeTab={activeTab}
            setActiveTab={handleSidebarTabSelect}
            shouldShowTasksTab={shouldShowTasksTab}
            shouldShowBrowserTab={shouldShowBrowserTab}
          />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <SessionTabsBar
          tabs={openTabs}
          activeSessionId={activeSessionId}
          onSelect={switchToTab}
          onClose={closeTab}
        />
        <MainContent
          projects={projects}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          shouldShowTasksTab={shouldShowTasksTab}
          shouldShowBrowserTab={shouldShowBrowserTab}
          ws={ws}
          sendMessage={sendMessage}
          isMobile={isMobile}
          onMenuClick={() => setSidebarOpen(true)}
          isLoading={isLoadingProjects}
          onInputFocusChange={setIsInputFocused}
          onSessionProcessing={markSessionProcessing}
          onSessionIdle={markSessionIdle}
          processingSessions={processingSessions}
          onNavigateToSession={(targetSessionId: string, options) =>
            navigate(`/session/${targetSessionId}`, { replace: Boolean(options?.replace) })
          }
          onSessionEstablished={(targetSessionId, context) =>
            registerOptimisticSession({ sessionId: targetSessionId, ...context })
          }
          onShowSettings={openSettings}
          externalMessageUpdate={externalMessageUpdate}
          newSessionTrigger={newSessionTrigger}
          onProjectSelect={handleProjectSelect}
          onSessionSelect={handleSessionSelect}
          onProjectsRefresh={() => void refreshProjectsSilently()}
        />
      </div>

      <CommandPalette
        selectedProject={selectedProject}
        onStartNewChat={handleNewSession}
        onOpenSettings={() => openSettings()}
        onShowTab={setActiveTab}
      />
    </div>
  );
}

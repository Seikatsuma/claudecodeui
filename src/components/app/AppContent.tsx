import { useCallback, useEffect, useMemo } from 'react';
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
import { useTerminalTabs } from '../../hooks/useTerminalTabs';
import { useBrowserUseEnabled } from '../../hooks/useBrowserUseEnabled';
import { ensureLatestBuild, watchServiceWorkerUpdates } from '../../lib/appUpdate';
import { api, authenticatedFetch } from '../../utils/api';
import type { AppTab, Project } from '../../types/app';
import { effectiveScope, useServerScope, type ServerScope } from '../sidebar/hooks/useServerScope';

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
  const { ws, sendMessage, subscribe, isConnected } = useWebSocket();

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
    attentionSessionIds,
    handleProjectSelect,
    handleSessionSelect,
    handleSessionDelete,
    removeSessionFromList,
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

  // Блок слева («Проекты» / «2-й сервер») всегда тот, где лежит открытый чат.
  // Егор 22.09.26: надпись «2-й сервер» должна значить ровно одно — я сейчас
  // в папке второго сервера. Без этой сверки блок оставался от прошлого
  // нажатия, и новый чат заводился во втором сервере незаметно для человека.
  const [, setServerScope] = useServerScope();
  // Блок папки берётся из общего списка папок: чат, открытый по ссылке или
  // вкладкой сверху, приносит папку из другого ответа сервера, где этого
  // признака нет, — и папка второго сервера выглядела бы обычной.
  const scopeOfProject = useCallback(
    (project: Project | null | undefined): ServerScope => (
      project
        ? (projects.find((candidate: Project) => candidate.projectId === project.projectId)?.serverScope
          ?? project.serverScope
          ?? 'main')
        : 'main'
    ),
    [projects],
  );
  const openChatScope: ServerScope | null = selectedProject
    ? effectiveScope(selectedSession?.serverScope, scopeOfProject(selectedProject))
    : null;
  useEffect(() => {
    if (openChatScope) setServerScope(openChatScope);
  }, [openChatScope, selectedProject?.projectId, selectedSession?.id, setServerScope]);

  // Командная строка всегда работает на ЭТОМ сервере: папка второго сервера
  // здесь лишь дверь, и оболочка в ней не подключена ко второй машине — а
  // подпись «2-й сервер» обещала бы именно это. Поэтому из чата второго блока
  // и с главного экрана (чат не выбран) окно открывается в главной папке
  // этого сервера: со звёздочкой, иначе с наибольшим числом чатов.
  const terminalProjectId = useMemo(() => {
    if (selectedProject && scopeOfProject(selectedProject) !== 'second') return selectedProject.projectId;
    const mainProjects = projects.filter((project: Project) => scopeOfProject(project) === 'main');
    if (mainProjects.length === 0) return selectedProject?.projectId ?? null;
    const starred = mainProjects.find((project: Project) => project.isStarred);
    const busiest = mainProjects.reduce((best: Project, project: Project) => (
      (project.sessionMeta?.total ?? 0) > (best.sessionMeta?.total ?? 0) ? project : best
    ));
    return (starred ?? busiest).projectId;
  }, [projects, scopeOfProject, selectedProject]);

  // Окна командной строки. Живут рядом с чатами: своя вкладка наверху, свой
  // крестик, несколько сразу. Открываются одной дверью — запросом вкладки
  // 'shell' (кнопка в боковой панели, палитра команд): вместо переключения
  // режима приложения это заводит новое окно.
  const {
    terminals,
    activeTerminalId,
    openTerminal,
    focusTerminal,
    closeTerminal,
    moveTerminal,
    clearActiveTerminal,
  } = useTerminalTabs(terminalProjectId);

  const selectTab = useCallback(
    (tab: AppTab) => {
      if (tab === 'shell') {
        openTerminal();
        return;
      }
      clearActiveTerminal();
      setActiveTab(tab);
    },
    [clearActiveTerminal, openTerminal, setActiveTab],
  );

  // Открытый чат всегда важнее открытого окна командной строки: как только
  // человек выбирает переписку — папку, чат, новый чат, ссылку из уведомления
  // — окно уходит на задний план (не закрывается, вкладка остаётся).
  const sidebarPropsLeavingTerminal = useMemo(
    () => ({
      ...sidebarSharedProps,
      onProjectSelect: (...args: Parameters<typeof sidebarSharedProps.onProjectSelect>) => {
        clearActiveTerminal();
        return sidebarSharedProps.onProjectSelect(...args);
      },
      onSessionSelect: (...args: Parameters<typeof sidebarSharedProps.onSessionSelect>) => {
        clearActiveTerminal();
        return sidebarSharedProps.onSessionSelect(...args);
      },
      onNewSession: (...args: Parameters<typeof sidebarSharedProps.onNewSession>) => {
        clearActiveTerminal();
        return sidebarSharedProps.onNewSession(...args);
      },
    }),
    [clearActiveTerminal, sidebarSharedProps],
  );

  // Смена адреса (ссылка, уведомление, результат поиска) — тот же уход.
  useEffect(() => {
    clearActiveTerminal();
  }, [clearActiveTerminal, sessionId]);

  // The sidebar's workspace tab switcher lives inside the mobile drawer too;
  // picking a tab there should close the drawer like picking a project or
  // session does, so the user actually sees the tab they just switched to.
  const handleSidebarTabSelect = useCallback(
    (tab: AppTab) => {
      selectTab(tab);
      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, selectTab, setSidebarOpen],
  );

  // Open-session tabs (VS Code-style strip above the chat area): a session
  // gets a tab the moment it's actually viewed — sidebar click, search
  // result, notification, deep link — never eagerly for the whole sidebar.
  const activeSessionId = selectedSession?.id ?? sessionId ?? null;
  const { openTabs, switchToTab, closeTab, moveTab, removeTabsForSessions } = useOpenSessionTabs({
    projects,
    activeSessionId,
    activeSession: selectedSession,
    navigate,
  });

  // Фоновые вкладки тоже подписаны на живые события своих чатов.
  //
  // Окно чата подписывается только на ОТКРЫТЫЙ чат. После загрузки страницы
  // (или открытия приложения) остальные вкладки знали лишь «чат занят» из
  // списка работающих — и значок на вкладке навсегда оставался «ожидает», хотя
  // модель думала (живой тест 13.09.26). Подписка на фоновые вкладки приносит
  // их события — «думает», «пишет ответ», «работает» — и значок на вкладке
  // становится правдой. Повторяется только при смене набора вкладок или связи,
  // а не при каждом переименовании.
  const backgroundTabIdsKey = openTabs
    .map((tab) => tab.sessionId)
    .filter((sessionId) => sessionId && sessionId !== activeSessionId)
    .sort()
    .join('|');
  useEffect(() => {
    if (!isConnected || !backgroundTabIdsKey) return;
    sendMessage({
      type: 'chat.subscribe',
      sessions: backgroundTabIdsKey.split('|').map((sessionId) => ({ sessionId, lastSeq: 0, runStartedAt: null })),
    });
  }, [backgroundTabIdsKey, isConnected, sendMessage]);

  const handleSessionDeleteWithTabCleanup = useCallback(
    (deletedSessionId: string) => {
      handleSessionDelete(deletedSessionId);
      removeTabsForSessions([deletedSessionId]);
    },
    [handleSessionDelete, removeTabsForSessions],
  );

  /*
   * Отправка очереди со страницы убрана.
   *
   * Очередь сообщений теперь хранит и отправляет сервер по концу хода
   * (server/modules/websocket/services/chat-queue.service.ts) — она работает и
   * при закрытом сайте, и для чатов, которые сейчас не открыты. Этот хук
   * отправлял её из браузера, и без открытой вкладки она стояла.
   */

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

  // Пока вкладка/приложение в фоне (свёрнут телефон, PWA в спящем режиме),
  // сокет часто остаётся числиться открытым, но пуши по нему не идут - см.
  // комментарий у forceReconnect в WebSocketContext. Список чатов слева в это
  // время не получает ни одной дельты `session_upserted`, и время последней
  // активности в нём застывает на моменте до сна, пока страницу не
  // перезагрузят. Тихий перезапрос списка при возврате в него чинит это, а
  // пока список на экране — ещё и раз в минуту (см. ниже).
  useEffect(() => {
    const onResume = () => {
      if (document.visibilityState === 'visible') {
        void refreshProjectsSilently();
      }
    };
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('pageshow', onResume);
    window.addEventListener('online', onResume);
    // На общем экземпляре дельт `session_upserted` о новых сообщениях нет
    // вовсе (наблюдатель за файлами выключен), и время у чатов, пока список
    // открыт, не менялось. Сервер сверяет его по перепискам раз в 15 секунд
    // (session-activity-sync.service.ts); список забирает свежее раз в минуту
    // — так же часто тикает и само «N мин» в строке (useSidebarController).
    const timer = window.setInterval(onResume, 60_000);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('pageshow', onResume);
      window.removeEventListener('online', onResume);
    };
  }, [refreshProjectsSilently]);

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
    // Высота страницы, от которой считается клавиатура. На iOS 26 в приложении
    // с экрана «Домой» innerHeight при открытой клавиатуре сжимается вместе с
    // видимой областью (замер с iPhone Егора 17.09.26: innerHeight 471,
    // visualViewport.height 471, clientHeight 812, offsetTop 341). Разность
    // innerHeight − height давала 0: приложение «не видело» клавиатуру, отступ
    // под полоску «домой» оставался промежутком, а поле поднимала только
    // прокрутка самой iOS — на ней Safari и рисует курсор не на строке.
    // clientHeight корня при клавиатуре не меняется; в обычной вкладке Safari
    // innerHeight не меньше него, поэтому там всё как раньше.
    //
    // Но и эти числа на iOS 26 «плавают» без событий: замеры 17.09 08:09 —
    // innerHeight то 812, то 874 (с полосой часов), и расчёт, попавший на 812,
    // уводил низ поля под панель клавиатуры ровно на 62 точки. Поэтому высота
    // берётся не у браузера, а у невидимого закреплённого элемента с
    // top: 0; bottom: 0 — это тот самый прямоугольник, от низа которого
    // отсчитывается bottom оболочки, какой бы он ни был в этот момент. Высота
    // прямоугольника не зависит от того, от какого края iOS считает координаты.
    const sentinel = document.createElement('div');
    sentinel.setAttribute('aria-hidden', 'true');
    sentinel.style.cssText = 'position:fixed;top:0;bottom:0;left:0;width:0;visibility:hidden;pointer-events:none;';
    document.body.appendChild(sentinel);
    const layoutHeight = () => {
      const height = sentinel.getBoundingClientRect().height;
      return height > 0 ? height : Math.max(window.innerHeight, document.documentElement.clientHeight);
    };
    const isTyping = () => {
      const active = document.activeElement;
      return active instanceof HTMLElement
        && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
    };
    const calibrate = () => {
      if (isStandalone && !isTyping()) {
        restingGap = Math.max(0, layoutHeight() - vv.height);
      }
    };

    const update = () => {
      // Only resize matters — keyboard open/close changes vv.height.
      // Do NOT listen to scroll: on iOS Safari, scrolling content changes
      // vv.offsetTop which would make --keyboard-height fluctuate during
      // normal scrolling, causing the container to bounce up and down.
      const gap = Math.max(0, layoutHeight() - vv.height);

      // Клавиатура открыта: идёт набор и видимая область заметно короче
      // экрана (внешняя клавиатура даёт полоску в несколько десятков точек).
      // Полоски «домой» под полем в этот момент нет — её закрывает
      // клавиатура, а отступ под неё давал пустую полосу между полем и
      // клавиатурой (снимок Егора 16.09.26). Класс keyboard-open снимает
      // этот отступ (index.css).
      const keyboardOpen = isTyping() && gap > 120;
      document.documentElement.classList.toggle('keyboard-open', keyboardOpen);
      // Полоска «домой» (restingGap) под открытой клавиатурой не видна —
      // низ оболочки должен совпасть с краем видимой области без вычета.
      const raw = isStandalone && !keyboardOpen ? Math.max(0, gap - restingGap) : gap;

      // Ограничитель. Клавиатура физически не занимает больше двух третей
      // экрана, а вот числа от браузера в момент её появления бывают любыми:
      // высота видимой области успевает провалиться почти до нуля, и разность
      // становится больше самого экрана. Оболочка задана как «низ на высоте
      // клавиатуры», поэтому при таком значении её нижняя граница уезжает выше
      // верхней, высота схлопывается в ноль, и поле ввода оказывается на самом
      // верху поверх часов — это Егор и снял.
      //
      // Ограничение снимает целый класс таких срывов: даже если замер соврал,
      // раскладка остаётся рабочей.
      const ceiling = Math.round(layoutHeight() * 0.7);
      const kb = Math.min(raw, ceiling);

      // Сдвиг страницы, который iOS делает сама. Когда появляется клавиатура,
      // Safari «подтягивает» поле ввода: прокручивает видимую область вниз по
      // странице (vv.offsetTop). Закреплённая оболочка при этом едет вверх
      // вместе со всем экраном — а мы её ещё и поднимаем на высоту клавиатуры.
      // Двойной подъём: при полном сдвиге поле ввода улетает к часам, при
      // частичном висит посреди экрана с пустотой снизу и лентой под часами
      // (оба снимка Егора 14.09.26; повторено подменой visualViewport).
      // Поэтому оболочка опускается ровно на этот сдвиг: верх — у верхнего
      // края видимой области, низ — у клавиатуры. Сдвиг не больше высоты
      // клавиатуры: без клавиатуры он всегда ноль, и обычная прокрутка ленты
      // оболочку не двигает.
      const pan = Math.max(0, Math.min(vv.offsetTop, kb));
      const changed = kb !== lastKb || pan !== lastPan;
      lastKb = kb;
      lastPan = pan;
      // Высота видимой части экрана — от неё считается предел высоты поля
      // ввода (--composer-max-h в index.css).
      document.documentElement.style.setProperty('--visible-h', `${Math.round(vv.height)}px`);
      document.documentElement.style.setProperty('--keyboard-height', `${kb}px`);
      document.documentElement.style.setProperty('--app-pan', `${pan}px`);
      // Пол высоты по 100dvh нужен без клавиатуры (панели Safari). С
      // клавиатурой высоту задают top/bottom, а 100dvh на iOS 26 может
      // сжаться и сплющить оболочку до пола.
      if (kb > 0) document.documentElement.style.setProperty('--app-max-h', 'none');
      else document.documentElement.style.removeProperty('--app-max-h');
      if (changed) scheduleCaretRedraw();
      if (kb > 0) scheduleScrollReset();
      if (isTyping()) scheduleProbe({ gap, kb, pan, keyboardOpen });
    };

    // Замер для журнала сайта: настоящие числа iPhone при открытой клавиатуре.
    // Эмулятор на сервере дважды разошёлся с телефоном (16.09.26).
    let probeTimer = 0;
    let probesLeft = 30;
    const scheduleProbe = (state: { gap: number; kb: number; pan: number; keyboardOpen: boolean }) => {
      if (probesLeft <= 0) return;
      window.clearTimeout(probeTimer);
      probeTimer = window.setTimeout(() => {
        probesLeft -= 1;
        const rectOf = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
        const composer = rectOf('.chat-composer-shell');
        const form = document.querySelector('textarea.chat-input-placeholder')?.closest('form')?.getBoundingClientRect();
        const textarea = rectOf('textarea.chat-input-placeholder');
        const shell = rectOf('div.fixed.inset-0.flex.bg-background');
        // Окно поверх экрана с полем (переименование чата и т.п.), 26.09.26.
        const dialog = document.activeElement?.closest('[role="dialog"]')?.getBoundingClientRect();
        void authenticatedFetch('/api/user/viewport-probe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...state,
            standalone: isStandalone,
            restingGap,
            innerHeight: window.innerHeight,
            layoutH: layoutHeight(),
            clientH: document.documentElement.clientHeight,
            vvHeight: vv.height,
            vvTop: vv.offsetTop,
            vvScale: vv.scale,
            scrollY: window.scrollY,
            screenH: window.screen.height,
            docClientH: document.documentElement.clientHeight,
            shellTop: shell?.top ?? -1,
            shellBottom: shell?.bottom ?? -1,
            composerBottom: composer?.bottom ?? -1,
            formBottom: form?.bottom ?? -1,
            textareaTop: textarea?.top ?? -1,
            composerPad: composer ? parseFloat(getComputedStyle(document.querySelector('.chat-composer-shell')!).paddingBottom) : -1,
            focused: document.activeElement?.tagName ?? '',
            dialogTop: dialog?.top ?? -1,
            dialogBottom: dialog?.bottom ?? -1,
          }),
        }).catch(() => {});
      }, 900);
    };
    let lastKb = -1;
    let lastPan = -1;

    // Сдвиг экрана, которым iOS «подтягивает» поле, возвращается в ноль, но
    // ТОЛЬКО когда клавиатура уже измерена (kb > 0): оболочка тогда сама стоит
    // над клавиатурой, и показывать поле сдвигом не нужно. Без сдвига Safari
    // рисует курсор на строке текста. 16.09 сброс делался при kb = 0 (ошибка
    // замера выше) — и поле ушло под клавиатуру. Не получилось сбросить —
    // раскладку держит учёт сдвига (pan), она верна в обоих состояниях.
    // Не больше трёх сбросов на одно нажатие: если iOS упорно возвращает
    // сдвиг, спорить с ней — дёргать экран; раскладку тогда держит pan.
    let scrollFrame = 0;
    let scrollResetsLeft = 3;
    const scheduleScrollReset = () => {
      if (scrollFrame || scrollResetsLeft <= 0) return;
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = 0;
        if (isTyping() && (window.scrollY !== 0 || window.scrollX !== 0)) {
          scrollResetsLeft -= 1;
          window.scrollTo(0, 0);
        }
      });
    };
    // Новое нажатие на поле — снова три попытки. Уход из поля — пересчёт
    // сразу: на iOS 26 resize после закрытия клавиатуры приходит не всегда.
    // Пока выезжает клавиатура, iOS меняет размеры не всегда с событием —
    // несколько контрольных пересчётов до конца анимации.
    let settleTimers: number[] = [];
    const onFocusIn = () => {
      scrollResetsLeft = 3;
      settleTimers.forEach((timer) => window.clearTimeout(timer));
      settleTimers = [80, 250, 500, 900].map((delay) => window.setTimeout(scheduleUpdate, delay));
    };
    let blurTimer = 0;
    const onFocusOut = () => {
      window.clearTimeout(blurTimer);
      blurTimer = window.setTimeout(update, 50);
    };

    // Курсор ниже текста (iOS 26, снимок Егора 16.09.26: набрано «Ром»,
    // курсор строкой ниже). Safari рисует курсор по месту поля в момент
    // фокуса и не переносит его, когда закреплённая оболочка сдвигается
    // следом за клавиатурой. Известная ошибка WebKit с полями внутри
    // position: fixed. После каждого сдвига оболочки выделение ставится
    // заново — это заставляет Safari пересчитать место курсора. Сбрасывать
    // прокрутку документа в ноль нельзя: этим сдвигом iOS и поднимает поле
    // над клавиатурой, без него поле ушло под клавиатуру (снимок 16.09.26).
    let caretFrame = 0;
    const scheduleCaretRedraw = () => {
      if (caretFrame) window.cancelAnimationFrame(caretFrame);
      caretFrame = window.requestAnimationFrame(() => {
        caretFrame = 0;
        const active = document.activeElement;
        if (!(active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)) return;
        try {
          const { selectionStart, selectionEnd, selectionDirection } = active;
          if (selectionStart === null || selectionEnd === null) return;
          active.setSelectionRange(selectionStart, selectionEnd, selectionDirection ?? undefined);
        } catch {
          // Поля без выделения (type=number и т.п.) — курсора нет, чинить нечего.
        }
      });
    };
    let frame = 0;
    const scheduleUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        update();
      });
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


    vv.addEventListener('resize', update);
    // Сдвиг iOS меняется событием scroll видимой области, а не resize.
    vv.addEventListener('scroll', scheduleUpdate);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    // Прямоугольник закреплённых элементов сменил высоту — пересчёт, даже если
    // браузер не прислал resize.
    const sentinelObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleUpdate);
    sentinelObserver?.observe(sentinel);
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
      vv.removeEventListener('scroll', scheduleUpdate);
      window.clearTimeout(probeTimer);
      if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
      window.clearTimeout(blurTimer);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      settleTimers.forEach((timer) => window.clearTimeout(timer));
      sentinelObserver?.disconnect();
      sentinel.remove();
      document.documentElement.style.removeProperty('--app-max-h');
      if (frame) window.cancelAnimationFrame(frame);
      if (caretFrame) window.cancelAnimationFrame(caretFrame);
      document.documentElement.classList.remove('keyboard-open');
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
        // Верх опускается на сдвиг, который делает iOS, низ — у клавиатуры
        // с поправкой на тот же сдвиг (см. update выше).
        // Отступ под чёлку в режиме приложения (--shell-top, index.css) плюс
        // сдвиг iOS: без первого вкладки чатов уходят под часы (14.09.26).
        top: 'calc(var(--shell-top, 0px) + var(--app-pan, 0px))',
        bottom: 'calc(var(--keyboard-height, 0px) - var(--app-pan, 0px))',
        // Пол на всякий случай: даже при неверном замере оболочка остаётся
        // видимой, а не сжимается в полоску.
        maxHeight: 'var(--app-max-h, max(240px, calc(100dvh - var(--keyboard-height, 0px))))',
      }}
    >
      {!isMobile ? (
        <div className="h-full flex-shrink-0 border-r border-border/50">
          <Sidebar
            {...sidebarPropsLeavingTerminal}
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
            {...sidebarPropsLeavingTerminal}
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
          onSelect={(id) => {
            clearActiveTerminal();
            switchToTab(id);
          }}
          onClose={closeTab}
          onReorder={moveTab}
          terminals={terminals}
          activeTerminalId={activeTerminalId}
          onSelectTerminal={focusTerminal}
          onCloseTerminal={closeTerminal}
          onReorderTerminal={moveTerminal}
          activities={processingSessions}
        />
        <MainContent
          projects={projects}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          terminals={terminals}
          activeTerminalId={activeTerminalId}
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
          onStartNewChat={handleNewSession}
          onProjectSelect={handleProjectSelect}
          onSessionSelect={handleSessionSelect}
          onProjectsRefresh={() => void refreshProjectsSilently()}
          onSessionArchived={removeSessionFromList}
          onSessionRestored={() => void refreshProjectsSilently()}
          attentionSessionIds={attentionSessionIds}
        />
      </div>

      <CommandPalette
        selectedProject={selectedProject}
        onStartNewChat={handleNewSession}
        onOpenSettings={() => openSettings()}
        onShowTab={selectTab}
      />
    </div>
  );
}

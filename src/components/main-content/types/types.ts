import type { Dispatch, SetStateAction } from 'react';

import type { AppTab, Project, ProjectSession } from '../../../types/app';
import type { TerminalTab } from '../../../hooks/useTerminalTabs';
import type {
  MarkSessionIdle,
  MarkSessionProcessing,
  SessionActivityMap,
} from '../../../hooks/useSessionProtection';
import type { SessionEstablishedContext, SessionNavigationOptions } from '../../chat/types/types';
import type { SettingsMainTab } from '../../settings/types/types';

export type TaskMasterTask = {
  id: string | number;
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  details?: string;
  testStrategy?: string;
  parentId?: string | number;
  dependencies?: Array<string | number>;
  subtasks?: TaskMasterTask[];
  [key: string]: unknown;
};

export type TaskReference = {
  id: string | number;
  title?: string;
  [key: string]: unknown;
};

export type TaskSelection = TaskMasterTask | TaskReference;

export type PrdFile = {
  name: string;
  content?: string;
  isExisting?: boolean;
  [key: string]: unknown;
};

export type MainContentProps = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  /** Открытые окна командной строки: живут рядом с чатом, а не вместо него. */
  terminals?: TerminalTab[];
  /** Какое из них сейчас на экране; null — на экране чат или другая панель. */
  activeTerminalId?: string | null;
  /** Whether the TaskMaster "Tasks" workspace tab should be offered — lifted up from MainContent so the sidebar's tab switcher can gate on it too. */
  shouldShowTasksTab: boolean;
  /** Whether the "Browser" workspace tab should be offered — lifted up from MainContent so the sidebar's tab switcher can gate on it too. */
  shouldShowBrowserTab: boolean;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  isMobile: boolean;
  onMenuClick: () => void;
  isLoading: boolean;
  onInputFocusChange: (focused: boolean) => void;
  onSessionProcessing: MarkSessionProcessing;
  onSessionIdle: MarkSessionIdle;
  processingSessions: SessionActivityMap;
  onNavigateToSession: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings: (tab?: SettingsMainTab) => void;
  externalMessageUpdate: number;
  newSessionTrigger: number;
  /** Открыть новый пустой чат в папке — нужен кнопке «Продолжить в новом чате». */
  onStartNewChat?: (project: Project) => void;
  /** Switches the app to another project — used by the git panel's Worktrees view and the empty-state recent projects list. */
  onProjectSelect: (project: Project) => void;
  /** Jumps straight into a specific session — used by the empty-state "continue last chat" shortcut. */
  onSessionSelect: (session: ProjectSession) => void;
  /** Silently re-syncs the sidebar project list after worktree projects change. */
  onProjectsRefresh: () => void;
  /** Чат убран в архив из шапки — убрать его из списка слева. */
  onSessionArchived?: (sessionId: string) => void;
  /** Чат возвращён из архива — список слева перечитать. */
  onSessionRestored?: (sessionId: string) => void;
  /** Чаты, где пришёл ответ, пока их не смотрели, — метка «новый ответ» на главном экране. */
  attentionSessionIds?: ReadonlySet<string>;
};

export type MainContentHeaderProps = {
  activeTab: AppTab;
  /** Имя открытого окна командной строки, если сейчас смотрят на него. */
  terminalTitle?: string | null;
  terminalProjectName?: string | null;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
  isMobile: boolean;
  onMenuClick: () => void;
  onSessionArchived?: (sessionId: string) => void;
  onSessionRestored?: (sessionId: string) => void;
};

export type MainContentStateViewProps = {
  mode: 'loading' | 'empty';
  isMobile: boolean;
  /** Открывает панель слева — у главного экрана это ещё и строка «Все чаты». */
  onMenuClick: () => void;
  /** Все папки с их первыми чатами: из них главный экран берёт последний и недавние чаты. */
  projects: Project[];
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: ProjectSession) => void;
  /** Кнопка «Новый чат» главного экрана. */
  onStartNewChat?: (project: Project) => void;
  /** Метка «работает» у строк чатов. */
  processingSessions?: SessionActivityMap;
  /** Метка «новый ответ» у строк чатов. */
  attentionSessionIds?: ReadonlySet<string>;
};

export type MobileMenuButtonProps = {
  onMenuClick: () => void;
  compact?: boolean;
};

export type TaskMasterPanelProps = {
  isVisible: boolean;
};

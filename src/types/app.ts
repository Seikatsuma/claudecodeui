export type LLMProvider = 'claude' | 'cursor' | 'codex' | 'opencode';

/**
 * Блок верхней панели слева: 'main' — дела этого сервера, 'second' — дела
 * второго сервера (ведутся отсюда, а живут там).
 */
export type ServerScope = 'main' | 'second';

export type ProviderModelOption = {
  value: string;
  label: string;
  description?: string;
  recordId?: number;
  isCustom?: boolean;
  effort?: {
    default?: string;
    values: {
      value: string;
      description?: string;
    }[];
  };
};

export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
};

export type CustomProviderModelInput = {
  model: string;
  id: string;
};

export type ProviderModelActions = {
  create(provider: LLMProvider, input: CustomProviderModelInput): Promise<void>;
  update(
    provider: LLMProvider,
    existing: ProviderModelOption,
    input: CustomProviderModelInput,
  ): Promise<void>;
  remove(provider: LLMProvider, existing: ProviderModelOption): Promise<void>;
};

export type AppTab = 'chat' | 'files' | 'shell' | 'git' | 'tasks' | 'browser' | `plugin:${string}`;

export interface ProjectSession {
  id: string;
  title?: string;
  summary?: string;
  name?: string;
  createdAt?: string;
  created_at?: string;
  updated_at?: string;
  lastActivity?: string;
  messageCount?: number;
  provider?: LLMProvider;
  // Topic group this session was placed in (manual or "Organize by topic"
  // auto-grouping). Absent/null means ungrouped.
  groupId?: string | null;
  groupLabel?: string | null;
  /**
   * Блок верхней панели у самого чата: null/absent — как у папки.
   * Заполнено, когда чат перенесли поимённо («перенести во 2-й сервер»).
   */
  serverScope?: ServerScope | null;
  /** Ярлык-флажок на чате (меню «…»): только метка, на порядок не влияет. */
  flagged?: boolean;
  __provider?: LLMProvider;
  // Tags the session with the owning project's DB `projectId` so UI handlers
  // (session switching, sidebar focus, etc.) can match against selectedProject.
  __projectId?: string;
  [key: string]: unknown;
}

export interface ProjectSessionMeta {
  total?: number;
  hasMore?: boolean;
  [key: string]: unknown;
}

export interface ProjectTaskmasterInfo {
  hasTaskmaster?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

// After the projectName → projectId migration the backend no longer returns a
// folder-derived `name` string. Projects are now addressed everywhere by the
// DB-assigned `projectId` (primary key in the `projects` table), and the UI
// uses the same identifier for routing, state keys and API calls.
export interface Project {
  projectId: string;
  displayName: string;
  fullPath: string;
  path?: string;
  isStarred?: boolean;
  /** Блок верхней панели, которому принадлежит папка ('main' по умолчанию). */
  serverScope?: ServerScope;
  sessions?: ProjectSession[];
  sessionMeta?: ProjectSessionMeta;
  taskmaster?: ProjectTaskmasterInfo;
  [key: string]: unknown;
}

export interface LoadingProgress {
  kind?: 'loading_progress';
  phase?: string;
  current: number;
  total: number;
  currentProject?: string;
  [key: string]: unknown;
}

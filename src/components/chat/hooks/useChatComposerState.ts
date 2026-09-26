import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  SetStateAction,
  TouchEvent,
} from 'react';
import { useDropzone } from 'react-dropzone';

import { authenticatedFetch } from '../../../utils/api';
import type { MarkSessionProcessing, SessionActivityMap } from '../../../hooks/useSessionProtection';
import { grantClaudeToolPermission } from '../utils/chatPermissions';
import { useSessionMessageQueue } from './useSessionMessageQueue';
import {
  safeLocalStorage,
  type QueuedSendOptions,
  adoptLegacyProjectDraft,
  clearDraftInput,
  draftScopeFor,
  readDraftInput,
  writeDraftInput,
} from '../utils/chatStorage';
import { clearAttachmentDraft, stashAttachmentDraft, takeAttachmentDraft } from '../utils/attachmentDrafts';
import type {
  ChatAttachment,
  ChatMessage,
  PendingPermissionRequest,
  PermissionMode,
  SessionEstablishedContext,
} from '../types/types';

import { usePromptPresetsContext } from '../../../contexts/PromptPresetsContext';
import { isTouchKeyboard } from '../../../utils/touchKeyboard';
import type { Project, ProjectSession, LLMProvider, ProviderModelOption } from '../../../types/app';
import { escapeRegExp } from '../utils/chatFormatting';

import { useFileMentions } from './useFileMentions';
import { type SlashCommand, useSlashCommands } from './useSlashCommands';

// Полоска ленты, которая остаётся видимой над полем ввода, и нижний предел
// высоты поля (четыре строки), см. updateComposerRoom.
const COMPOSER_FEED_MIN_PX = 80;
const COMPOSER_ROOM_FLOOR_PX = 96;

/**
 * Выжимка, ждущая открытия нового чата. Вне компонента: переход в новый чат
 * может пересоздать экран, а выжимка должна дожить до него.
 */
let pendingHandoff: { projectId: string; message: string } | null = null;
/** Идёт ли опрос задачи — один на вкладку, даже если экран чата пересоздан. */
let handoffPolling = false;

/** Начатая задача переноса — в браузере, чтобы пережить выгрузку вкладки. */
type HandoffJobRecord = { sessionId: string; projectId: string; startedAt: number };
const HANDOFF_JOB_KEY = 'handoff_job';
/** Сервер хранит задачу 30 минут после конца; дольше ждать нечего. */
const HANDOFF_JOB_MAX_AGE_MS = 30 * 60 * 1000;

function readHandoffJob(): HandoffJobRecord | null {
  try {
    const job = JSON.parse(localStorage.getItem(HANDOFF_JOB_KEY) || 'null') as HandoffJobRecord | null;
    if (!job || typeof job.sessionId !== 'string' || Date.now() - job.startedAt > HANDOFF_JOB_MAX_AGE_MS) return null;
    return job;
  } catch {
    return null;
  }
}

function writeHandoffJob(job: HandoffJobRecord): void {
  try {
    localStorage.setItem(HANDOFF_JOB_KEY, JSON.stringify(job));
  } catch {
    // Нет хранилища — перенос всё равно идёт, только не переживёт выгрузку.
  }
}

function clearHandoffJob(): void {
  try {
    localStorage.removeItem(HANDOFF_JOB_KEY);
  } catch {
    // Нечего убирать.
  }
}

interface UseChatComposerStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  permissionMode: PermissionMode | string;
  cyclePermissionMode: () => void;
  resolvePermissionModeForProvider: (provider: LLMProvider, requestedMode: PermissionMode | string) => PermissionMode;
  /**
   * Model every send and command carries: the open session's model when there
   * is one, otherwise the user's per-provider selection.
   */
  currentProviderModel: string;
  currentProviderEffort: string;
  isLoading: boolean;
  processingSessions?: SessionActivityMap;
  canAbortSession: boolean;
  tokenBudget: Record<string, unknown> | null;
  sendMessage: (message: unknown) => void;
  sendByCtrlEnter?: boolean;
  /** Растёт на каждое нажатие «Новый сеанс»: новый чат всегда открывается с пустым полем. */
  newSessionTrigger?: number;
  /** Открыть новый пустой чат в папке — для «Продолжить в новом чате». */
  onStartNewChat?: (project: Project) => void;
  onSessionProcessing?: MarkSessionProcessing;
  /**
   * Invoked with the freshly allocated session id when the user sends the
   * first message of a brand-new conversation. The backend allocates the id
   * via POST /api/providers/sessions BEFORE the websocket send, so the id is
   * stable for the conversation's whole lifetime — the consumer navigates to
   * /session/:id and records it as the current session.
   */
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  scrollToBottom: () => void;
  addMessage: (msg: ChatMessage) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
}

interface MentionableFile {
  name: string;
  path: string;
}

interface CommandExecutionResult {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
}

export type ModelCommandData = {
  current?: {
    provider?: string;
    providerLabel?: string;
    model?: string;
  };
  available?: Partial<Record<LLMProvider, string[]>>;
  availableModels?: string[];
  availableOptions?: ProviderModelOption[];
  defaultModel?: string;
};

export type CostCommandData = {
  tokenUsage?: {
    used?: number;
    total?: number;
    contextUsed?: number;
    contextPercent?: number;
  };
  tokenBreakdown?: {
    input?: number;
    output?: number;
  };
  provider?: string;
  model?: string;
};

export type StatusCommandData = {
  version?: string;
  packageName?: string;
  uptime?: string;
  model?: string;
  provider?: string;
  nodeVersion?: string;
  platform?: string;
  pid?: number;
  memoryUsage?: {
    rssMb?: number;
    heapUsedMb?: number;
    heapTotalMb?: number;
  };
};

export type HelpCommandData = {
  content?: string;
  format?: string;
  commands?: Array<{
    name: string;
    description?: string;
    namespace?: string;
  }>;
};

export type CommandModalKind = 'help' | 'models' | 'cost' | 'status';

export type CommandModalPayload = {
  kind: CommandModalKind;
  data: HelpCommandData | ModelCommandData | CostCommandData | StatusCommandData;
};

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

const MAX_ATTACHMENT_COUNT = 10;
/** Сколько держать засов отправки, если запуск так и не начался (обрыв, отказ сервера). */
const SUBMIT_LOCK_FAILSAFE_MS = 20_000;
// Потолок на одно вложение. 10 МБ отсекали ровно тот случай, ради которого
// вложения и нужны: скриншот экрана 2560x1440 весит около 11 МБ, и человек
// получал отказ на самом обычном действии. Сервер принимает до 50 МБ
// (ASSETS_MAX_ATTACHMENT_BYTES), так что 25 МБ — с запасом и там, и там.
const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;
const MAX_ATTACHMENT_SIZE_MB = Math.round(MAX_ATTACHMENT_SIZE / (1024 * 1024));

const isImageAttachment = (attachment: ChatAttachment) => {
  if (attachment.mimeType?.startsWith('image/')) return true;
  return /\.(gif|jpe?g|png|svg|webp)$/i.test(attachment.path || attachment.name || '');
};

const uploadAttachmentFiles = async (files: File[]): Promise<unknown[]> => {
  if (files.length === 0) {
    return [];
  }

  const formData = new FormData();
  files.forEach((file) => {
    formData.append('files', file);
  });

  const response = await authenticatedFetch('/api/assets/files', {
    method: 'POST',
    headers: {},
    body: formData,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || 'Failed to upload files');
  }

  const result = await response.json();
  if (!Array.isArray(result.attachments) || result.attachments.length !== files.length) {
    throw new Error('File upload returned an incomplete result');
  }
  return result.attachments;
};

export type QueuedDraft = {
  /** Устойчивый ключ строки: по нему очередь двигают, правят и удаляют. */
  id: string;
  content: string;
  /** Browser files retained while this composer stays mounted, for editing. */
  attachments: File[];
  /** JSON-safe descriptors uploaded when the message is queued. */
  uploadedAttachments?: unknown[];
  /**
   * Send options snapshotted at queue time. Persisted with the draft so the
   * app-level auto-send can dispatch the message with the right model and
   * permission settings while another session is being viewed.
   */
  options?: QueuedSendOptions;
};

const newDraftId = (): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Небезопасный контекст (http://) — randomUUID недоступен.
  }
  return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

const getNotificationSessionSummary = (
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null => {
  const sessionSummary = selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    const normalized = sessionSummary.replace(/\s+/g, ' ').trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return normalizedFallback.length > 80 ? `${normalizedFallback.slice(0, 77)}...` : normalizedFallback;
};

export function useChatComposerState({
  selectedProject,
  selectedSession,
  currentSessionId,
  provider,
  permissionMode,
  cyclePermissionMode,
  resolvePermissionModeForProvider,
  currentProviderModel,
  currentProviderEffort,
  isLoading,
  processingSessions,
  canAbortSession,
  tokenBudget,
  sendMessage,
  sendByCtrlEnter,
  newSessionTrigger,
  onStartNewChat,
  onSessionProcessing,
  onSessionEstablished,
  onInputFocusChange,
  onFileOpen,
  onShowSettings,
  scrollToBottom,
  addMessage,
  setIsUserScrolledUp,
  setPendingPermissionRequests,
}: UseChatComposerStateArgs) {
  const [input, setInput] = useState(() => {
    if (typeof window === 'undefined') {
      return '';
    }
    // Черновик принадлежит чату, а не проекту — см. draftScopeFor в chatStorage.
    const initialScope = draftScopeFor(selectedProject?.projectId, selectedSession?.id || currentSessionId || null);
    adoptLegacyProjectDraft(selectedProject?.projectId, initialScope);
    return readDraftInput(initialScope);
  });
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  // Для подмены черновика при смене чата: эффект подмены не должен зависеть
  // от самих файлов, иначе он срабатывал бы на каждое добавление картинки.
  const attachedFilesRef = useRef(attachedFiles);
  attachedFilesRef.current = attachedFiles;
  const [uploadingFiles, setUploadingFiles] = useState<Map<string, number>>(new Map());
  const [fileErrors, setFileErrors] = useState<Map<string, string>>(new Map());
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [commandModalPayload, setCommandModalPayload] = useState<CommandModalPayload | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const textareaLineHeightRef = useRef<number | null>(null);
  const lastAutosizedInputRef = useRef<string | null>(null);
  const handleSubmitRef = useRef<
    ((
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
    ) => Promise<void>) | null
  >(null);
  const inputValueRef = useRef(input);
  const selectedProjectId = selectedProject?.projectId;
  // Prefer the stable backend-allocated id (selectedSession.id) but fall back
  // to currentSessionId for a just-established session that hasn't been
  // handed back to the parent's `selectedSession` prop yet.
  const sessionKey = selectedSession?.id || currentSessionId || null;
  const sessionKeyRef = useRef(sessionKey);
  const processingSessionsRef = useRef<SessionActivityMap | undefined>(processingSessions);
  sessionKeyRef.current = sessionKey;
  processingSessionsRef.current = processingSessions;
  // Чей черновик сейчас в поле. `draftScopeRef` — какой чат открыт в эту
  // минуту (нужен отправке, которая заканчивается после паузы на загрузку);
  // `draftOwnerRef` — какому чату принадлежит текст, лежащий в `input`.
  const draftScope = draftScopeFor(selectedProjectId, sessionKey);
  const draftScopeRef = useRef(draftScope);
  draftScopeRef.current = draftScope;
  const draftOwnerRef = useRef<string | null>(draftScope);

  // Очередь целиком, по порядку отправки. Первый элемент уйдёт следующим.
  /*
   * Очередь берётся с СЕРВЕРА и там же живёт.
   *
   * Раньше она лежала в localStorage вкладки, и отправляла её сама страница —
   * поэтому при закрытом сайте следующее сообщение не уходило (Егор 20.09.26).
   * Теперь вкладка очередь только показывает и правит, а снимает и запускает
   * её сервер по концу хода (server/.../chat-queue.service.ts).
   */
  const { queue: serverQueue, removeQueued, reorderQueued, clearQueued, sendNowQueued } = useSessionMessageQueue(sessionKey);
  // Браузерные File-объекты сообщений, поставленных в очередь В ЭТОЙ вкладке.
  // Нужны только для правки: вернуть сообщение в поле вместе с картинкой.
  // На другом устройстве их нет — там правка опирается на уже загруженные
  // вложения (`uploadedAttachments`), и снимок всё равно не теряется.
  const queuedFilesRef = useRef<Map<string, File[]>>(new Map());
  // Уже загруженные вложения сообщения, которое взяли из очереди обратно в
  // поле ввода. File-объектов может не быть (очередь пришла с другого
  // устройства) — тогда при отправке уходят эти описания, и снимок не теряется.
  const carriedUploadedRef = useRef<unknown[]>([]);
  const queuedDrafts = useMemo<QueuedDraft[]>(
    () => serverQueue.map((item) => ({
      id: item.id,
      content: item.content,
      attachments: queuedFilesRef.current.get(item.id) ?? [],
      uploadedAttachments: Array.isArray(item.attachments) ? item.attachments : [],
    })),
    [serverQueue],
  );

  const handleBuiltInCommand = useCallback(
    (result: CommandExecutionResult) => {
      const { action, data } = result;
      switch (action) {
        case 'help':
          setCommandModalPayload({
            kind: 'help',
            data: (data || {}) as HelpCommandData,
          });
          break;

        case 'models':
          setCommandModalPayload({
            kind: 'models',
            data: (data || {}) as ModelCommandData,
          });
          break;

        case 'cost': {
          setCommandModalPayload({
            kind: 'cost',
            data: (data || {}) as CostCommandData,
          });
          break;
        }

        case 'status': {
          setCommandModalPayload({
            kind: 'status',
            data: (data || {}) as StatusCommandData,
          });
          break;
        }

        case 'memory':
          if (data.error) {
            addMessage({
              type: 'assistant',
              content: `Warning: ${data.message}`,
              timestamp: Date.now(),
            });
          } else {
            addMessage({
              type: 'assistant',
              content: `${data.message}\n\nPath: \`${data.path}\``,
              timestamp: Date.now(),
            });
            if (data.exists && onFileOpen) {
              onFileOpen(data.path);
            }
          }
          break;

        case 'config':
          onShowSettings?.();
          break;

        default:
          console.warn('Unknown built-in command action:', action);
      }
    },
    [onFileOpen, onShowSettings, addMessage],
  );

  const closeCommandModal = useCallback(() => {
    setCommandModalPayload(null);
  }, []);

  const handleCustomCommand = useCallback(async (result: CommandExecutionResult) => {
    const { content, hasBashCommands } = result;

    if (hasBashCommands) {
      const confirmed = window.confirm(
        'This command contains bash commands that will be executed. Do you want to proceed?',
      );
      if (!confirmed) {
        addMessage({
          type: 'assistant',
          content: 'Command execution cancelled',
          timestamp: Date.now(),
        });
        return;
      }
    }

    const commandContent = content || '';
    setInput(commandContent);
    inputValueRef.current = commandContent;

    // Defer submit to next tick so the command text is reflected in UI before dispatching.
    setTimeout(() => {
      if (handleSubmitRef.current) {
        handleSubmitRef.current(createFakeSubmitEvent());
      }
    }, 0);
  }, [addMessage]);

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string, options?: { preserveInput?: boolean }) => {
      if (!command || !selectedProject) {
        return;
      }

      try {
        const effectiveInput = rawInput ?? input;
        const commandMatch = effectiveInput.match(new RegExp(`${escapeRegExp(command.name)}\\s*(.*)`));
        const args =
          commandMatch && commandMatch[1] ? commandMatch[1].trim().split(/\s+/) : [];

        // The `/api/commands/execute` context sends `projectId` now instead of
        // a folder-derived project name; the path is still included verbatim.
        const context = {
          projectPath: selectedProject.fullPath || selectedProject.path,
          projectId: selectedProject.projectId,
          sessionId: currentSessionId || selectedSession?.id || null,
          provider,
          model: currentProviderModel,
          tokenUsage: tokenBudget,
        };

        const response = await authenticatedFetch('/api/commands/execute', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            commandName: command.name,
            commandPath: command.path,
            args,
            context,
          }),
        });

        if (!response.ok) {
          let errorMessage = `Failed to execute command (${response.status})`;
          try {
            const errorData = await response.json();
            errorMessage = errorData?.message || errorData?.error || errorMessage;
          } catch {
            // Ignore JSON parse failures and use fallback message.
          }
          throw new Error(errorMessage);
        }

        const result = (await response.json()) as CommandExecutionResult;
        if (result.type === 'builtin') {
          handleBuiltInCommand(result);
          if (!options?.preserveInput) {
            setInput('');
            inputValueRef.current = '';
          }
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error executing command:', error);
        addMessage({
          type: 'assistant',
          content: `Error executing command: ${message}`,
          timestamp: Date.now(),
        });
      }
    },
    [
      currentProviderModel,
      currentSessionId,
      handleBuiltInCommand,
      handleCustomCommand,
      input,
      provider,
      selectedProject,
      selectedSession?.id,
      addMessage,
      tokenBudget,
    ],
  );

  const showCostModal = useCallback(() => {
    executeCommand(
      {
        name: '/cost',
        description: 'Display token usage information',
        namespace: 'builtin',
        metadata: { type: 'builtin' },
      } as SlashCommand,
      '/cost',
      { preserveInput: true },
    );
  }, [executeCommand]);

  const {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    provider,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommand,
  });

  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input,
    setInput,
    textareaRef,
  });

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) {
      return;
    }
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  // Сколько поле ввода может занять, не выдавив карточку за край экрана.
  //
  // Лента и карточка поля делят один столбец: лента забирает остаток. Поэтому
  // «лента + поле» не зависит от того, что ещё стоит в карточке — превью
  // фотографии, очередь, запрос разрешения, — и предел поля = эта сумма минус
  // полоска ленты, которую оставляем видимой. Фиксированный запас (250 точек,
  // 17.09) не знал про превью фото: с ним карточка снова уходила под
  // клавиатуру, и последние слова было не достать (снимок Егора 19.09.26).
  // Мерить до сброса высоты — в согласованном состоянии раскладки.
  const updateComposerRoom = useCallback((target: HTMLTextAreaElement) => {
    let node: HTMLElement | null = target.parentElement;
    let pane: HTMLElement | null = null;
    for (let depth = 0; node && depth < 8 && !pane; depth += 1) {
      pane = node.querySelector<HTMLElement>('.chat-messages-pane');
      node = node.parentElement;
    }
    if (!pane) return;
    const room = pane.clientHeight + target.offsetHeight - COMPOSER_FEED_MIN_PX;
    target.style.setProperty('--composer-room', `${Math.max(COMPOSER_ROOM_FLOOR_PX, Math.round(room))}px`);
  }, []);

  const resizeTextarea = useCallback((target: HTMLTextAreaElement) => {
    updateComposerRoom(target);
    target.style.height = 'auto';
    const nextHeight = Math.max(22, target.scrollHeight);
    target.style.height = `${nextHeight}px`;

    let lineHeight = textareaLineHeightRef.current;
    if (!lineHeight) {
      lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      textareaLineHeightRef.current = Number.isFinite(lineHeight) ? lineHeight : 24;
    }

    const expanded = nextHeight > (textareaLineHeightRef.current || 24) * 2;
    setIsTextareaExpanded((previous) => previous === expanded ? previous : expanded);
    lastAutosizedInputRef.current = target.value;
    // Курсор в конце текста — держать конец видимым: после смены предела
    // высоты поле иначе остаётся прокрученным на прежнее место.
    if (target.selectionStart === target.value.length && target.scrollHeight > target.clientHeight) {
      target.scrollTop = target.scrollHeight;
    }
  }, [updateComposerRoom]);

  // Место меняется не только от набора: открылась клавиатура, добавилось
  // фото, пришла очередь или запрос разрешения — лента меняет высоту. Следим
  // за ней и пересчитываем предел; цикла нет: поле ужалось — лента выросла
  // ровно на столько же, сумма и предел те же.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === 'undefined') return;
    let node: HTMLElement | null = textarea.parentElement;
    let pane: HTMLElement | null = null;
    for (let depth = 0; node && depth < 8 && !pane; depth += 1) {
      pane = node.querySelector<HTMLElement>('.chat-messages-pane');
      node = node.parentElement;
    }
    if (!pane) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const current = textareaRef.current;
        if (!current) return;
        updateComposerRoom(current);
        if (current.selectionStart === current.value.length && current.scrollHeight > current.clientHeight) {
          current.scrollTop = current.scrollHeight;
        }
      });
    });
    observer.observe(pane);
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [selectedSession?.id, updateComposerRoom]);

  const handleAttachmentFiles = useCallback(async (files: File[]) => {
    const accepted: File[] = [];

    for (const file of files) {
      try {
        if (!file || typeof file !== 'object') {
          console.warn('Invalid file object:', file);
          continue;
        }

        if (file.size > MAX_ATTACHMENT_SIZE) {
          const fileName = file.name || 'Unknown file';
          setFileErrors((previous) => {
            const next = new Map(previous);
            next.set(fileName, `Файл слишком большой (максимум ${MAX_ATTACHMENT_SIZE_MB} МБ)`);
            return next;
          });
          continue;
        }

        // Байты снимаются ЗДЕСЬ, при добавлении, а не при отправке.
        //
        // Дропнутый или выбранный скрепкой File — это лишь ссылка на файл на
        // диске, и она может протухнуть до отправки: скриншот, перетащенный из
        // всплывающей миниатюры системного скриншотера, живёт во временном
        // файле, который система удаляет через считанные секунды. Тогда
        // FormData отдаёт оборванный поток, и сервер отвечает «Unexpected end
        // of form» — сообщение, по которому невозможно догадаться, что файла
        // просто уже нет. Вставка из буфера этим не страдала: там данные
        // изначально в памяти, поэтому она и работала, когда перетаскивание
        // не работало.
        const snapshot = new File([await file.arrayBuffer()], file.name || 'file', {
          type: file.type,
          lastModified: file.lastModified,
        });
        accepted.push(snapshot);
      } catch (error) {
        console.error('Не удалось прочитать вложение:', error, file);
        const fileName = file?.name || 'Unknown file';
        setFileErrors((previous) => {
          const next = new Map(previous);
          next.set(fileName, 'Не удалось прочитать файл — перетащите его ещё раз');
          return next;
        });
      }
    }

    if (accepted.length > 0) {
      setAttachedFiles((previous) => [...previous, ...accepted].slice(0, MAX_ATTACHMENT_COUNT));
    }
  }, []);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);

      items.forEach((item) => {
        if (!item.type.startsWith('image/')) {
          return;
        }
        const file = item.getAsFile();
        if (file) {
          handleAttachmentFiles([file]);
        }
      });

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        const files = Array.from(event.clipboardData.files);
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        if (imageFiles.length > 0) {
          handleAttachmentFiles(imageFiles);
        }
      }
    },
    [handleAttachmentFiles],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    maxSize: MAX_ATTACHMENT_SIZE,
    maxFiles: MAX_ATTACHMENT_COUNT,
    onDrop: handleAttachmentFiles,
    noClick: true,
    noKeyboard: true,
  });

  // Snapshot of everything `chat.send` needs beyond the text itself. Built at
  // send time for immediate sends and at queue time for queued ones, so a
  // queued message keeps the provider settings it was composed under even if
  // it is later dispatched outside this composer (app-level auto-send).
  const { activePreset } = usePromptPresetsContext();

  const buildSendOptions = useCallback((currentInput: string): QueuedSendOptions => {
    const getToolsSettings = () => {
      try {
        const settingsKey =
          provider === 'cursor'
            ? 'cursor-tools-settings'
            : provider === 'codex'
              ? 'codex-settings'
              : provider === 'opencode'
                  ? 'opencode-settings'
                : 'claude-settings';
        const savedSettings = safeLocalStorage.getItem(settingsKey);
        if (savedSettings) {
          return JSON.parse(savedSettings);
        }
      } catch (error) {
        console.error('Error loading tools settings:', error);
      }

      return {
        allowedTools: [],
        disallowedTools: [],
        skipPermissions: false,
      };
    };

    const toolsSettings = getToolsSettings();

    return {
      model: currentProviderModel,
      effort: currentProviderEffort,
      permissionMode: resolvePermissionModeForProvider(provider, permissionMode),
      toolsSettings,
      skipPermissions: toolsSettings?.skipPermissions || false,
      sessionSummary: getNotificationSessionSummary(selectedSession, currentInput),
      // Активный пресет прилетает на сервер как надстройка над системным
      // промптом Claude Code — заменять базовый нельзя, иначе агент теряет
      // протокол работы с инструментами. Пустое = как раньше.
      presetSystemPrompt: activePreset?.systemPrompt ?? undefined,
    };
  }, [
    activePreset,
    currentProviderEffort,
    currentProviderModel,
    permissionMode,
    provider,
    resolvePermissionModeForProvider,
    selectedSession,
  ]);

  /*
    Засов от повторной отправки.

    Единственным барьером был флаг isLoading, но это состояние React: оно
    поднимается только когда сервер подтвердил запуск. Между нажатием и этим
    моментом второе нажатие проходило насквозь, и сервер отвечал «в этой
    сессии уже идёт запуск», а в ленте оставались два одинаковых сообщения.
    Зазор особенно широк при вложениях: отправка ждёт загрузки файла, и на
    многомегабайтном скриншоте это заметные секунды.

    Ref, а не state: он меняется синхронно, прямо в обработчике, поэтому
    второй вызов видит засов сразу, не дожидаясь перерисовки.
  */
  const submitInFlightRef = useRef(false);
  const sendNowRequestedRef = useRef(false);
  const submitLockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const releaseSubmitLock = useCallback(() => {
    submitInFlightRef.current = false;
    if (submitLockTimerRef.current) {
      clearTimeout(submitLockTimerRef.current);
      submitLockTimerRef.current = null;
    }
  }, []);

  // Засов снимается, когда запуск действительно начался. Таймер — страховка:
  // если отправка не дошла (обрыв связи, отказ сервера), поле ввода не должно
  // остаться заблокированным навсегда.
  useEffect(() => {
    if (isLoading) releaseSubmitLock();
  }, [isLoading, releaseSubmitLock]);

  useEffect(() => releaseSubmitLock, [releaseSubmitLock]);

  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
    ) => {
      event.preventDefault();
      // Снимаем сразу: признак относится только к этому нажатию, даже если
      // отправка ниже не состоится (пустое поле).
      const sendNow = sendNowRequestedRef.current;
      sendNowRequestedRef.current = false;
      const currentInput = inputValueRef.current;
      // Черновик какого чата отправляется: пока грузятся вложения, человек может
      // открыть другой чат, и стирать надо текст исходного, а не того, что на экране.
      const submitDraftScope = draftScopeRef.current;
      const currentAttachments = attachedFiles;
      const previouslyUploadedAttachments = carriedUploadedRef.current;
      if (
        (
          !currentInput.trim()
          && currentAttachments.length === 0
          && previouslyUploadedAttachments.length === 0
        )
        || !selectedProject
      ) {
        return;
      }

      /*
       * Ход ещё идёт — сообщение уходит на сервер и встаёт в очередь ТАМ.
       *
       * Раньше оно оставалось в localStorage вкладки, и отправляла его сама
       * страница, заметив конец хода. Пока сайт закрыт, замечать некому, и
       * сообщение ждало входа человека на сайт (Егор 20.09.26). Теперь сервер
       * кладёт его в очередь сам и сам же отправляет по концу хода.
       */
      if (isLoading) {
        const queuedSessionKey = sessionKey;
        if (!queuedSessionKey) {
          return;
        }

        // Вложения загружаем сейчас: в очереди должны лежать долговечные
        // описания файлов, а не браузерные объекты этой вкладки.
        let uploadedAttachments: unknown[] = previouslyUploadedAttachments;
        if (uploadedAttachments.length === 0 && currentAttachments.length > 0) {
          try {
            uploadedAttachments = await uploadAttachmentFiles(currentAttachments);
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.error('Queued file upload failed:', error);
            addMessage({
              type: 'error',
              content: `Failed to upload files: ${message}`,
              timestamp: new Date(),
            });
            return;
          }
        }

        // Номер сообщения придумываем здесь: он же становится ключом строки в
        // серверной очереди (и защитой от двойной постановки при досылке), и
        // по нему вкладка узнаёт свои File-объекты при правке.
        const queuedMessageId = newDraftId();
        queuedFilesRef.current.set(queuedMessageId, currentAttachments);
        // Ctrl/Cmd+Enter — «отправить сейчас»: сервер передаст сообщение в
        // идущий ход; не выйдет — положит в очередь, как обычное.
        sendMessage({
          type: 'chat.send',
          clientMessageId: queuedMessageId,
          sessionId: queuedSessionKey,
          ...(sendNow ? { sendNow: true } : {}),
          content: currentInput,
          options: {
            ...buildSendOptions(currentInput),
            attachments: uploadedAttachments,
          },
        });

        clearDraftInput(submitDraftScope);
        // Пока грузились вложения, человек мог открыть другой чат — тогда в
        // поле уже ЕГО черновик, и стирать надо спрятанный черновик исходного.
        if (draftScopeRef.current !== submitDraftScope) {
          clearAttachmentDraft(submitDraftScope);
          return;
        }
        setInput('');
        inputValueRef.current = '';
        setAttachedFiles([]);
        carriedUploadedRef.current = [];
        setUploadingFiles(new Map());
        setFileErrors(new Map());
        resetCommandMenuState();
        setIsTextareaExpanded(false);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        return;
      }

      // Intercept slash commands only when "/" is the first input character.
      // Also accept exact "help" as a convenience alias for users who expect CLI-style help.
      const commandInput = currentInput.trimEnd();
      const isHelpAlias = commandInput.trim().toLowerCase() === 'help';
      if (commandInput.startsWith('/') || isHelpAlias) {
        const firstSpace = commandInput.indexOf(' ');
        const commandName = isHelpAlias
          ? '/help'
          : firstSpace > 0 ? commandInput.slice(0, firstSpace) : commandInput;
        const matchedCommand =
          slashCommands.find((cmd: SlashCommand) => cmd.name === commandName) ||
          (commandName === '/help'
            ? ({
                name: '/help',
                description: 'Show help documentation for Claude Code',
                namespace: 'builtin',
                metadata: { type: 'builtin' },
              } as SlashCommand)
            : undefined);
        if (matchedCommand && matchedCommand.type !== 'skill') {
          executeCommand(matchedCommand, isHelpAlias ? '/help' : commandInput);
          setInput('');
          inputValueRef.current = '';
          setAttachedFiles([]);
          setUploadingFiles(new Map());
          setFileErrors(new Map());
          resetCommandMenuState();
          setIsTextareaExpanded(false);
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
          return;
        }
      }

      // Засов берётся здесь, а не выше: пока идёт ответ, сообщения кладутся в
      // очередь, и копить их подряд — нормально. Охранять нужно только
      // настоящую отправку.
      if (submitInFlightRef.current) {
        return;
      }
      submitInFlightRef.current = true;
      if (submitLockTimerRef.current) clearTimeout(submitLockTimerRef.current);
      submitLockTimerRef.current = setTimeout(releaseSubmitLock, SUBMIT_LOCK_FAILSAFE_MS);

      const messageContent = currentInput;

      let uploadedAttachments = previouslyUploadedAttachments;
      if (uploadedAttachments.length === 0 && currentAttachments.length > 0) {
        try {
          uploadedAttachments = await uploadAttachmentFiles(currentAttachments);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('File upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload files: ${message}`,
            timestamp: new Date(),
          });
          return;
        }
      }

      const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
      const sessionSummary = getNotificationSessionSummary(selectedSession, currentInput);

      // The conversation always has a stable backend-allocated session id
      // BEFORE the first websocket send: brand-new chats allocate one here
      // via the session gateway. There is no client-visible session-id
      // handoff later — this id stays valid for the conversation's lifetime.
      let targetSessionId = selectedSession?.id || currentSessionId || null;
      if (!targetSessionId) {
        let createdSessionName = sessionSummary;
        try {
          const response = await authenticatedFetch('/api/providers/sessions', {
            method: 'POST',
            body: JSON.stringify({
              provider,
              projectPath: resolvedProjectPath,
              initialMessage: messageContent,
            }),
          });
          if (!response.ok) {
            throw new Error(`Failed to create session (${response.status})`);
          }
          const body = await response.json();
          targetSessionId = body?.data?.sessionId || null;
          // A blank server name would leave the session unlabeled, so the local
          // summary stays the fallback unless a real name comes back.
          const returnedSessionName = typeof body?.data?.sessionName === 'string'
            ? body.data.sessionName.trim()
            : '';
          if (returnedSessionName) {
            createdSessionName = returnedSessionName;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Session creation failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to start a new session: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        if (!targetSessionId) {
          addMessage({
            type: 'error',
            content: 'Failed to start a new session: no session id returned.',
            timestamp: new Date(),
          });
          return;
        }

        onSessionEstablished?.(targetSessionId, {
          provider,
          project: selectedProject,
          summary: createdSessionName,
        });
      }

      const attachmentRecords = uploadedAttachments as ChatAttachment[];
      const userMessage: ChatMessage = {
        type: 'user',
        content: currentInput,
        images: attachmentRecords.filter(isImageAttachment),
        files: attachmentRecords.filter((attachment) => !isImageAttachment(attachment)),
        timestamp: new Date(),
      };

      addMessage(userMessage);
      // Mark this request as processing in the per-session activity map (the
      // single source of truth the indicator derives from). The id is always
      // concrete at this point — no pending placeholder exists anymore.
      onSessionProcessing?.(targetSessionId, {
        statusText: null,
        // Явный этап «запускаю»: подпись «ожидает» остаётся для чатов, про
        // которые известно лишь «занят» (фоновые вкладки, после перезапуска).
        phase: 'starting',
        detail: null,
        canInterrupt: true,
      });

      setIsUserScrolledUp(false);
      setTimeout(() => scrollToBottom(), 100);

      // One message shape for every provider. The backend resolves the
      // provider, project path, and provider-native resume id from the
      // session row; `options` only carries composer-level preferences.
      sendMessage({
        type: 'chat.send',
        sessionId: targetSessionId,
        content: messageContent,
        options: {
          ...buildSendOptions(messageContent),
          attachments: uploadedAttachments,
        },
      });

      clearDraftInput(submitDraftScope);
      // Поле очищается, только если человек всё ещё в том чате, откуда
      // отправил. Новый чат к этому моменту уже получил свой id — это тот же
      // чат, поэтому сверяется и он.
      const stillInSubmittedChat = draftScopeRef.current === submitDraftScope
        || draftScopeRef.current === targetSessionId;
      if (stillInSubmittedChat) {
        setInput('');
        inputValueRef.current = '';
        setIsTextareaExpanded(false);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        // Вложения — как текст: чистим поле, только если оно всё ещё того чата.
        setAttachedFiles([]);
        carriedUploadedRef.current = [];
        setUploadingFiles(new Map());
        setFileErrors(new Map());
      } else {
        clearAttachmentDraft(submitDraftScope);
      }
      resetCommandMenuState();
    },
    [
      selectedSession,
      attachedFiles,
      buildSendOptions,
      currentSessionId,
      executeCommand,
      isLoading,
      onSessionProcessing,
      onSessionEstablished,
      provider,
      resetCommandMenuState,
      scrollToBottom,
      selectedProject,
      sendMessage,
      sessionKey,
      addMessage,
      setIsUserScrolledUp,
      slashCommands,
    ],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  /*
   * Слив очереди страницей убран.
   *
   * Кто отправляет следующее сообщение — теперь решает сервер по концу хода
   * (server/modules/websocket/services/chat-queue.service.ts). Вкладке это
   * знать не нужно, и именно её участие делало очередь зависимой от того,
   * открыт ли сайт.
   */

  // Взять сообщение из очереди обратно в поле ввода. Текст, уже набранный в
  // поле, не выбрасывается: он тут же встаёт в очередь сам — иначе правка
  // второго сообщения стирала бы третье, набранное рядом.
  const editQueuedDraft = useCallback((id: string) => {
    const target = queuedDrafts.find((item) => item.id === id);
    if (!target) {
      return;
    }
    const carried = inputValueRef.current;
    const carriedFiles = attachedFiles;
    const carriedUploaded = carriedUploadedRef.current;

    removeQueued(id);
    queuedFilesRef.current.delete(id);

    if (carried.trim() || carriedFiles.length > 0 || carriedUploaded.length > 0) {
      const carriedId = newDraftId();
      // Чат фиксируем до загрузки: за время загрузки человек может открыть другой.
      const carriedSessionId = sessionKeyRef.current;
      queuedFilesRef.current.set(carriedId, carriedFiles);
      void (async () => {
        let uploaded: unknown[] = carriedUploaded;
        if (uploaded.length === 0 && carriedFiles.length > 0) {
          try {
            uploaded = await uploadAttachmentFiles(carriedFiles);
          } catch (error) {
            console.error('Queued file upload failed:', error);
            return;
          }
        }
        sendMessage({
          type: 'chat.send',
          clientMessageId: carriedId,
          sessionId: carriedSessionId,
          content: carried,
          options: { ...buildSendOptions(carried), attachments: uploaded },
        });
      })();
    }

    // Вложения правимого сообщения не теряются: свои File-объекты вернутся в
    // поле, чужие (поставленные с другого устройства) уйдут теми же
    // загруженными описаниями при следующей отправке.
    carriedUploadedRef.current = target.uploadedAttachments ?? [];
    setInput(target.content);
    inputValueRef.current = target.content;
    setAttachedFiles(target.attachments);
    textareaRef.current?.focus();
  }, [attachedFiles, buildSendOptions, queuedDrafts, removeQueued, sendMessage, setInput]);

  const deleteQueuedDraft = useCallback((id: string) => {
    queuedFilesRef.current.delete(id);
    removeQueued(id);
  }, [removeQueued]);

  const sendNowQueuedDraft = useCallback((id: string) => {
    queuedFilesRef.current.delete(id);
    sendNowQueued(id);
  }, [sendNowQueued]);

  // Перенос на одну позицию. Стрелки, а не перетаскивание: очередь живёт на
  // телефоне, внутри прокручиваемой ленты, и палец в такой драг не попадает.
  // Порядок хранит сервер — отправляем ему новый список целиком.
  const moveQueuedDraft = useCallback((id: string, direction: -1 | 1) => {
    const ids = queuedDrafts.map((item) => item.id);
    const index = ids.indexOf(id);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= ids.length) {
      return;
    }
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorderQueued(ids);
  }, [queuedDrafts, reorderQueued]);

  const clearQueuedDrafts = useCallback(() => {
    queuedFilesRef.current.clear();
    clearQueued();
  }, [clearQueued]);

  // A voice transcript either fills the input (to edit before sending) or, when the
  // user tapped "stop and send", is submitted straight away. Mirror the value into
  // inputValueRef synchronously so handleSubmit reads the new text, not the stale state.
  const handleVoiceTranscript = useCallback((text: string, send?: boolean) => {
    const base = inputValueRef.current.trim();
    const next = base ? `${base} ${text}` : text;
    setInput(next);
    inputValueRef.current = next;
    if (send) handleSubmitRef.current?.(createFakeSubmitEvent());
  }, [setInput]);

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  // «Новый сеанс» — всегда пустое поле.
  //
  // У нового чата до первой отправки нет id, и его черновик живёт в области
  // проекта. Если набрать текст в новом чате и нажать «Новый сеанс» ещё раз,
  // область не меняется и подмена не срабатывает — текст оставался в поле
  // «якобы нового» чата. Нажатие — прямое намерение начать с чистого листа,
  // поэтому черновик нового чата этого проекта стирается, а поле очищается,
  // если сейчас открыт именно новый чат. Если открыт обычный чат, поле не
  // трогаем: подмена ниже сама загрузит пустой черновик, когда откроется новый.
  const lastNewSessionTriggerRef = useRef(newSessionTrigger ?? 0);
  useEffect(() => {
    const trigger = newSessionTrigger ?? 0;
    if (trigger === lastNewSessionTriggerRef.current) {
      return;
    }
    lastNewSessionTriggerRef.current = trigger;
    const newChatScope = draftScopeFor(selectedProjectId, null);
    clearDraftInput(newChatScope);
    clearAttachmentDraft(newChatScope);
    if (draftOwnerRef.current === newChatScope) {
      inputValueRef.current = '';
      setInput('');
      setAttachedFiles([]);
      carriedUploadedRef.current = [];
    }
  }, [newSessionTrigger, selectedProjectId]);

  // Сохранение черновика стоит ВЫШЕ подмены. При переключении чата есть один
  // кадр, где область уже новая, а в `input` ещё текст старого чата: сверка с
  // владельцем пропускает этот кадр, иначе текст чата А записался бы в чат Б.
  // Та же ловушка и то же решение, что у черновика «в очереди» ниже.
  useEffect(() => {
    if (!draftScope || draftOwnerRef.current !== draftScope) {
      return;
    }
    writeDraftInput(draftScope, input);
  }, [input, draftScope]);

  // Поле ввода пересоздали (например, ошибка перерисовала чат) — вложения
  // открытого чата не теряются: при уходе прячутся, при появлении возвращаются.
  useEffect(() => {
    const restored = takeAttachmentDraft(draftOwnerRef.current);
    if (restored.files.length > 0 || restored.uploaded.length > 0) {
      setAttachedFiles(restored.files);
      attachedFilesRef.current = restored.files;
      carriedUploadedRef.current = restored.uploaded;
    }
    return () => {
      stashAttachmentDraft(draftOwnerRef.current, {
        files: attachedFilesRef.current,
        uploaded: carriedUploadedRef.current,
      });
    };
  }, []);

  // Открыли другой чат — в поле его собственный черновик, а не текст прошлого.
  // Егор 13.09.26: «переключаясь на другой чат, панель должна быть без текста,
  // а если возвращаюсь обратно — старый текст остаётся».
  useEffect(() => {
    if (draftOwnerRef.current === draftScope) {
      return;
    }
    // Картинки прошлого чата уходят вместе с его текстом и вернутся, когда
    // человек откроет тот чат снова (Егор 24.09.26) — см. attachmentDrafts.
    stashAttachmentDraft(draftOwnerRef.current, {
      files: attachedFilesRef.current,
      uploaded: carriedUploadedRef.current,
    });
    draftOwnerRef.current = draftScope;
    adoptLegacyProjectDraft(selectedProjectId, draftScope);
    const saved = readDraftInput(draftScope);
    inputValueRef.current = saved;
    setInput(saved);
    const savedAttachments = takeAttachmentDraft(draftScope);
    setAttachedFiles(savedAttachments.files);
    carriedUploadedRef.current = savedAttachments.uploaded;
    setUploadingFiles(new Map());
    setFileErrors(new Map());
  }, [draftScope, selectedProjectId]);

  /*
   * «Продолжить в новом чате» (Егор 23.09.26): контекст разросся — открыть
   * новый пустой чат, в котором уже лежит выжимка главного из этого.
   *
   * Выжимку пишет сервер (server/modules/handoff) до пары минут, поэтому
   * задача ставится и опрашивается. Готово — открывается новый чат той же
   * папки, и выжимка уходит в него первым сообщением ОБЫЧНОЙ отправкой: так
   * новый чат получает номер, название и защиту от потери сообщения тем же
   * путём, что и набранный руками.
   *
   * Порядок важен. После «Нового сеанса» номер чата обнуляется не сразу, а
   * кадром позже; отправка раньше ушла бы в СТАРЫЙ чат. Поэтому выжимка
   * ждёт, пока открыт именно новый чат этой папки и в поле его черновик
   * (эффект стоит ниже подмены черновика — его текст не затирается).
   */
  const [handoffStatus, setHandoffStatus] = useState<'idle' | 'running'>('idle');
  const handoffTickRef = useRef(0);
  const [handoffTick, setHandoffTick] = useState(0);
  const canHandoff = Boolean(sessionKey && selectedProject && onStartNewChat && provider === 'claude');

  /**
   * Опрос задачи до готовности. `resumeSessionId` — продолжить уже начатую
   * (вкладку выгрузили, пока модель писала): тогда без нового POST.
   */
  const runHandoff = useCallback(async (sourceProject: Project, sourceSessionId: string, resume: boolean) => {
    if (!onStartNewChat || handoffPolling) return;
    handoffPolling = true;
    setHandoffStatus('running');
    if (!resume) {
      writeHandoffJob({ sessionId: sourceSessionId, projectId: sourceProject.projectId, startedAt: Date.now() });
    }
    const fail = (message: string) => {
      clearHandoffJob();
      setHandoffStatus('idle');
      addMessage({ type: 'error', content: `Не получилось продолжить в новом чате: ${message}`, timestamp: new Date() });
    };
    try {
      const url = `/api/handoff/${encodeURIComponent(sourceSessionId)}`;
      let response = await authenticatedFetch(url, resume ? undefined : { method: 'POST' });
      let body = await response.json().catch(() => ({}));
      if (!response.ok) return fail(body?.error || `ошибка ${response.status}`);
      const deadline = Date.now() + 12 * 60 * 1000;
      while (body?.status === 'running' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        response = await authenticatedFetch(url);
        body = await response.json().catch(() => ({}));
        if (!response.ok) return fail(body?.error || `ошибка ${response.status}`);
      }
      if (body?.status !== 'done' || typeof body.message !== 'string') {
        return fail(body?.error || 'выжимка не собралась вовремя');
      }
      clearHandoffJob();
      pendingHandoff = { projectId: sourceProject.projectId, message: body.message };
      setHandoffStatus('idle');
      onStartNewChat(sourceProject);
      handoffTickRef.current += 1;
      setHandoffTick(handoffTickRef.current);
    } catch (error) {
      // Обрыв сети (телефон уснул) — не провал: задача живёт на сервере,
      // при возврате в приложение опрос продолжится по записи в браузере.
      setHandoffStatus('idle');
      if (!readHandoffJob()) fail(error instanceof Error ? error.message : 'нет связи с сервером');
    } finally {
      handoffPolling = false;
    }
  }, [addMessage, onStartNewChat]);

  const startHandoff = useCallback(() => {
    const sourceSessionId = sessionKeyRef.current;
    if (!sourceSessionId || !selectedProject || handoffStatus === 'running') return;
    void runHandoff(selectedProject, sourceSessionId, false);
  }, [handoffStatus, runHandoff, selectedProject]);

  // iPhone выгружает свёрнутое приложение, и опрос в памяти вкладки умирает.
  // Начатая задача записана в браузере: вернулись — опрос продолжается.
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState !== 'visible' || handoffPolling) return;
      const job = readHandoffJob();
      if (!job || !selectedProject || selectedProject.projectId !== job.projectId) return;
      void runHandoff(selectedProject, job.sessionId, true);
    };
    resume();
    document.addEventListener('visibilitychange', resume);
    return () => document.removeEventListener('visibilitychange', resume);
  }, [runHandoff, selectedProject]);

  useEffect(() => {
    const pending = pendingHandoff;
    if (!pending || sessionKey || selectedProjectId !== pending.projectId) return;
    if (draftOwnerRef.current !== draftScope) return;
    pendingHandoff = null;
    inputValueRef.current = pending.message;
    setInput(pending.message);
    const timer = window.setTimeout(() => {
      // За этот миг человек мог открыть другой чат — тогда выжимка остаётся
      // в поле нового, а не уходит куда попало.
      if (sessionKeyRef.current || inputValueRef.current !== pending.message) return;
      void handleSubmitRef.current?.(createFakeSubmitEvent());
    }, 50);
    return () => window.clearTimeout(timer);
  }, [sessionKey, selectedProjectId, draftScope, handoffTick]);


  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    if (lastAutosizedInputRef.current === input) {
      return;
    }
    // Re-run for restored drafts and programmatic input changes. User typing is
    // already resized in onInput, so this avoids doing the same forced layout twice.
    resizeTextarea(textareaRef.current);
    // И обязательно выровнять слой подсветки.
    //
    // Он лежит поверх поля ввода и прокручивается отдельно. Раньше здесь
    // менялась только высота, а прокрутка слоя оставалась той, что была в
    // прошлом чате. Получалось, что текст нарисован на одной строке, а
    // курсор стоит на другой — Егор: «строка сдвигается, хотя фактически она
    // на той же линии, а при начале ввода вводится правильно». Правильно
    // потому, что первое же нажатие клавиши шло по другому пути, где
    // выравнивание было.
    syncInputOverlayScroll(textareaRef.current);
  }, [input, resizeTextarea, syncInputOverlayScroll]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = 'auto';
    // Пустое поле — слой тоже в начало, иначе он останется прокрученным.
    syncInputOverlayScroll(textareaRef.current);
    setIsTextareaExpanded(false);
  }, [input, syncInputOverlayScroll]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      setInput(newValue);
      inputValueRef.current = newValue;
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        event.target.style.height = 'auto';
        setIsTextareaExpanded(false);
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [handleCommandInputChange, resetCommandMenuState, setCursorPosition],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (event.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        event.preventDefault();
        cyclePermissionMode();
        return;
      }

      if (event.key === 'Enter') {
        if (event.nativeEvent.isComposing) {
          return;
        }

        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          // Во время ответа Ctrl/Cmd+Enter — «отправить сейчас», как в Claude
          // Code. Кто отправляет по Ctrl+Enter всегда, тому сочетание не меняем.
          sendNowRequestedRef.current = isLoading && !sendByCtrlEnter && provider === 'claude';
          handleSubmit(event);
        } else if (
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !sendByCtrlEnter &&
          !isTouchKeyboard()
        ) {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      cyclePermissionMode,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleSubmit,
      isLoading,
      provider,
      sendByCtrlEnter,
      showCommandMenu,
      showFileDropdown,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      resizeTextarea(target);
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);
    },
    [resizeTextarea, setCursorPosition, syncInputOverlayScroll],
  );

  const handleClearInput = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    resetCommandMenuState();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
  }, [resetCommandMenuState]);

  const handleAbortSession = useCallback(() => {
    if (!canAbortSession) {
      return;
    }

    const targetSessionId = selectedSession?.id || currentSessionId || null;
    if (!targetSessionId) {
      console.warn('Abort requested but no session ID is available.');
      return;
    }

    // The backend resolves the provider from the session row, so no provider
    // field is needed here.
    sendMessage({
      type: 'chat.abort',
      sessionId: targetSessionId,
    });
  }, [canAbortSession, currentSessionId, selectedSession?.id, sendMessage]);

  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      validIds.forEach((requestId) => {
        sendMessage({
          type: 'chat.permission-response',
          requestId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
      });

      setPendingPermissionRequests((previous) =>
        previous.filter((request) => !validIds.includes(request.requestId)),
      );
    },
    [sendMessage, setPendingPermissionRequests],
  );

  const [isInputFocused, setIsInputFocused] = useState(false);

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
      onInputFocusChange?.(focused);
    },
    [onInputFocusChange],
  );

  return {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles: filteredFiles as MentionableFile[],
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    uploadingFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker: open,
    handleSubmit,
    queuedDrafts,
    editQueuedDraft,
    deleteQueuedDraft,
    sendNowQueuedDraft,
    moveQueuedDraft,
    clearQueuedDrafts,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
    handoffStatus,
    startHandoff,
    canHandoff,
  };
}

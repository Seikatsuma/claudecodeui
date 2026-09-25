/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  appendFilesInputTag,
  buildClaudeUserContent,
  normalizeImageDescriptors
} from '@/shared/image-attachments.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { resolveClaudeCodeExecutablePath, waitForClaudeCodeExecutable } from '@/shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyBackgroundWorkCompleted,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from '@/modules/notifications/index.js';
import { createCompleteMessage, createNormalizedMessage, getClaudeConfigDir, getClaudeJsonPath } from '@/shared/utils.js';
import { getRequestRuntimeContext } from '@/shared/request-context.js';
import { noteSurvivorProviderSession, spawnSurvivableClaude } from '@/modules/providers/list/claude/survivor-runs.js';
import { hasTranscriptOnDisk } from '@/modules/providers/list/claude/transcript-presence.js';
import { applyDesktopBrains } from './desktop-brains.js';

const activeSessions = new Map();
const pendingToolApprovals = new Map();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set();
// Query instances interrupted because a newer run took over their session id
// (see addSession). Their run loops must stay silent on wind-down: the map
// entry, the abort flag, and all client-facing events belong to the new run.
const supersededInstances = new WeakSet();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

// How long background work is allowed to keep running after a turn ends. This drives
// two halves of the same behaviour:
//
//  1. Passed to the spawned CLI as CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, which is how
//     long it waits for still-running background *agents* before killing them.
//  2. A backstop on how long we hold the SDK's stdin open after a turn's `result`.
//     The SDK closes stdin as soon as a turn ends, and the CLI reads that EOF as
//     "print wind-down" — killing background *shells* after a short grace period,
//     which the ceiling above does not cover. Holding stdin open also lets the CLI
//     push follow-up turns (background-task completions, Monitor notifications,
//     scheduled wake-ups).
//
// The hold normally ends long before this: a turn with nothing outstanding closes
// stdin immediately, background work releases it as soon as it reports back, and a
// new turn supersedes the previous hold. This ceiling only catches background work
// that never reports at all, so an abandoned session cannot leak a CLI process
// forever. The timer resets on signs of real activity (see signalsBackgroundActivity),
// so it measures silence, not total time; total time is capped by HELD_BG_MAX_MS below.
const BG_WAIT_CEILING_MS = 30 * 60 * 1000;

// Абсолютный потолок удержания ввода ради фоновой работы — от НАЧАЛА удержания,
// ничем не сбрасывается. Без него бесконечный фоновый Agent/Monitor, который то и
// дело шлёт task_progress, держал бы процесс (~330–440 МБ) без предела. По
// истечении ввод отпускается: дальше работу ограничивает уже потолок самого CLI
// (BG_WAIT_CEILING_MS от конца ввода), как было до удержания.
const HELD_BG_MAX_MS = Math.max(60_000, parseInt(process.env.CLOUDCLI_HELD_BG_MAX_MS, 10) || 2 * 60 * 60 * 1000);

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

// Bound on the real-title-generation control request below. Measured ~1-2s
// against the actual CLI; this is a generous backstop so a slow/hung call
// can never stall a session's turn-closing beyond a few seconds.
const SESSION_TITLE_GENERATION_TIMEOUT_MS = parseInt(process.env.CLAUDE_TITLE_GENERATION_TIMEOUT_MS, 10) || 8000;
// A description this long would be an unusually large first message; cap it
// so the control-protocol payload stays small regardless of what the user pasted.
const SESSION_TITLE_DESCRIPTION_MAX_CHARS = 4000;

/**
 * Best-effort real title generation for a brand-new session's first turn.
 *
 * Calls the SDK's own `generateSessionTitle` control request — the same
 * mechanism the official CLI/IDE integrations use to name a session — with
 * `persist: true`, so the result is appended to the session's own JSONL
 * transcript as a normal `ai-title` entry, the exact record format the
 * session synchronizer already reads. This gives the web and the native CLI
 * one real, once-generated title from a single source of truth (the
 * transcript file) instead of the web inventing its own naive placeholder
 * that has to be reconciled with the CLI's title later.
 *
 * Must be called (and awaited) while `queryInstance`'s prompt stream is
 * still held open — the underlying transport closes once the stream ends,
 * and this control request otherwise races that shutdown. Failures
 * (missing method on older SDKs, timeout, transport errors) are swallowed:
 * the naive placeholder title stays in place and the regular sync (which
 * itself is tier-aware, see `resolveTitleUpdate` in sessions.db.ts) can
 * still pick up a title from a later organic `ai-title`/`custom-title` event.
 */
async function generateRealSessionTitle(queryInstance, description) {
  if (!queryInstance || typeof queryInstance.generateSessionTitle !== 'function') {
    return;
  }
  const trimmedDescription = typeof description === 'string' ? description.trim() : '';
  if (!trimmedDescription) {
    return;
  }

  try {
    await Promise.race([
      queryInstance.generateSessionTitle(
        trimmedDescription.slice(0, SESSION_TITLE_DESCRIPTION_MAX_CHARS),
        { persist: true }
      ),
      new Promise((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('generateSessionTitle timed out')),
          SESSION_TITLE_GENERATION_TIMEOUT_MS
        );
      })
    ]);
  } catch (error) {
    console.warn('[Claude SDK] Real session title generation skipped:', error?.message || error);
  }
}

function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_PREDEFINED_MODELS) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

import { recordRateLimitEvent } from '@/modules/providers/services/usage-limits.store.js';
import {
  pickContextWindowFromModelUsage,
  rememberContextWindow,
  resolveClaudeContextWindow,
} from '@/modules/providers/services/claude-context-window.js';

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

function mapCliOptionsToSDK(options = {}) {
  const { providerSessionId, cwd, toolsSettings, permissionMode, effort } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(BG_WAIT_CEILING_MS) };

  // Multi-tenant env overrides. `options.claudeConfigDir`/`options.anthropicApiKey`
  // are set explicitly by the chat WebSocket handler (chat-websocket.service.ts),
  // which resolves them from the message's own userId - AsyncLocalStorage context
  // does not reach a WebSocket 'message' handler, only HTTP request call stacks.
  // getClaudeConfigDir()/getRequestRuntimeContext() cover the HTTP call sites
  // (git.routes.ts's commit-message helper, agent.routes.ts) automatically.
  // On every install that never sets either (Account 1/2 included), both
  // resolve to exactly what was already in `...process.env` above, so this
  // changes nothing for them - CLAUDE_CONFIG_DIR/ANTHROPIC_API_KEY end up with
  // the same values, just spelled out explicitly instead of inherited.
  const resolvedConfigDir = options.claudeConfigDir || getClaudeConfigDir();
  if (resolvedConfigDir) {
    sdkOptions.env.CLAUDE_CONFIG_DIR = resolvedConfigDir;
  }
  const resolvedApiKey = options.anthropicApiKey
    ?? getRequestRuntimeContext()?.anthropicApiKey
    ?? null;
  if (resolvedApiKey) {
    sdkOptions.env.ANTHROPIC_API_KEY = resolvedApiKey;
  }

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  sdkOptions.pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_PREDEFINED_MODELS.DEFAULT;

  const resolvedEffort = resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_PREDEFINED_MODELS,
  );
  if (resolvedEffort) {
    sdkOptions.effort = resolvedEffort;
  }

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  // Пресет промпта из шапки разговора.
  //
  // Активный пресет добавляется к системному промпту Claude Code, а не
  // заменяет его: базовый промпт от SDK отвечает за протокол работы с
  // инструментами и файлами, и без него агент теряет половину способностей.
  // Пресет накладывает роль сверху: «отвечай коротко», «объясни как
  // школьнику», «разбирай ошибку методично». Пустая строка = как раньше.
  if (typeof options.appendSystemPrompt === 'string' && options.appendSystemPrompt.trim()) {
    sdkOptions.appendSystemPrompt = options.appendSystemPrompt.trim();
  }

  sdkOptions.settingSources = ['project', 'user', 'local'];

  // Turn on extended thinking. Without this the CLI subprocess is never told
  // to think at all: `thinking_delta` stream events still fire on schedule
  // (the partial-message plumbing is unconditional), but `delta.thinking` is
  // always empty because the model was never asked to produce any reasoning.
  // 'adaptive' lets Claude itself decide when/how much to think (the `effort`
  // option above then guides depth); the CLI falls back appropriately for
  // models that don't support adaptive thinking.
  //
  // `display: 'summarized'` is not cosmetic — it is load-bearing. Verified by
  // spawning the CLI with `spawnClaudeCodeProcess` and inspecting the actual
  // argv plus the raw `content_block_delta`/`thinking_delta` events for both
  // settings: with `thinking: { type: 'adaptive' }` alone, the CLI receives
  // `--thinking adaptive` (no `--thinking-display`), the model visibly spends
  // thinking tokens (`usage.output_tokens_details.thinking_tokens` > 0,
  // `content_block_start` for a `thinking` block fires), but every
  // `thinking_delta.thinking` frame is `""` — only an opaque `signature` blob
  // streams (the SDK/CLI default is redacted/omitted thinking output, not
  // "no thinking"). Only adding `display: 'summarized'` (-> CLI flag
  // `--thinking-display summarized`) makes the model stream actual readable
  // thinking text through `thinking_delta.thinking`.
  sdkOptions.thinking = { type: 'adaptive', display: 'summarized' };

  // Emit SDKPartialAssistantMessage (`stream_event`) frames as the model
  // writes, instead of only the finished per-block message. This is what
  // lets the frontend show thinking (and assistant text) live, chunk by
  // chunk, rather than as one block dropped in after the fact. Without it
  // the SDK/CLI only reports whole content blocks once they close.
  sdkOptions.includePartialMessages = true;

  // The SDK resumes with the provider-native session id, never the app id.
  if (providerSessionId) {
    sdkOptions.resume = providerSessionId;
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 * @param {Function} releaseInput - Closes the held stdin stream so the CLI can exit
 */
function addSession(sessionId, queryInstance, writer = null, releaseInput = null, steer = null, adopt = null) {
  const existing = activeSessions.get(sessionId);
  // A different live instance under the same key means an earlier run was
  // superseded without being stopped (e.g. an abort that raced run setup and
  // found nothing to interrupt). Overwriting it here would strand its
  // generator forever — this map entry is the only handle for interrupting
  // it. Stop it directly rather than via abortClaudeSDKSession, whose
  // session-keyed abortedSessionIds flag would be consumed by the new run
  // and suppress its terminal `complete`.
  const superseding = Boolean(
    existing && existing.status === 'active' && existing.instance && existing.instance !== queryInstance
  );
  if (superseding) {
    supersededInstances.add(existing.instance);
    Promise.resolve()
      .then(() => existing.instance.interrupt())
      .catch((error) => {
        console.error(`Error interrupting superseded run for session ${sessionId}:`, error?.message || error);
      });
    existing.releaseInput?.();
  }
  const carried = superseding ? null : existing;
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: carried?.startTime || Date.now(),
    status: 'active',
    writer,
    // Re-registered mid-run once the provider session id lands; keep the closer.
    releaseInput: releaseInput || carried?.releaseInput || null,
    // «Отправить сейчас»: дописывает сообщение человека в идущий ход.
    steer: steer || carried?.steer || null,
    // Новое сообщение человека — новым ходом в ЭТОТ процесс, пока он удержан
    // ради фоновой работы (см. adoptTurn в queryClaudeSDK).
    adopt: adopt || carried?.adopt || null
  });
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Живой счётчик контекста во время ответа — те же правила, что у серверного
 * подсчёта (provider-token-usage.service.ts) и у Claude Code:
 * заполненность = `input + cache_creation + cache_read` последнего ответа
 * ОСНОВНОЙ ветки. Ответы помощников (`parent_tool_use_id`) показывают ИХ окно,
 * а не окно чата; `<synthetic>` и ошибки пишутся с нулевым счётом — пропуск.
 * `result.usage` — сумма всех запросов хода, это не заполненность: из итога
 * берём только размер окна (`modelUsage[модель].contextWindow`) и запоминаем.
 * @param {Object} sdkMessage - SDK stream message
 * @param {{ sessionIds: Array<string|null>, sessionModel?: string|null, last: { context: number, input: number, output: number, cacheRead: number, cacheCreation: number, model: string|null } }} tracker
 * @returns {Object|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage, tracker) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  if (sdkMessage.type === 'result') {
    const picked = pickContextWindowFromModelUsage(sdkMessage.modelUsage, tracker.last.model);
    if (picked) {
      rememberContextWindow(tracker.sessionIds, picked.contextWindow, picked.model);
    }
    if (!tracker.last.context) {
      return null;
    }
  } else {
    const messageUsage = sdkMessage.type === 'assistant' ? sdkMessage.message?.usage : null;
    if (!messageUsage || typeof messageUsage !== 'object' || sdkMessage.parent_tool_use_id) {
      return null;
    }
    const model = typeof sdkMessage.message?.model === 'string' ? sdkMessage.message.model : null;
    const input = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
    const cacheCreation = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
    const cacheRead = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
    const output = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
    const context = input + cacheCreation + cacheRead;
    if (model === '<synthetic>' || context === 0) {
      return null;
    }
    tracker.last = { context, input, output, cacheRead, cacheCreation, model: model || tracker.last.model };
  }

  const last = tracker.last;
  const contextWindow = resolveClaudeContextWindow({
    sessionIds: tracker.sessionIds,
    sessionModel: tracker.sessionModel,
    maxObservedContext: last.context,
  });

  return {
    used: last.context,
    total: contextWindow,
    inputTokens: last.context,
    outputTokens: last.output,
    cacheReadTokens: last.cacheRead,
    cacheCreationTokens: last.cacheCreation,
    cacheTokens: last.cacheRead + last.cacheCreation,
    breakdown: {
      input: last.context,
      output: last.output,
    },
    contextTokens: last.context,
    contextWindow,
    contextPercent: contextWindow > 0 ? Math.round((last.context / contextWindow) * 1000) / 10 : 0,
    model: last.model,
  };
}

// Tool calls that leave work running past the end of a turn. Bash only counts
// when it is explicitly backgrounded; the rest defer or watch work by nature.
const DEFERRED_WORK_TOOLS = new Set(['Monitor', 'ScheduleWakeup', 'CronCreate', 'TaskCreate']);
// Инструменты, которые уходят в фон только с run_in_background. Фоновый
// Agent/Task/Workflow раньше не держал канал: следующее сообщение человека
// поднимало новый процесс `--resume`, а агент оставался доживать в старом до
// потолка CLI, и его результат терялся (опыт 25.09.26, ~/cc2-test).
const BACKGROUNDABLE_TOOLS = new Set(['Bash', 'Agent', 'Task', 'Workflow']);

// Процессы, удержанные ради фоновой работы, — по владельцу: пользователь, а без
// userId — сам чат (не общий на сервер ключ). Каждый держит ~330–440 МБ; сверх
// предела отпускается самый старый (его фоновые оболочки CLI гасит через 5 с,
// агенты доживают до потолка CLI — как было до правки). Чат держит не больше
// одного процесса (новый ход вытесняет прежний), так что без userId предел
// фактически — по одному на чат, а время каждого ограничено HELD_BG_MAX_MS.
const MAX_HELD_BG_PER_USER = Math.max(1, parseInt(process.env.CLOUDCLI_MAX_HELD_BG_PER_USER, 10) || 4);
const heldBgRuns = new Map(); // token -> { userKey, since, release, label }

function trackHeldRun(token, userKey, release, label) {
  heldBgRuns.set(token, { userKey, since: Date.now(), release, label });
  const mine = [...heldBgRuns.entries()]
    .filter(([, held]) => held.userKey === userKey)
    .sort((a, b) => a[1].since - b[1].since);
  while (mine.length > MAX_HELD_BG_PER_USER) {
    const [oldToken, oldest] = mine.shift();
    heldBgRuns.delete(oldToken);
    console.warn(`[Claude SDK] удержано фоновых процессов больше ${MAX_HELD_BG_PER_USER} у владельца ${userKey} — отпускаю самый старый (${oldest.label})`);
    try { oldest.release(); } catch { /* уже закрыт */ }
  }
}

function untrackHeldRun(token) {
  heldBgRuns.delete(token);
}

/**
 * Сообщение CLI после конца хода, которое значит «работа реально идёт» и
 * отодвигает 30-минутный отсчёт молчания: ход модели (assistant/user, в т.ч.
 * копия сообщения человека; stream_event) и отчёты фоновых задач
 * (system/task_started|task_progress|task_updated|task_notification,
 * system/background_tasks_changed). Служебное — rate_limit_event, system/status,
 * пульс tool_progress, хуки — отсчёт не сбрасывает. Абсолютный потолок
 * HELD_BG_MAX_MS не сбрасывает ничто.
 */
function signalsBackgroundActivity(message) {
  if (!message) return false;
  if (message.type === 'assistant' || message.type === 'user' || message.type === 'stream_event') {
    return true;
  }
  return message.type === 'system' && typeof message.subtype === 'string'
    && (message.subtype.startsWith('task_') || message.subtype === 'background_tasks_changed');
}

/**
 * Detects tool calls that keep working after the turn's `result` arrives.
 *
 * Only turns that start background work need their CLI process held open; every
 * other turn can let it exit immediately, as it did before the hold existed.
 *
 * @param {Object} sdkMessage - SDK stream message
 * @returns {boolean} True when the message launches work that outlives the turn
 */
function startsBackgroundWork(sdkMessage) {
  const content = sdkMessage?.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block) => {
    if (block?.type !== 'tool_use') {
      return false;
    }
    if (BACKGROUNDABLE_TOOLS.has(block.name)) {
      return block.input?.run_in_background === true;
    }
    return DEFERRED_WORK_TOOLS.has(block.name);
  });
}

/**
 * Builds the SDK user messages for one turn.
 *
 * Always returns SDKUserMessage records rather than a bare string: a string
 * prompt makes the SDK flag the query as single-turn and close stdin the moment
 * the turn's `result` arrives, which kills the CLI's background tasks. Plain
 * text turns carry string content; turns with image attachments carry the
 * prompt text plus one base64 `image` block per attachment (read from the
 * global `~/.cloudcli/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {Array} files - Non-image attachment descriptors
 * @param {string} cwd - Project working directory attachment paths resolve against
 * @returns {Promise<Array<Object>>} SDKUserMessage records for the turn
 */
async function buildPromptMessages(command, images, files, cwd) {
  const promptWithFiles = appendFilesInputTag(command, files);
  const content = normalizeImageDescriptors(images).length === 0
    ? promptWithFiles
    : await buildClaudeUserContent(promptWithFiles, images, cwd);

  return [{
    type: 'user',
    message: {
      role: 'user',
      content
    },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString()
  }];
}

/**
 * Wraps prompt messages in an async iterable that yields them and then parks.
 *
 * The SDK closes the CLI's stdin as soon as its input iterable is exhausted (and
 * immediately on `result` for string prompts). The CLI reads that EOF as the end
 * of the run and kills anything still going in the background, so the iterable
 * has to stay pending until we actually want the process gone.
 *
 * @param {Array<Object>} messages - SDKUserMessage records to send
 * @returns {{ stream: AsyncIterable, release: () => void }} Stream plus its closer
 */
function createHeldPromptStream(messages) {
  let released = false;
  let release;
  const held = new Promise((resolve) => {
    release = () => {
      released = true;
      resolve('released');
    };
  });
  // Сообщения, дописанные посреди хода («отправить сейчас», см. steerTurn в
  // queryClaudeSDK), и будильник генератора, ждущего следующего.
  const extra = [];
  let wake = null;

  const stream = (async function* () {
    for (const message of messages) {
      yield message;
    }
    // Keeps stdin open — the CLI stays alive until release() is called.
    while (!released) {
      if (extra.length > 0) {
        yield extra.shift();
        continue;
      }
      await Promise.race([held, new Promise((resolve) => { wake = resolve; })]);
      wake = null;
    }
  })();

  const push = (message) => {
    if (released) return false;
    extra.push(message);
    wake?.();
    return true;
  };

  return { stream, release, push };
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd, claudeConfigDir) {
  try {
    // Каталог настроек передаётся явно, а не берётся из окружения.
    //
    // getClaudeJsonPath() умеет читать контекст запроса, но этот код работает
    // в обработчике веб-сокета, куда контекст запроса не дотягивается, — и
    // молча откатывался к каталогу владельца площадки. 12.09.26 это значило,
    // что приглашённый пользователь получал ПОДКЛЮЧЕНИЯ владельца: почту,
    // календарь, диск, заметки. Не настройку интерфейса, а доступ к чужим
    // данным.
    //
    // Нужный каталог у вызывающего уже есть — он же задаёт его рантайму, —
    // поэтому передаём его сюда, вместо того чтобы угадывать по окружению.
    const claudeConfigPath = claudeConfigDir
      ? path.join(claudeConfigDir, '.claude.json')
      : getClaudeJsonPath();

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @param {Object} context - Provider-scoped model, session, and auth lookups
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws, context) {
  const { sessionId, sessionSummary } = options;
  // Callers pass the stable app session id; the SDK only understands the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  // True only for a brand-new app session's very first turn (no provider run
  // has happened for it yet) - the one time real title generation is worth
  // triggering. Captured once, up front, so it stays accurate regardless of
  // what `assignProviderSessionId` does to the DB row mid-turn.
  const isBrandNewSession = !providerSessionId && Boolean(sessionId);
  let titleGenerationTriggered = false;
  // Provider-native id as the SDK reports it (starts as the resume id, or is
  // captured from the stream for brand-new sessions).
  let capturedSessionId = providerSessionId;
  let sessionCreatedSent = false;
  // Process-map key: the app session id when the caller supplied one, else
  // the provider-native id once captured (legacy/direct API callers).
  const sessionKey = () => sessionId || capturedSessionId || null;

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  // Closes the held stdin stream so the CLI can wind down. Replaced once the
  // stream exists; the finally block calls it no matter how the run ends.
  let releasePromptStream = () => {};
  // Дописывает сообщение в канал этого хода; заменяется вместе с потоком.
  let pushPromptMessage = () => false;
  // Сообщения «отправить сейчас», которые Claude ещё не забрал. Забранное он
  // возвращает копией с `isReplay` (флаг --replay-user-messages): посреди хода
  // — на ближайшем шаге между инструментами, а если шагов больше нет — уже
  // после `result`, отдельным ходом. Пока здесь что-то есть, `result` не
  // конец: страница должна видеть, что Claude ещё работает.
  const pendingSteerIds = new Set();
  let steerFallbackTimer = null;

  /**
   * «Отправить сейчас» (Егор 22.09.26: «не ждать, пока закончит — как в
   * Cursor»). Сообщение уходит в идущий ход, а не в очередь: Claude прочтёт
   * его на ближайшем шаге и не бросит сделанное. Живая проба 22.09.26:
   * `sleep A; sleep B; sleep C` + вставка «C не выполняй» → A, B, «C пропускаю».
   * В ленте сообщение появляется сразу; после перезагрузки его показывает
   * запись `queued_command` из переписки (claude-sessions.provider).
   *
   * @returns {Promise<boolean>} false — ход уже отчитался о конце, пусть
   *   сообщение идёт обычным путём.
   */
  const steerTurn = async ({ content, images, files, cwd }) => {
    if (turnCompleteSent) {
      return false;
    }
    const [message] = await buildPromptMessages(content, images, files, cwd || options.cwd);
    const uuid = crypto.randomUUID();
    const steerMessage = { ...message, uuid, priority: 'next' };
    if (!pushPromptMessage(steerMessage)) {
      return false;
    }
    pendingSteerIds.add(uuid);
    const sid = capturedSessionId || sessionId || null;
    for (const msg of context.normalizeMessage({ ...steerMessage, type: 'user' }, sid)) {
      ws.send(msg);
    }
    return true;
  };

  /**
   * Новое сообщение человека в процесс, который ход уже закончил, но держит
   * открытым ради фоновой работы. Раньше такое сообщение поднимало второй
   * процесс `claude --resume`, а фоновый агент оставался в первом и терялся.
   * Здесь сообщение уходит обычным новым ходом в тот же процесс — фоновая
   * работа продолжается, её результат придёт в этот же чат.
   *
   * @returns {Promise<{done: Promise<void>}|null>} null — усыновить нельзя
   *   (процесс не удержан, другая модель/режим), пусть идёт обычный запуск.
   */
  const adoptTurn = async ({ content, images, files, cwd, model, permissionMode, effort, appendSystemPrompt, writer }) => {
    if (!turnCompleteSent || !heldForBackgroundWork || !idleReleaseTimer || adoptedTurnDone || heldMaxReached) {
      return null;
    }
    // Модель, режим разрешений, глубина размышлений и приписка пресета — это
    // настройки процесса, в живой процесс их не передать: изменилось хоть
    // что-то (в том числе выбрано явно, а процесс шёл на умолчании) — пусть
    // идёт новый процесс, как раньше, иначе выбор человека молча потеряется.
    if (model && model !== options.model) return null;
    if (permissionMode && permissionMode !== options.permissionMode) return null;
    if (effort && effort !== options.effort) return null;
    if ((appendSystemPrompt || '') !== (options.appendSystemPrompt || '')) return null;
    const [message] = await buildPromptMessages(content, images, files, cwd || options.cwd);
    const uuid = crypto.randomUUID();
    if (!pushPromptMessage({ ...message, uuid })) {
      return null;
    }
    clearTimeout(idleReleaseTimer);
    idleReleaseTimer = null;
    untrackHeldRun(heldToken);
    // Пока Claude не забрал сообщение, `result` (например, отчёт фоновой
    // задачи) — не конец этого хода; та же механика, что у «отправить сейчас».
    pendingSteerIds.add(uuid);
    ws = writer;
    turnCompleteSent = false;
    lastMessageAt = Date.now();
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    adoptedTurnDone = { resolve };
    if (sessionKey()) {
      addSession(sessionKey(), queryInstance, ws, releasePromptStream, steerTurn, adoptTurn);
    }
    console.log(`[Claude SDK] сообщение принято живым процессом (фоновая работа идёт): ${sessionKey() || 'NEW'}`);
    return { done };
  };
  let idleReleaseTimer = null;
  // The client is told the turn is over as soon as `result` lands, even though
  // the process lingers, so the UI never waits out the idle hold.
  let turnCompleteSent = false;
  // Объявлен здесь, чтобы finally мог его остановить при любом выходе.
  let stallTimer = null;
  // Set when a turn starts background work, cleared when the next `result`
  // arrives — only turns with work still outstanding hold their process open.
  let backgroundWorkPending = false;
  // True while the process is being held open for background work, so a later
  // `result` can be recognised as that work reporting back.
  let heldForBackgroundWork = false;
  // Фоновые задачи, о которых CLI сообщил сам (system/task_started|task_updated|
  // task_notification, system/background_tasks_changed): пока здесь что-то
  // есть, конец хода не отпускает процесс. Имена инструментов выше — главный
  // признак; это — страховка на фон, который CLI завёл сам.
  const liveBgTaskIds = new Set();
  const bgToolUseIds = new Set();
  let cliReportedBgCount = 0;
  const seenBgSubtypes = new Set();
  const hasLiveBackgroundWork = () => liveBgTaskIds.size > 0 || cliReportedBgCount > 0;
  // Сторож молчания читает это время; поднят сюда, чтобы adoptTurn мог его сбросить.
  let lastMessageAt = Date.now();
  // Ход, усыновлённый удержанным процессом: обещание «ход закончен» для вызывающего.
  let adoptedTurnDone = null;
  const settleAdoptedTurn = () => {
    const done = adoptedTurnDone;
    adoptedTurnDone = null;
    done?.resolve();
  };
  const heldToken = {};
  // Ключ предела удержаний: пользователь, а без userId — этот чат (раньше было
  // общее на сервер 'none' — предел 4 делили все чаты).
  const heldRunFallbackKey = `run:${crypto.randomUUID()}`;
  const heldRunOwnerKey = () => (ws?.userId !== undefined && ws?.userId !== null
    ? `user:${ws.userId}`
    : `chat:${sessionKey() || heldRunFallbackKey}`);
  // Абсолютный потолок удержания (HELD_BG_MAX_MS): отсчёт от первого удержания,
  // не сбрасывается ни сообщениями CLI, ни новыми ходами в этот процесс.
  let heldSince = 0;
  let heldMaxTimer = null;
  let heldMaxReached = false;
  const releaseHeldAtCeiling = () => {
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    heldForBackgroundWork = false;
    untrackHeldRun(heldToken);
    releasePromptStream();
  };
  const onHeldMax = () => {
    heldMaxTimer = null;
    heldMaxReached = true;
    const heldMin = Math.round((Date.now() - heldSince) / 60000);
    if (!turnCompleteSent) {
      // Идёт ход (новое сообщение человека в удержанный процесс): не рвём его,
      // ввод отпустится в конце хода (holdForBackground).
      console.warn(`[Claude SDK] потолок удержания ${Math.round(HELD_BG_MAX_MS / 60000)} мин истёк посреди хода (${sessionKey() || 'NEW'}, удержан ${heldMin} мин) — отпущу ввод в конце хода`);
      return;
    }
    console.warn(`[Claude SDK] потолок удержания ${Math.round(HELD_BG_MAX_MS / 60000)} мин истёк (${sessionKey() || 'NEW'}, удержан с ${new Date(heldSince).toISOString()}) — отпускаю ввод; фоновую работу дальше ограничивает потолок CLI ${Math.round(BG_WAIT_CEILING_MS / 60000)} мин`);
    releaseHeldAtCeiling();
  };
  const holdForBackground = () => {
    if (heldMaxReached) {
      console.warn(`[Claude SDK] потолок удержания истёк — не держу процесс дальше (${sessionKey() || 'NEW'})`);
      releaseHeldAtCeiling();
      return;
    }
    heldForBackgroundWork = true;
    scheduleRelease();
    if (!heldSince) {
      heldSince = Date.now();
      heldMaxTimer = setTimeout(onHeldMax, HELD_BG_MAX_MS);
      heldMaxTimer.unref?.();
    }
    trackHeldRun(heldToken, heldRunOwnerKey(), () => releasePromptStream(), sessionKey() || 'NEW');
  };

  // A new turn supersedes any earlier one still holding this session's process
  // open, so held runs cannot stack up across a conversation.
  if (sessionKey()) {
    getSession(sessionKey())?.releaseInput?.();
  }

  // Arms (or re-arms) the idle countdown that eventually closes stdin.
  const scheduleRelease = () => {
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    idleReleaseTimer = setTimeout(() => {
      idleReleaseTimer = null;
      console.warn(`[Claude SDK] ${Math.round(BG_WAIT_CEILING_MS / 60000)} мин без признаков фоновой работы — отпускаю ввод (${sessionKey() || 'NEW'})`);
      untrackHeldRun(heldToken);
      releasePromptStream();
    }, BG_WAIT_CEILING_MS);
    // Never let the hold keep the server process alive on its own.
    idleReleaseTimer.unref?.();
  };

  // Hoisted above the try so the catch's cleanup can tell whether this run
  // still owns the activeSessions entry (or was superseded by a newer run).
  let queryInstance = null;

  try {
    const resolvedModel = await context.resolveResumeModel(sessionId, options.model);
    let effortModels = CLAUDE_PREDEFINED_MODELS;
    try {
      effortModels = await context.getProviderModels();
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      providerSessionId,
      model: resolvedModel || options.model,
      effortModels,
    });

    // Номер разговора записан, а переписки на диске нет: первый ход оборвался
    // до записи файла. Продолжать нечего — движок отвечает «No conversation
    // found», и чат навсегда показывает пустой экран, глотая сообщения.
    // Начинаем разговор под тем же номером: адрес и название чата не меняются.
    // Пока предыдущий ход этого чата жив, файл может просто ещё не появиться —
    // тогда не трогаем: два процесса под одним номером испортили бы переписку.
    if (sdkOptions.resume
      && !activeSessions.has(sessionKey())
      && !(await hasTranscriptOnDisk(sdkOptions.env?.CLAUDE_CONFIG_DIR, sdkOptions.resume))) {
      console.warn(`[Claude SDK] переписки ${sdkOptions.resume} нет на диске — начинаю разговор под тем же номером`);
      sdkOptions.sessionId = sdkOptions.resume;
      delete sdkOptions.resume;
    }

    const mcpServers = await loadMcpConfig(options.cwd, options.claudeConfigDir);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // Every turn uses streaming input so stdin stays open past the turn's
    // `result`. The message list is reusable, but each query attempt needs its
    // own stream because an async generator cannot be replayed once consumed.
    const promptMessages = await buildPromptMessages(command, options.images, options.files, options.cwd);

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          // Notifications are app-facing, so they carry the app session id.
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${sessionId || capturedSessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    // Настольная программа: правила, протокол к сообщению, помощники и навыки,
    // защита от удаления (см. desktop-brains.js). На сайте — ничего.
    applyDesktopBrains(sdkOptions);

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${sessionId || capturedSessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          // Keyed by the app session id so `chat.subscribe` can look pending
          // approvals up directly; provider id only for legacy callers.
          _sessionId: sessionId || capturedSessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // Свежий Claude рядом с Node, а не случайная старая копия дальше по PATH,
    // если npm как раз его переустанавливает (см. waitForClaudeCodeExecutable).
    sdkOptions.pathToClaudeCodeExecutable = await waitForClaudeCodeExecutable(process.env.CLAUDE_CLI_PATH);

    // Процесс агента запускаем сами: так он переживает перезапуск сайта
    // (см. survivor-runs.js — там проба и причина).
    sdkOptions.spawnClaudeCodeProcess = (spawnOptions) => spawnSurvivableClaude(spawnOptions, {
      appSessionId: sessionId || null,
      providerSessionId: providerSessionId || null,
      configDir: sdkOptions.env?.CLAUDE_CONFIG_DIR || getClaudeConfigDir(),
    });

    // Копии присланных сообщений нужны, чтобы знать, когда Claude забрал
    // сообщение «отправить сейчас» (см. pendingSteerIds). Сами копии в ленту
    // не идут — сообщение человека там уже есть.
    sdkOptions.extraArgs = { ...(sdkOptions.extraArgs || {}), 'replay-user-messages': null };

    let heldPrompt = createHeldPromptStream(promptMessages);
    releasePromptStream = heldPrompt.release;
    pushPromptMessage = heldPrompt.push;
    try {
      queryInstance = query({
        prompt: heldPrompt.stream,
        options: sdkOptions
      });
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
      delete sdkOptions.hooks;
      // Discard the abandoned stream and build a fresh one for the retry.
      heldPrompt.release();
      heldPrompt = createHeldPromptStream(promptMessages);
      releasePromptStream = heldPrompt.release;
      pushPromptMessage = heldPrompt.push;
      queryInstance = query({
        prompt: heldPrompt.stream,
        options: sdkOptions
      });
    }

    // Track the query instance for abort capability
    if (sessionKey()) {
      addSession(sessionKey(), queryInstance, ws, releasePromptStream, steerTurn, adoptTurn);
    }

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');

    // Сторож молчания.
    //
    // Если процесс Клода умирает, ожидание ответа ниже не заканчивается
    // никогда: перебор сообщений просто зависает, поэтому не срабатывает ни
    // уборка, ни отправка «ответ завершён». Для пользователя это выглядит как
    // «думает и ничего не делает» — до бесконечности. В журнале это видно
    // прямо: запуск в 21:32, и только через 52 минуты, когда пришло следующее
    // сообщение, попытка прервать его вернула «запрос уже закрыт».
    //
    // Порог намеренно большой: длинные инструменты могут молчать минутами, и
    // оборвать живую работу хуже, чем подождать. Сообщение об обрыве —
    // явное, чтобы человек видел причину, а не пустой экран.
    const STALL_SILENCE_MS = Number(process.env.CHAT_STALL_TIMEOUT_MS || 15 * 60 * 1000);
    lastMessageAt = Date.now();
    stallTimer = setInterval(() => {
      if (turnCompleteSent || Date.now() - lastMessageAt < STALL_SILENCE_MS) {
        return;
      }
      clearInterval(stallTimer);
      const silentMinutes = Math.round((Date.now() - lastMessageAt) / 60000);
      console.error(`Chat run went silent for ${silentMinutes} min, closing: ${sessionKey() || 'NEW'}`);
      Promise.resolve().then(() => queryInstance.interrupt?.()).catch(() => {});
      try {
        queryInstance.close?.();
      } catch {
        // Уже закрыт — ровно тот случай, ради которого этот сторож и нужен.
      }
      if (sessionKey() && getSession(sessionKey())?.instance === queryInstance) {
        removeSession(sessionKey());
      }
      if (!turnCompleteSent && !supersededInstances.has(queryInstance)) {
        turnCompleteSent = true;
        ws.send(createNormalizedMessage({
          kind: 'error',
          content: `Ответ оборвался: ${silentMinutes} мин без единого сообщения от Claude — похоже, процесс умер. Отправьте сообщение заново.`,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'claude',
        }));
        ws.send(createCompleteMessage({
          provider: 'claude',
          sessionId: capturedSessionId || sessionId || null,
          exitCode: 1,
        }));
        settleAdoptedTurn();
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'claude',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          error: new Error(`no output for ${silentMinutes} min`),
        });
      }
    }, 30_000);
    stallTimer.unref?.();

    const tokenTracker = {
      sessionIds: [capturedSessionId, sessionId],
      sessionModel: sdkOptions.model || null,
      last: { context: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, model: null },
    };

    for await (const message of queryInstance) {
      lastMessageAt = Date.now();

      // Лимиты подписки приходят прямо в потоке — забираем их бесплатно,
      // вместо отдельного прогона, который тратил бы ту же квоту.
      if (message?.type === 'rate_limit_event' && message.rate_limit_info) {
        recordRateLimitEvent(sdkOptions?.env?.CLAUDE_CONFIG_DIR || '', message.rate_limit_info);
      }
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(sessionKey(), queryInstance, ws, releasePromptStream, steerTurn, adoptTurn);
        noteSurvivorProviderSession(sessionId, capturedSessionId);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for sessions with nothing to resume
        if (!providerSessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      // Копия присланного сообщения (--replay-user-messages): отмечаем, что
      // Claude его забрал, и дальше не пускаем — в ленте оно уже есть.
      if (message.type === 'user' && message.isReplay) {
        pendingSteerIds.delete(message.uuid);
        if (pendingSteerIds.size === 0 && steerFallbackTimer) {
          clearTimeout(steerFallbackTimer);
          steerFallbackTimer = null;
        }
        continue;
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = context.normalizeMessage(transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        ws.send(msg);
      }

      // Extract and send token budget updates from assistant/result usage payloads
      tokenTracker.sessionIds = [capturedSessionId, sessionId];
      const tokenBudgetData = extractTokenBudget(message, tokenTracker);
      if (tokenBudgetData) {
        ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }

      if (startsBackgroundWork(message)) {
        backgroundWorkPending = true;
        for (const block of message.message.content) {
          if (block?.type === 'tool_use' && block.input?.run_in_background === true && block.id) {
            bgToolUseIds.add(block.id);
          }
        }
      }

      if (message.type === 'system' && typeof message.subtype === 'string'
        && (message.subtype.startsWith('task_') || message.subtype === 'background_tasks_changed')) {
        if (!seenBgSubtypes.has(message.subtype)) {
          seenBgSubtypes.add(message.subtype);
          console.log(`[Claude SDK] фон: CLI прислал system/${message.subtype} (${sessionKey() || 'NEW'})`);
        }
        if (message.subtype === 'background_tasks_changed' && Array.isArray(message.tasks)) {
          cliReportedBgCount = message.tasks.filter((task) => task && !task.ambient
            && (!task.status || task.status === 'running' || task.status === 'pending')).length;
        } else if (message.subtype === 'task_started' && message.task_id
          && (message.is_backgrounded === true || bgToolUseIds.has(message.tool_use_id))) {
          liveBgTaskIds.add(message.task_id);
        } else if (message.subtype === 'task_updated' && message.task_id && message.patch) {
          if (message.patch.is_backgrounded === true) liveBgTaskIds.add(message.task_id);
          if (['completed', 'failed', 'killed'].includes(message.patch.status)) liveBgTaskIds.delete(message.task_id);
        } else if (message.subtype === 'task_notification' && message.task_id) {
          liveBgTaskIds.delete(message.task_id);
        }
      }

      if (message.type === 'result' && pendingSteerIds.size > 0
        && !(sessionKey() && abortedSessionIds.has(sessionKey()))) {
        // Сообщение «отправить сейчас» пришло, когда шагов уже не было: Claude
        // разберёт его следующим ходом в этом же процессе. Конец не объявляем
        // и канал не закрываем. Страховка: если за 20 с от Claude ничего не
        // пришло (он не подхватил сообщение), закрываем ход как обычно.
        steerFallbackTimer = setTimeout(() => {
          steerFallbackTimer = null;
          pendingSteerIds.clear();
          if (!turnCompleteSent && !supersededInstances.has(queryInstance)) {
            console.warn(`[Claude SDK] сообщение «отправить сейчас» не подхвачено, закрываю ход ${sessionKey() || 'NEW'}`);
            turnCompleteSent = true;
            ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
          }
          settleAdoptedTurn();
          // Как в обычной ветке `result` ниже: начатая в ходе фоновая работа
          // держит канал открытым, иначе её убило бы закрытие канала.
          if (backgroundWorkPending || hasLiveBackgroundWork()) {
            backgroundWorkPending = false;
            holdForBackground();
          } else {
            releasePromptStream();
          }
        }, 20_000);
        steerFallbackTimer.unref?.();
        continue;
      }

      if (message.type === 'result') {
        // The turn is done as far as the client is concerned.
        const abortPending = sessionKey() ? abortedSessionIds.has(sessionKey()) : false;
        if (!turnCompleteSent && !abortPending) {
          turnCompleteSent = true;
          ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
          notifyRunStopped({
            userId: ws?.userId || null,
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            sessionName: sessionSummary,
            stopReason: 'completed'
          });
        } else if (heldForBackgroundWork && !abortPending) {
          // A result after the turn already reported complete means the work we
          // held the process open for has finished and pushed a follow-up turn.
          notifyBackgroundWorkCompleted({
            userId: ws?.userId || null,
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            sessionName: sessionSummary
          });
        }

        // One real, once-generated title per brand-new session: fired after
        // the client already has its answer (turnCompleteSent above), so
        // this can only add latency to the CLI process winding down, never
        // to what the user sees. Must happen before releasePromptStream()
        // below — the control request needs the transport still open.
        if (isBrandNewSession && !titleGenerationTriggered && !abortPending) {
          titleGenerationTriggered = true;
          await generateRealSessionTitle(queryInstance, command);
        }

        settleAdoptedTurn();

        if (backgroundWorkPending || hasLiveBackgroundWork()) {
          // Work started during this turn is still running. Hold the process
          // open so it can finish and report back in a follow-up turn; the
          // ceiling is only a backstop for work that never reports.
          backgroundWorkPending = false;
          holdForBackground();
        } else {
          // Either nothing was backgrounded, or the background work just
          // reported in — let the CLI exit now, as it always has.
          heldForBackgroundWork = false;
          untrackHeldRun(heldToken);
          releasePromptStream();
        }
      } else if (idleReleaseTimer && signalsBackgroundActivity(message)) {
        // Real activity after the turn — push the silence countdown back out.
        // The absolute hold ceiling (heldMaxTimer) is deliberately left alone.
        scheduleRelease();
      }
    }

    // Clean up session on completion — only while this run still owns the map
    // entry. A superseding run may have replaced it, and deleting here would
    // strand that run.
    if (sessionKey() && getSession(sessionKey())?.instance === queryInstance) {
      removeSession(sessionKey());
    }

    // A superseded run winds down silently: the map entry, the abort flag,
    // and all client-facing events belong to the run that replaced it.
    const superseded = supersededInstances.has(queryInstance);

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session, and
    // for runs that already reported completion when their `result` arrived.
    const wasAborted = !superseded && sessionKey() ? abortedSessionIds.delete(sessionKey()) : false;
    if (!turnCompleteSent && !superseded) {
      turnCompleteSent = true;
      if (!wasAborted) {
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
      }
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        sessionName: sessionSummary,
        stopReason: wasAborted ? 'aborted' : 'completed'
      });
    }
    // Complete

  } catch (error) {
    console.error('SDK query error:', error);

    // Clean up session on error — only while this run still owns the map entry
    // (a superseding run may have replaced it).
    if (sessionKey() && getSession(sessionKey())?.instance === queryInstance) {
      removeSession(sessionKey());
    }

    if (supersededInstances.has(queryInstance)) {
      // Interrupted because a newer run took over this session id; that run
      // owns the abort flag and all further client-facing events.
      return;
    }

    const wasAborted = sessionKey() ? abortedSessionIds.delete(sessionKey()) : false;
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
      return;
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await context.isProviderInstalled();
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : error.message;

    // Send error to WebSocket, then the terminal complete. A run that already
    // reported completion and then failed during its post-turn hold still
    // surfaces the error, but must not emit a second terminal complete.
    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    if (!turnCompleteSent) {
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    }
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: sessionId || capturedSessionId || null,
      sessionName: sessionSummary,
      error
    });
  } finally {
    // Always close stdin — otherwise an aborted or failed run leaves the CLI
    // process (and its MCP servers) alive until the server exits.
    if (stallTimer) {
      clearInterval(stallTimer);
    }
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    if (heldMaxTimer) {
      clearTimeout(heldMaxTimer);
      heldMaxTimer = null;
    }
    if (steerFallbackTimer) {
      clearTimeout(steerFallbackTimer);
      steerFallbackTimer = null;
    }
    untrackHeldRun(heldToken);
    settleAdoptedTurn();
    releasePromptStream();
  }
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Mark before interrupting so the run loop knows not to emit its own
    // terminal complete (the abort handler sends the aborted one).
    abortedSessionIds.add(sessionId);

    // Call interrupt() on the query instance
    await session.instance.interrupt();

    // Release the held stdin stream; without this the CLI stays up for the rest
    // of the post-turn hold even though the user cancelled.
    session.releaseInput?.();

    // Update session status
    session.status = 'aborted';

    // Clean up session
    removeSession(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    abortedSessionIds.delete(sessionId);
    return false;
  }
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active';
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
/**
 * «Отправить сейчас»: дописывает сообщение в идущий ход чата.
 * @returns {Promise<boolean>} false — хода нет или он уже отчитался о конце.
 */
async function steerClaudeSDKSession(sessionId, payload) {
  const session = getSession(sessionId);
  if (!session?.steer || session.status !== 'active') {
    return false;
  }
  try {
    return Boolean(await session.steer(payload));
  } catch (error) {
    console.error(`[Claude SDK] не удалось дописать сообщение в ход ${sessionId}:`, error?.message || error);
    return false;
  }
}

/**
 * Новое сообщение человека — новым ходом в процесс, удержанный ради фоновой
 * работы (см. adoptTurn). null — такого процесса нет, нужен обычный запуск.
 */
async function adoptHeldClaudeTurn(sessionId, payload) {
  const session = getSession(sessionId);
  if (!session?.adopt || session.status !== 'active') {
    return null;
  }
  try {
    return (await session.adopt(payload)) || null;
  } catch (error) {
    console.error(`[Claude SDK] не удалось передать сообщение живому процессу ${sessionId}:`, error?.message || error);
    return null;
  }
}

function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

export const claudeRuntime = {
  run: queryClaudeSDK,
  abort: abortClaudeSDKSession,
  steer: steerClaudeSDKSession,
  adopt: adoptHeldClaudeTurn,
  permissions: {
    resolve: resolveToolApproval,
    listPending: getPendingApprovalsForSession,
  },
};

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  steerClaudeSDKSession,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter
};

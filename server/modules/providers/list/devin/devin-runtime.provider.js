import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendFilesInputTag,
  appendImagesInputTag,
} from '@/shared/image-attachments.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import {
  noteSurvivorProviderSession,
  registerProviderRun,
} from '@/modules/providers/list/claude/survivor-runs.js';
import {
  connectSupervisedDevin,
  spawnSupervisedDevin,
} from '@/modules/providers/list/devin/devin-acp-client.js';
import {
  buildDevinChildEnv,
  createCompleteMessage,
  createNormalizedMessage,
  DEVIN_DEFAULT_MODEL,
  isAllowedDevinModel,
  resolveDevinCliCommand,
} from '@/shared/utils.js';
import {
  devinSlotHasCredentials,
  getActiveDevinSlot,
  setActiveDevinSlot,
} from '@/shared/devin-slots.js';
import { mapPermissionModeToDevinMode } from '@/modules/providers/list/devin/devin-sessions.provider.js';
import { readDevinTokenUsage, resolveDevinContextWindow } from '@/modules/providers/list/devin/devin-usage.js';

/**
 * Live Devin ACP processes keyed by the app-facing session id.
 *
 * `abort()` looks a run up here; the entry also carries the flags the stream
 * loop needs (`aborted` suppresses the runtime's own `complete` — the abort
 * handler has already emitted one).
 */
const activeDevinRuns = new Map();

/**
 * Незакрытые запросы разрешений Devin (permission gateway → UI).
 * requestId → { requestId, sessionKey, toolName, input, options, receivedAt,
 * respond, reattached }.
 *
 * `sessionKey` — app-session-id (как у claude: по нему chat.subscribe ищет
 * ожидающие запросы). `respond` пишет JSON-RPC-ответ агенту — напрямую в
 * соединение хода или через сокет супервизора у переподключённого чата.
 */
const pendingPermissions = new Map();

/** Переподключённые после рестарта супервизор-линки по appSessionId. */
const reattachedDevinSurvivors = new Map();

/** How long `abort` lets Devin wind down before SIGKILLing it. */
const ABORT_GRACE_MS = 3_000;
/**
 * Как часто во время хода счётчик читается из sessions.db Devin — ACP
 * `usage_update` и `session/prompt.usage` у Devin нет (04.10.26, живые
 * sock-журналы), поэтому свежесть держим опросом его же базы.
 */
const DEVIN_USAGE_POLL_MS = 4_000;
/** initialize/session/new must answer promptly; a hung handshake = broken CLI. */
const HANDSHAKE_TIMEOUT_MS = 60_000;
/** Devin logs progress to stderr (INFO lines) — keep the tail for error text. */
const STDERR_TAIL_BYTES = 4_000;
/** Пауза перед повтором хода на другом слоте: процесс должен умереть и отпустить замок сессии. */
const FAILOVER_KILL_WAIT_MS = 1_500;
/**
 * session_locked с ЖИВЫМ держателем (11.10.26): беседу обрабатывает
 * другой ACP-процесс, чей ход ещё идёт — «чат занят», а не ошибка.
 * Сколько секунд между проверками «не отпустил ли он замок».
 */
const LOCK_HOLDER_POLL_MS = 2_000;
/** Потолок ожидания живого держателя: ходы Devin длятся десятки минут. */
const LOCK_HOLDER_WAIT_MS = 30 * 60_000;
/** Повторы при зомби-замке (держатель мёртв, замок ещё не снят). */
const LOCK_ZOMBIE_RETRIES = 3;

/**
 * Жив ли процесс-держатель замка беседы и это ли `devin acp`
 * (PID мог достаться другой программе — та же проверка, что
 * survivor-runs делает для переживших агентов).
 */
function isDevinPidAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes('devin') && cmdline.includes('acp');
  } catch {
    return false;
  }
}

/**
 * Ошибка «у аккаунта кончилась квота/лимит» — живой вид (журнал 07.10.26):
 * `session/prompt` отвечает error -32010 «Reached free model rate limit…»,
 * data `{cognition.ai/errorKind:'unavailable', cognition.ai/retryable:true}`.
 * Тот же текст ловим в хвосте stderr на случай, если процесс умер до ответа.
 */
function isDevinQuotaError(error) {
  const kind = error?.data?.['cognition.ai/errorKind'];
  const message = error instanceof Error ? error.message : String(error ?? '');
  return kind === 'unavailable' || /rate limit|limit will reset|quota|insufficient|credits|billing/i.test(message);
}

function isDevinQuotaText(text) {
  return /rate limit|limit will reset|quota|insufficient|credits|billing/i.test(String(text || ''));
}

function sendMessage(ws, data) {
  if (ws && typeof ws.send === 'function') {
    try {
      ws.send(data);
    } catch (error) {
      console.error('Error sending Devin stream message:', error);
    }
  }
}

/**
 * Шлёт вкладке актуальный `token_budget` чата Devin из его sessions.db
 * (заполненность окна по последнему ответу живой цепи). Повтор с тем же
 * `used` не шлём — счётчик и так стоит. Раньше здесь стояло
 * `total = used` из prompt.usage, и кнопка показывала «150K/150K».
 */
function emitDevinTokenBudget(ws, run, appSessionId, { force = false } = {}) {
  const devinSessionId = run.devinSessionId;
  if (!devinSessionId) {
    return;
  }
  let usage = null;
  try {
    usage = readDevinTokenUsage(devinSessionId, { modelHint: run.resolvedModel });
  } catch {
    return; // база занята/недоступна — следующий тик или конец хода дочитает
  }
  if (!usage || (!force && usage.used === run.lastEmittedUsage)) {
    return;
  }
  run.lastEmittedUsage = usage.used;
  sendMessage(ws, createNormalizedMessage({
    provider: 'devin',
    sessionId: appSessionId || devinSessionId,
    kind: 'status',
    text: 'token_budget',
    tokenBudget: {
      used: usage.used,
      total: usage.contextWindow,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      breakdown: usage.breakdown,
      contextTokens: usage.contextTokens,
      contextWindow: usage.contextWindow,
    },
  }));
}

/**
 * Minimal line-delimited JSON-RPC client over one child's stdout/stdin.
 * Devin's ACP stream also emits server-initiated requests
 * (`session/request_permission`, ...) which the runtime answers.
 */
function createAcpConnection(child, { onNotification, onRequest, onClose }) {
  const pending = new Map();
  let nextId = 0;
  let buffer = '';
  let stderrTail = '';
  let closed = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) {
        continue;
      }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // ACP writes INFO logs to stderr, but a stray stdout line must not
        // crash the turn — skip it.
        console.warn('[Devin] Ignoring non-JSON stdout line:', line.slice(0, 200));
        continue;
      }

      if (msg.method && msg.id !== undefined) {
        // Agent-initiated request (permission prompt, fs/*, terminal/*).
        onRequest(msg);
      } else if (msg.method) {
        onNotification(msg);
      } else if (msg.id !== undefined) {
        const waiter = pending.get(msg.id);
        if (waiter) {
          pending.delete(msg.id);
          if (msg.error) {
            const err = new Error(msg.error.message || `JSON-RPC error ${msg.error.code}`);
            err.code = msg.error.code;
            err.data = msg.error.data;
            waiter.reject(err);
          } else {
            waiter.resolve(msg.result ?? {});
          }
        }
      }
    }
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
  });

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    for (const { reject } of pending.values()) {
      reject(new Error('Devin process exited'));
    }
    pending.clear();
    onClose?.();
  };
  child.once('close', close);

  return {
    call(method, params, timeoutMs = 0) {
      if (closed) {
        return Promise.reject(new Error('Devin process already exited'));
      }
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        if (timeoutMs > 0) {
          waiter.timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Devin ACP "${method}" timed out`));
          }, timeoutMs);
          waiter.timer.unref?.();
        }
        pending.set(id, {
          resolve: (value) => { if (waiter.timer) clearTimeout(waiter.timer); resolve(value); },
          reject: (error) => { if (waiter.timer) clearTimeout(waiter.timer); reject(error); },
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method, params) {
      if (closed) {
        return;
      }
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
      } catch {
        // Dead process — nothing to notify.
      }
    },
    respond(id, result) {
      if (closed) {
        return;
      }
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
      } catch {
        // Dead process.
      }
    },
    respondError(id, code, message) {
      if (closed) {
        return;
      }
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
      } catch {
        // Dead process.
      }
    },
    getStderrTail() {
      return stderrTail;
    },
    isClosed() {
      return closed;
    },
  };
}

/**
 * ACP toolCall → имя для баннера разрешения: настоящее имя инструмента из
 * `_meta`, иначе человекочитаемый заголовок (тот же приоритет, что и у
 * tool_call в ленте — devin-sessions.provider.ts readToolName).
 */
function readPermissionToolName(toolCall) {
  const meta = toolCall?._meta && typeof toolCall._meta === 'object' ? toolCall._meta : null;
  const inferenceName = meta?.['cognition.ai/inferenceToolName'];
  if (typeof inferenceName === 'string' && inferenceName.trim()) {
    return inferenceName.trim();
  }
  // Живой запрос разрешения Devin несёт урезанный toolCall: без title/rawInput,
  // только toolCallId + _meta.editableCommand с самой командой (замер 03.10.26).
  const editable = meta?.['cognition.ai/editableCommand'];
  if (typeof editable === 'string' && editable.trim()) {
    return editable.trim().split(/\s+/)[0];
  }
  const title = toolCall?.title;
  return (typeof title === 'string' && title.trim()) || 'Tool';
}

function readPermissionToolInput(toolCall) {
  const input = toolCall?.rawInput;
  if (input && typeof input === 'object' && Object.keys(input).length > 0) {
    return input;
  }
  const editable = toolCall?._meta?.['cognition.ai/editableCommand'];
  if (typeof editable === 'string' && editable.trim()) {
    return { command: editable.trim() };
  }
  return {};
}

/**
 * Выбор ACP-опции по решению человека (ProviderPermissionDecision):
 * «Allow & remember» → allow_always, «Allow once» → allow_once,
 * «Deny» → reject_once. Подходящей опции нет — «отмена» (агент получает
 * cancelled и сам решает, как объяснить отказ).
 */
function pickAcpPermissionOutcome(options, decision) {
  const allows = options.filter((option) => String(option?.kind || '').startsWith('allow_'));
  const rejects = options.filter((option) => String(option?.kind || '').startsWith('reject_'));

  if (decision?.allow) {
    const preferred = decision.rememberEntry ? 'allow_always' : 'allow_once';
    const pick = allows.find((option) => option?.kind === preferred) || allows[0];
    return pick
      ? { outcome: { outcome: 'selected', optionId: pick.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }

  const pick = rejects.find((option) => option?.kind === 'reject_once') || rejects[0];
  return pick
    ? { outcome: { outcome: 'selected', optionId: pick.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

/**
 * Запрос `session/request_permission` от агента → человеку.
 *
 * Регистрирует ожидание в pendingPermissions (его забирает permission
 * gateway), шлёт `permission_request` в ленту и возвращает requestId.
 * Ответа у ACP нет по таймауту — агент ждёт, пока человек не решит
 * (задокументированное поведение: «висеть до ответа — ок»).
 */
function registerPermissionRequest({ request, sessionKey, respond, ws, appSessionId, reattached }) {
  const params = request.params || {};
  const toolCall = params.toolCall || {};
  const options = Array.isArray(params.options) ? params.options : [];
  const requestId = `devin-perm-${randomUUID()}`;

  const entry = {
    requestId,
    sessionKey,
    toolName: readPermissionToolName(toolCall),
    input: readPermissionToolInput(toolCall),
    options,
    receivedAt: new Date(),
    respond,
    reattached: Boolean(reattached),
  };
  pendingPermissions.set(requestId, entry);

  if (ws) {
    sendMessage(ws, createNormalizedMessage({
      provider: 'devin',
      sessionId: appSessionId,
      kind: 'permission_request',
      requestId,
      toolName: entry.toolName,
      input: entry.input,
      context: { options, toolCallId: toolCall?.toolCallId || null },
    }));
  }
  return entry;
}

/** Отменить незакрытые запросы конкретного хода/линка и снять баннер во вкладках. */
function cancelPendingPermissions(sessionKey, ws, appSessionId, { reattachedOnly = false, respondCancelled = true } = {}) {
  for (const [requestId, entry] of [...pendingPermissions]) {
    if (entry.sessionKey !== sessionKey) {
      continue;
    }
    if (reattachedOnly && !entry.reattached) {
      continue;
    }
    pendingPermissions.delete(requestId);
    if (respondCancelled) {
      try {
        entry.respond({ outcome: { outcome: 'cancelled' } });
      } catch {
        // процесс/сокет мёртв — отвечать некому
      }
    }
    if (ws) {
      sendMessage(ws, createNormalizedMessage({
        provider: 'devin',
        sessionId: appSessionId,
        kind: 'permission_cancelled',
        requestId,
        reason: 'run_finished',
      }));
    }
  }
}

/**
 * Ответ на ACP `session/request_permission` внутри живого хода.
 *
 * `bypass` — первый allow_* без человека (режим и так «не спрашивать»).
 * Остальные режимы — запрос уходит в UI (permission_request + gateway);
 * агент стоит, пока человек не ответит. Опций нет вовсе — отмена сразу.
 */
function answerPermissionRequest(request, devinMode, ws, sessionId, run, connection) {
  const params = request.params || {};
  const options = Array.isArray(params.options) ? params.options : [];

  if (devinMode === 'bypass') {
    const allow = options.find((option) => String(option?.kind || '').startsWith('allow_'));
    if (allow) {
      return { outcome: { outcome: 'selected', optionId: allow.optionId } };
    }
    return { outcome: { outcome: 'cancelled' } };
  }

  if (options.length === 0) {
    return { outcome: { outcome: 'cancelled' } };
  }

  const sessionKey = run?.sessionKey || sessionId;
  registerPermissionRequest({
    request,
    sessionKey,
    respond: (result) => connection.respond(request.id, result),
    ws,
    appSessionId: sessionId,
    reattached: false,
  });
  // Ответ уйдёт позже через gateway — сейчас агент просто ждёт.
  return null;
}

/**
 * Сохраняет в ход значения опции `model` из configOptions сессии (ответ
 * session/new / session/load или событие config_option_update). Это список
 * реально доступных аккаунту моделей — он уже каталога CLI.
 */
function noteConfigOptions(run, configOptions) {
  if (!Array.isArray(configOptions)) return;
  const model = configOptions.find((o) => o && o.id === 'model');
  if (!model) return;
  const values = (model.options || []).map((o) => String(o?.value || '')).filter(Boolean);
  if (values.length) run.modelOptions = new Set(values);
  if (typeof model.currentValue === 'string' && model.currentValue) run.modelCurrent = model.currentValue;
  rememberSlotModelOptions(run.slot, run.modelOptions);
}

/**
 * Реальный список моделей активного слота — для пикера выбора модели
 * (devin-models.provider.ts пересекает с ним каталог CLI). Живёт в памяти
 * процесса и в файле, чтобы пережить перезапуск сервера.
 */
const slotModelOptions = new Map(); // slot -> Set<string>
// Путь считается на каждый вызов: тесты подменяют HOME после загрузки модуля.
const slotModelsFile = (slot) => path.join(os.homedir(), '.cloudcli-shared', `devin-model-options-${slot}.json`);

function rememberSlotModelOptions(slot, options) {
  if (!(options instanceof Set) || options.size === 0 || slot == null) return;
  slotModelOptions.set(String(slot), options);
  try {
    fs.mkdirSync(path.dirname(slotModelsFile(slot)), { recursive: true });
    fs.writeFileSync(slotModelsFile(slot), JSON.stringify([...options]));
  } catch { /* список останется в памяти процесса — некритично */ }
}

// Используется devin-models.provider.ts (тот же модуль): пикер моделей
// пересекает каталог `devin models list` с реальным списком активного слота.
export function readSlotModelOptions(slot) {
  const key = String(slot);
  const cached = slotModelOptions.get(key);
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(slotModelsFile(slot), 'utf8');
    const values = JSON.parse(raw);
    if (Array.isArray(values) && values.length) {
      const set = new Set(values.map(String));
      slotModelOptions.set(key, set);
      return set;
    }
  } catch { /* файла ещё нет — до первой сессии список неизвестен */ }
  return null;
}

/**
 * Runs one Devin turn over ACP.
 *
 * Devin's `acp` mode speaks JSON-RPC over stdio and handles one session at a
 * time, so each turn owns a fresh `devin acp` process: `session/load` revives
 * the persisted session when the chat already has a Devin id, otherwise
 * `session/new` allocates one and the id is reported to the writer.
 *
 * Contract with the registry (same as the other CLI runtimes):
 * - `session_created` exactly once for a fresh Devin session,
 * - normalized messages via `context.normalizeMessage(...)`,
 * - `writer.setSessionId(providerId)` as soon as the native id is known,
 * - exactly one terminal `complete` per turn — the registry drops duplicates
 *   emitted after an abort.
 */
async function queryDevin(command, options = {}, ws, context) {
  const {
    sessionId,
    sessionSummary,
    cwd,
    projectPath,
    model,
    images,
    files,
    permissionMode = 'default',
    // Внутренние флаги повтора на другом аккаунте (авто-фейловер по лимиту):
    // devinSessionIdOverride — беседа, уже созданная первой попыткой;
    // slotFailoverDone — повтор был, второй раз не переключаемся.
    devinSessionIdOverride,
    slotFailoverDone,
  } = options;

  const providerSessionId = devinSessionIdOverride ?? context.resolveProviderSessionId(sessionId);

  // Register the run BEFORE the async resolves: `chat.abort` can land while
  // resolveResumeModel is still awaiting — the run must already exist so
  // abort() marks it instead of racing past.
  const run = {
    child: null,
    connection: null,
    writer: ws,
    devinSessionId: providerSessionId || null,
    aborted: false,
    muted: false,
    sessionCreatedSent: Boolean(providerSessionId),
    terminalFailure: null,
    startedAt: Date.now(),
    // Слот, под которым пошёл этот ход, и флаг «убиваем сами ради повтора на
    // другом аккаунте» — onClose такого процесса не должен гасить ход.
    slot: getActiveDevinSlot(),
    slotRetryPending: false,
    unregisterSurvivor: null,
    finishRun: null,
    usageTimer: null,
    lastEmittedUsage: null,
    resolvedModel: null,
    // Значения опции 'model' из configOptions сессии (Set<string>) и её
    // currentValue. Каталог `devin models list` шире: он знает модели, которых
    // у аккаунта слота нет (слот 2: нет swe-2-medium/max, 10.10.26) — выбор их
    // в пикере кончался «Invalid params» на каждом ходу и тихой работой на
    // другой модели. null = список ещё не прислали (старый CLI) — тогда
    // set_config_option шлём вслепую, как раньше.
    modelOptions: null,
    modelCurrent: null,
    modelSetFailed: new Set(),
    modelDowngradeNotified: false,
  };
  const sessionKey = sessionId || providerSessionId;
  run.sessionKey = sessionKey;
  if (sessionKey) {
    activeDevinRuns.set(sessionKey, run);
  }

  // Only SWE-2 may run (owner's rule, 03.10.26): an old chat, a stale tab or a hand-made
  // request naming another model is run on the default SWE-2 instead of spending the quota elsewhere.
  const requestedModel = await context.resolveResumeModel(sessionId, model);
  // Пустая модель тоже заменяется: иначе Devin взял бы модель из своего конфига, а защита держалась бы на внешнем файле.
  const resolvedModel = !requestedModel || !isAllowedDevinModel(requestedModel) ? DEVIN_DEFAULT_MODEL : requestedModel;
  run.resolvedModel = resolvedModel;
  if (resolvedModel !== requestedModel) {
    console.warn(`[Devin] model "${requestedModel}" is not allowed (SWE-2 only) — running ${DEVIN_DEFAULT_MODEL}`);
  }
  // Команды Devin, меняющие модель изнутри чата ("/model opus", "/fusion", "/adaptive"), обошли бы
  // правило «только SWE-2» — до запуска агента такой ход отклоняем.
  if (/^\s*\/(model|fusion|adaptive)\b/i.test(String(command ?? ''))) {
    if (sessionKey) {
      activeDevinRuns.delete(sessionKey);
    }
    sendMessage(ws, createNormalizedMessage({
      provider: 'devin',
      sessionId: sessionId || null,
      kind: 'error',
      content: 'Смена модели Devin запрещена: на этом аккаунте работает только SWE-2.',
    }));
    sendMessage(ws, createCompleteMessage({
      provider: 'devin',
      sessionId: sessionId || null,
      exitCode: 1,
      aborted: false,
    }));
    return;
  }
  const workingDirectory = cwd || projectPath || process.cwd();
  const devinMode = mapPermissionModeToDevinMode(permissionMode);

  const childEnv = buildDevinChildEnv(run.slot);

  // `devin --permission-mode dangerous acp`: the flag is a top-level option
  // (dangerous = alias of bypass), accepted before the subcommand. It covers
  // the window between spawn and `session/set_mode`, when the agent could
  // already raise a permission request. The acp subcommand reads neither
  // --permission-mode nor DEVIN_PERMISSION_MODE.
  const args = [
    ...(permissionMode === 'bypassPermissions' ? ['--permission-mode', 'dangerous'] : []),
    'acp',
  ];
  if (resolvedModel) {
    args.push('--model', resolvedModel);
  }

  // Агент поднимается под супервизором (devin-acp-supervisor): stdin держит
  // он, поэтому ход переживает перезапуск сервера — новый сервер находит
  // сокет по записи live-runs и продолжает отвечать на запросы агента.
  // Супервизор не поднялся — обычный spawn: ход работает, просто не
  // переживёт рестарт (поведение первой фазы).
  const devinCommand = resolveDevinCliCommand();
  let child;
  try {
    child = await spawnSupervisedDevin({
      command: devinCommand,
      args,
      cwd: workingDirectory,
      env: childEnv,
    });
  } catch (supervisorError) {
    console.warn('[Devin] supervisor unavailable, direct spawn:', supervisorError?.message || supervisorError);
    child = spawn(devinCommand, args, {
      cwd: workingDirectory,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  run.child = child;

  // Without an 'error' listener a spawn ENOENT (no devin CLI on PATH) is an
  // uncaughtException — it previously took the whole server down per send.
  const spawnError = { error: null };
  child.once('error', (error) => {
    spawnError.error = error;
  });

  // Aborted while the model was still resolving: kill the just-spawned child
  // and let the connect path fall out via the aborted branch.
  if (run.aborted) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  // The agent survives a site restart: the record lets the next server adopt
  // this process and keep the chat marked busy (survivor-runs.js). Сокет
  // супервизора в записи — чтобы новый сервер переподключился к живому ходу.
  run.unregisterSurvivor = registerProviderRun(child, {
    provider: 'devin',
    appSessionId: sessionKey || null,
    providerSessionId: providerSessionId || null,
    extra: {
      socketPath: child.socketPath || null,
      runId: child.runId || null,
      supervisorPid: child.supervisorPid || null,
    },
  });

  const finish = (exitCode, aborted) => {
    if (run.finishRun) {
      return; // exactly one `complete` per turn
    }
    run.finishRun = true;

    // Ход кончился — висящие запросы разрешений гасим, чтобы баннеры во
    // вкладках не остались навсегда, а агент (если жив) получил cancelled.
    cancelPendingPermissions(sessionKey, ws, sessionId || run.devinSessionId);

    if (run.unregisterSurvivor) {
      run.unregisterSurvivor();
      run.unregisterSurvivor = null;
    }

    if (run.usageTimer) {
      clearInterval(run.usageTimer);
      run.usageTimer = null;
    }

    if (sessionKey) {
      activeDevinRuns.delete(sessionKey);
    }

    try {
      child.kill('SIGTERM');
      const finishKill = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, ABORT_GRACE_MS);
      finishKill.unref?.();
    } catch {
      // Already gone.
    }

    // Процесс пережил и «остановить»: канал к супервизору был мёртв, и агент
    // работает дальше сам по себе (ход реестр счёл завершённым, а его ещё
    // идёт). Запись live-runs заново — она описывает именно такого сироту:
    // следующий сервер его усыновит (adoptSurvivors → reattachSurvivor), а
    // пока он держит замок беседы — новые ходы на неё ждут (см. session/load).
    const orphanCheck = setTimeout(() => {
      if (!child?.pid || !isDevinPidAlive(child.pid)) {
        return;
      }
      try {
        registerProviderRun(child, {
          provider: 'devin',
          appSessionId: sessionKey || null,
          providerSessionId: run.devinSessionId || providerSessionId || null,
          extra: {
            socketPath: child.socketPath || null,
            runId: child.runId || null,
            supervisorPid: child.supervisorPid || null,
          },
        });
        console.warn(`[Devin] процесс ${child.pid} пережил конец хода — оставил живую запись для усыновления (чат ${sessionKey || '?'})`);
      } catch (error) {
        console.warn('[Devin] не удалось вернуть запись о сироте:', error?.message || error);
      }
    }, ABORT_GRACE_MS + LOCK_HOLDER_POLL_MS);
    orphanCheck.unref?.();

    sendMessage(ws, createCompleteMessage({
      provider: 'devin',
      sessionId: run.devinSessionId || sessionId || null,
      exitCode,
      aborted,
    }));
  };

  return await new Promise((resolve, reject) => {
    /**
     * Лимит активного аккаунта → тот же ход заново на другом слоте (Егор
     * 07.10.26: «токены переключаются сами, чаты те же»). Чат не теряется:
     * sessions.db у слотов общая, созданную беседу передаём через
     * devinSessionIdOverride, и повторная попытка делает session/load в неё.
     * Активный слот переключаем насовсем — следующие ходы сразу идут на
     * живой аккаунт. Один раз на сообщение: если и второй слот ограничен —
     * ошибка показывается как раньше. true = повтор запущен, вызывающему
     * коду гасить ход не нужно.
     */
    const failoverToOtherSlot = (error, extraText = '') => {
      if (slotFailoverDone || run.aborted || run.finishRun || run.slotRetryPending) {
        return false;
      }
      if (!isDevinQuotaError(error) && !isDevinQuotaText(extraText)) {
        return false;
      }
      const nextSlot = run.slot === 2 ? 1 : 2;
      if (!devinSlotHasCredentials(nextSlot)) {
        return false; // второго входа нет — переключаться некуда
      }
      run.slotRetryPending = true;
      try {
        setActiveDevinSlot(nextSlot);
      } catch (switchError) {
        // Файл слота не записался (диск/права) — остаёмся на текущем и
        // показываем исходную ошибку лимита, без повтора.
        console.warn('[Devin] не удалось переключить слот:', switchError?.message || switchError);
        run.slotRetryPending = false;
        return false;
      }
      console.warn(`[Devin] лимит слота ${run.slot} — переключаюсь на слот ${nextSlot} и повторяю ход (${sessionKey || 'новый чат'})`);
      sendMessage(ws, createNormalizedMessage({
        provider: 'devin',
        sessionId: sessionId || run.devinSessionId || null,
        kind: 'status',
        text: 'У аккаунта Devin кончился лимит — переключаюсь на другой аккаунт и повторяю…',
      }));
      cancelPendingPermissions(sessionKey, ws, sessionId || run.devinSessionId);
      if (run.unregisterSurvivor) {
        run.unregisterSurvivor();
        run.unregisterSurvivor = null;
      }
      if (run.usageTimer) {
        clearInterval(run.usageTimer);
        run.usageTimer = null;
      }
      // Из activeDevinRuns запись НЕ убираем: надгробие нужно, чтобы «стоп»,
      // нажатый в окне до повтора, находил ход и ставил run.aborted (иначе
      // повтор молча пошёл бы дальше на втором аккаунте).
      try { child.kill('SIGKILL'); } catch { /* уже умер */ }
      // Ждём смерть процесса, чтобы замок сессии отпустил, затем повтор.
      // Уже мёртвому процессу (close случился до failover — ошибка лимита
      // пришла через stderr) ждать нечего — повторяем сразу.
      let resumed = false;
      const resume = () => {
        if (resumed) {
          return;
        }
        resumed = true;
        if (run.aborted) {
          finish(0, true);
          resolve();
          return;
        }
        resolve(queryDevin(command, {
          ...options,
          devinSessionIdOverride: run.devinSessionId || providerSessionId || undefined,
          slotFailoverDone: true,
        }, ws, context));
      };
      if (connection.isClosed()) {
        setImmediate(resume);
      } else {
        child.once('close', resume);
        // Без unref: единственный остающийся таймер обязан дожить до повтора.
        setTimeout(resume, FAILOVER_KILL_WAIT_MS);
      }
      return true;
    };

    const hardFail = (message, extra = {}) => {
      sendMessage(ws, createNormalizedMessage({
        provider: 'devin',
        sessionId: run.devinSessionId || sessionId || null,
        kind: 'error',
        content: message,
        ...extra,
      }));
      finish(1, false);
      reject(new Error(message));
    };

    const connection = createAcpConnection(child, {
      onNotification: (msg) => {
        if (msg.method !== 'session/update') {
          return; // _cognition.ai/* and other control traffic: ignore
        }
        const params = msg.params || {};
        const update = params.update || {};
        // Список доступных аккаунту моделей приходит и событием (после
        // session/set_config_option, смены слота) — держим его свежим.
        if (update.sessionUpdate === 'config_option_update') {
          noteConfigOptions(run, update.configOptions);
        }
        if (run.muted) {
          return; // session/load replays history — never leak it as live deltas
        }
        const normalized = context.normalizeMessage(params.update ?? params, sessionId || run.devinSessionId || null);
        for (const message of normalized) {
          sendMessage(ws, message);
        }
      },

      onRequest: (msg) => {
        if (msg.method === 'session/request_permission') {
          const result = answerPermissionRequest(msg, devinMode, ws, sessionId || run.devinSessionId, run, connection);
          if (result) {
            connection.respond(msg.id, result);
          }
          return;
        }
        // fs/*, terminal/*, unknown agent requests: politely decline so the
        // agent never hangs waiting for an answer.
        connection.respondError(msg.id, -32601, `cc2 does not implement ${msg.method}`);
      },

      onClose: () => {
        if (run.finishRun || run.slotRetryPending) {
          return; // retryPending: процесс убит нами ради повтора на другом слоте
        }
        const tail = connection.getStderrTail();
        const message = run.aborted
          ? 'Devin run aborted'
          : `Devin exited before finishing the turn${tail ? `: ${tail.trim().split('\n').pop()}` : ''}`;
        if (!run.aborted && failoverToOtherSlot(null, `${message} ${tail || ''}`)) {
          return;
        }
        if (!run.aborted) {
          notifyRunFailed({
            userId: ws?.userId || null,
            provider: 'devin',
            sessionId: sessionId || run.devinSessionId || null,
            error: message,
            sessionName: sessionSummary,
          });
        }
        finish(run.aborted ? 0 : 1, run.aborted);
        resolve();
      },
    });
    run.connection = connection;

    (async () => {
      await connection.call('initialize', {
        protocolVersion: 1,
        // Deliberately empty: no fs/terminal client capabilities — Devin then
        // uses its own tools instead of routing calls back through us.
        clientCapabilities: {},
        clientInfo: { name: 'cc2-claude-ui', version: '1.0.0' },
      }, HANDSHAKE_TIMEOUT_MS);

      if (spawnError.error) {
        throw spawnError.error;
      }

      let loaded = false;
      if (providerSessionId) {
        run.muted = true;
        try {
          // session_locked (10.10.26 зомби, 11.10.26 живой держатель):
          // - замок мёртвого процесса — пауза и повтор, как раньше;
          // - замок ЖИВОГО `devin acp` — не ошибка, а «чат занят»: реестр
          //   потерял чужой ход (канал к его супервизору оборвался), и красная
          //   ошибка + потеря сообщения сыпались на каждую отправку. Ждём
          //   конца держателя (он пишет в ту же sessions.db) и грузим сессию —
          //   для человека это обычная очередь «ответ → следующее сообщение».
          let loadResult;
          let lockWaitNotified = false;
          let zombieRetries = 0;
          const lockWaitDeadline = Date.now() + LOCK_HOLDER_WAIT_MS;
          for (;;) {
            try {
              loadResult = await connection.call('session/load', {
                sessionId: providerSessionId,
                cwd: workingDirectory,
                mcpServers: [],
              }, HANDSHAKE_TIMEOUT_MS);
              break;
            } catch (loadError) {
              const retryable = loadError?.data?.['cognition.ai/retryable'] === true
                && loadError?.data?.['cognition.ai/errorKind'] === 'session_locked';
              if (!retryable) {
                throw loadError;
              }
              const holderPid = Number(loadError?.data?.['cognition.ai/lockHolderPid']) || null;
              if (holderPid && isDevinPidAlive(holderPid) && !run.aborted && Date.now() < lockWaitDeadline) {
                if (!lockWaitNotified) {
                  lockWaitNotified = true;
                  console.warn(`[Devin] беседу ${providerSessionId} держит живой процесс ${holderPid} — жду конца его хода`);
                  sendMessage(ws, createNormalizedMessage({
                    provider: 'devin',
                    sessionId: sessionId || run.devinSessionId || null,
                    kind: 'status',
                    text: 'Прошлый ответ в этом чате ещё дописывается — сообщение отправлю, как только он завершится.',
                  }));
                }
                await new Promise((r) => setTimeout(r, LOCK_HOLDER_POLL_MS));
                continue;
              }
              if (run.aborted || Date.now() > lockWaitDeadline || zombieRetries >= LOCK_ZOMBIE_RETRIES) {
                throw loadError;
              }
              zombieRetries += 1;
              console.warn(`[Devin] беседа ${providerSessionId} под замком — повтор session/load через 3 с`);
              await new Promise((r) => setTimeout(r, 3000));
            }
          }
          loaded = true;
          noteConfigOptions(run, loadResult?.configOptions);
        } catch (error) {
          // Беседы с таким номером у Devin нет — продолжать нечего, истории
          // тоже. Начинаем новую вместо ошибки (04.10.26: чат с ложным номером
          // отвечал «Session not found» на каждое сообщение и был мёртв).
          if (error?.data?.['cognition.ai/errorKind'] !== 'session_not_found') {
            throw error;
          }
          console.warn(`[Devin] беседы ${providerSessionId} нет у Devin — начинаю новую`);
          run.devinSessionId = null;
          run.sessionCreatedSent = false;
        } finally {
          run.muted = false;
        }
      }
      if (!loaded) {
        const created = await connection.call('session/new', {
          cwd: workingDirectory,
          mcpServers: [],
        }, HANDSHAKE_TIMEOUT_MS);

        noteConfigOptions(run, created?.configOptions);
        const newId = created?.sessionId;
        if (newId) {
          run.devinSessionId = newId;
          if (typeof ws.setSessionId === 'function') {
            ws.setSessionId(newId);
          }
          // The survivor record can now point at the real Devin session.
          noteSurvivorProviderSession(sessionKey, newId);
          if (!run.sessionCreatedSent) {
            run.sessionCreatedSent = true;
            sendMessage(ws, createNormalizedMessage({
              provider: 'devin',
              sessionId: newId,
              kind: 'session_created',
              newSessionId: newId,
            }));
          }
        }
      }

      if (devinMode) {
        try {
          await connection.call('session/set_mode', {
            sessionId: run.devinSessionId,
            modeId: devinMode,
          }, HANDSHAKE_TIMEOUT_MS);
        } catch (error) {
          console.warn(`[Devin] session/set_mode "${devinMode}" failed:`, error.message);
        }
      }

      if (resolvedModel) {
        // `--model` only covers fresh sessions; a loaded session keeps its
        // stored model unless we set the config option explicitly.
        // The option list is the account's truth: a model the picker offered
        // but the slot doesn't have (swe-2-medium/max on slot 2) would fail
        // with Invalid params on every turn and silently run the old model —
        // so it's skipped and named honestly, once per run.
        const knownUnavailable = run.modelOptions instanceof Set && !run.modelOptions.has(resolvedModel);
        const notifyDowngrade = () => {
          if (run.modelDowngradeNotified) return;
          run.modelDowngradeNotified = true;
          const effective = run.modelCurrent || DEVIN_DEFAULT_MODEL;
          console.warn(`[Devin] model "${resolvedModel}" is not in this account's options — running ${effective}`);
          sendMessage(ws, createNormalizedMessage({
            provider: 'devin',
            sessionId: sessionId || run.devinSessionId || null,
            kind: 'error',
            content: `Модель «${resolvedModel}» недоступна на активном аккаунте Devin — ход идёт на ${effective}.`,
          }));
        };
        if (knownUnavailable || run.modelSetFailed.has(resolvedModel)) {
          notifyDowngrade();
        } else {
          try {
            await connection.call('session/set_config_option', {
              sessionId: run.devinSessionId,
              configId: 'model',
              value: resolvedModel,
            }, HANDSHAKE_TIMEOUT_MS);
          } catch (error) {
            // «Слепой» путь (configOptions не пришли): отказ — та же тихая
            // подмена, что чинит вся эта правка; говорим честно один раз.
            run.modelSetFailed.add(resolvedModel);
            console.warn('[Devin] session/set_config_option model failed:', error.message);
            notifyDowngrade();
          }
        }
      }

      // Attachments ride along as path references (the same <images_input> /
      // <files_input> contract Cursor and OpenCode use): the Devin agent reads
      // them with its own filesystem tools.
      const promptText = appendFilesInputTag(appendImagesInputTag(command, images), files);

      // Пока ход идёт, счётчик читается из sessions.db — Devin пишет туда
      // metrics каждого ответа по ходу работы (см. devin-usage.ts).
      run.usageTimer = setInterval(() => emitDevinTokenBudget(ws, run, sessionId), DEVIN_USAGE_POLL_MS);
      run.usageTimer.unref?.();

      const result = await connection.call('session/prompt', {
        sessionId: run.devinSessionId,
        prompt: [{ type: 'text', text: promptText }],
      });

      if (run.usageTimer) {
        clearInterval(run.usageTimer);
        run.usageTimer = null;
      }

      if (run.aborted) {
        finish(0, true);
        resolve();
        return;
      }

      const stopReason = result?.stopReason;
      // Финальный замер — последний ответ мог дописаться в базу только что.
      emitDevinTokenBudget(ws, run, sessionId, { force: true });
      const usage = result?.usage;
      if (usage && run.lastEmittedUsage === null) {
        // Запасной путь на случай пустого чтения базы: окно берём из
        // каталога модели, а не равным расходу — иначе «150K/150K».
        sendMessage(ws, createNormalizedMessage({
          provider: 'devin',
          sessionId: sessionId || run.devinSessionId || null,
          kind: 'status',
          text: 'token_budget',
          tokenBudget: {
            used: usage.totalTokens ?? 0,
            total: resolveDevinContextWindow(resolvedModel),
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            breakdown: {
              input: usage.inputTokens ?? 0,
              output: usage.outputTokens ?? 0,
            },
          },
        }));
      }

      sendMessage(ws, createNormalizedMessage({
        provider: 'devin',
        sessionId: run.devinSessionId || sessionId || null,
        kind: 'stream_end',
      }));

      if (stopReason === 'end_turn' || stopReason === 'max_tokens') {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'devin',
          sessionId: sessionId || run.devinSessionId || null,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
      }

      finish(stopReason === 'end_turn' || stopReason === 'max_tokens' ? 0 : 1, stopReason === 'cancelled');
      resolve();
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (run.aborted) {
        finish(0, true);
        resolve();
        return;
      }
      if (run.finishRun) {
        // Process died mid-call: onClose already emitted the terminal state —
        // a second error frame after `complete` would just confuse the UI.
        resolve();
        return;
      }
      if (run.slotRetryPending) {
        // Повтор на другом слоте уже запущен из onClose (процесс умер с
        // лимитом в stderr) — отклонённый вызов здесь не должен добивать ход
        // красной ошибкой; промис отпустит resume() из failoverToOtherSlot.
        return;
      }
      const tail = connection.getStderrTail();
      const detail = tail && !message.includes(tail.trim().split('\n').pop() || '')
        ? `${message} — ${tail.trim().split('\n').pop()}`
        : message;
      if (failoverToOtherSlot(error, `${detail} ${tail || ''}`)) {
        return; // лимит аккаунта — ход повторяется на другом слоте
      }
      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'devin',
        sessionId: sessionId || run.devinSessionId || null,
        error: detail,
        sessionName: sessionSummary,
      });
      hardFail(`Devin run failed: ${detail}`);
    });
  });
}

export const devinRuntime = {
  run: (command, options, writer, context) => queryDevin(command, options, writer, context),

  /**
   * Cancels the live turn: asks the agent to stop over ACP, then kills the
   * process if it is still around after a short grace period. The registry
   * emits the terminal `complete` itself for aborted runs.
   */
  abort(sessionId) {
    const run = activeDevinRuns.get(sessionId);
    if (!run) {
      return false;
    }

    run.aborted = true;
    // Человек нажал «стоп» — ждущие разрешения отменяем сразу, не дожидаясь
    // конца grace-периода: баннер исчезает, агент получает cancelled.
    cancelPendingPermissions(sessionId, run.writer, sessionId || run.devinSessionId);
    if (run.devinSessionId && run.connection) {
      run.connection.notify('session/cancel', { sessionId: run.devinSessionId });
    }

    const child = run.child;
    if (child) {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }, ABORT_GRACE_MS);
      timer.unref?.();
    }

    return true;
  },

  /**
   * Permission gateway: `chat.permission-response` из UI приходит сюда через
   * providerRuntimeService, `chat.subscribe` забирает ожидающие listPending'ом.
   */
  permissions: {
    resolve(requestId, decision) {
      const entry = pendingPermissions.get(requestId);
      if (!entry) {
        return;
      }
      pendingPermissions.delete(requestId);
      try {
        entry.respond(pickAcpPermissionOutcome(entry.options, decision));
      } catch {
        // агент/сокет уже мёртв — отвечать некому
      }
      // Ответ ушёл — у переподключённого линка больше может не быть
      // незакрытых запросов: если prompt уже кончился, линк ни к чему.
      maybeReleaseReattach(entry.sessionKey);
    },
    listPending(sessionId) {
      const pending = [];
      for (const entry of pendingPermissions.values()) {
        if (entry.sessionKey === sessionId) {
          pending.push({
            requestId: entry.requestId,
            toolName: entry.toolName,
            input: entry.input,
            context: { options: entry.options },
            sessionId,
            receivedAt: entry.receivedAt,
          });
        }
      }
      return pending;
    },
  },

  /**
   * Переподключение к ходу, пережившему рестарт сервера (survivor-запись с
   * socketPath супервизора). Поднимает незакрытые запросы агента — в первую
   * очередь session/request_permission — обратно в pendingPermissions, чтобы
   * человек мог ответить уже из нового сервера. `emit` — рассылка живого
   * permission_request подписанным вкладкам (запросы, пришедшие после
   * переподключения).
   */
  reattachSurvivor(record, emit) {
    void reattachDevinSurvivor(record, emit).catch((error) => {
      console.warn('[Devin] reattach survivor failed:', error?.message || error);
    });
  },
};

/**
 * Если у переподключённого чата не осталось незакрытых запросов и prompt уже
 * завершён — линк закрываем: супервизор по отключению без prompt'а уберёт
 * простаивающего агента (то же, что делает конец хода).
 */
function maybeReleaseReattach(sessionKey) {
  const state = sessionKey ? reattachedDevinSurvivors.get(sessionKey) : null;
  if (!state || !state.link || state.closed) {
    return;
  }
  const stillPending = [...pendingPermissions.values()].some((entry) => entry.sessionKey === sessionKey);
  if (!stillPending && !state.link.promptInFlight) {
    closeReattach(state);
  }
}

function closeReattach(state) {
  if (state.closed) {
    return;
  }
  state.closed = true;
  reattachedDevinSurvivors.delete(state.sessionKey);
  try {
    state.link?.close();
  } catch {
    // уже закрыт
  }
}

/**
 * Само переподключение: супервизор повторяет неотвеченные запросы агента
 * ({c:'req'}) и дальше шлёт новые строки stdout ({c:'out'}). На каждый
 * session/request_permission — запись в pendingPermissions + живое событие
 * через emit; прочим запросам агента — вежливый отказ, как в ходе.
 * Линк живёт до конца prompt'а (turn_end/exit) — новые запросы могут
 * прийти в любой момент идущего хода.
 */
async function reattachDevinSurvivor(record, emit) {
  const sessionKey = record?.appSessionId;
  const socketPath = record?.socketPath;
  if (!sessionKey || !socketPath || reattachedDevinSurvivors.has(sessionKey)) {
    return;
  }

  const state = {
    sessionKey,
    link: null,
    closed: false,
    seenAcpRequestIds: new Set(),
  };
  reattachedDevinSurvivors.set(sessionKey, state);

  let link;
  try {
    link = await connectSupervisedDevin({
    socketPath,
    onLine(line) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!msg || msg.method === undefined || msg.id === undefined) {
        return; // ответы и уведомления — не наше дело, история в sessions.db
      }
      if (state.seenAcpRequestIds.has(msg.id)) {
        return;
      }
      state.seenAcpRequestIds.add(msg.id);

      if (msg.method === 'session/request_permission') {
        const options = Array.isArray(msg.params?.options) ? msg.params.options : [];
        const entry = registerPermissionRequest({
          request: msg,
          sessionKey,
          respond: (result) => link.writeLine(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })),
          ws: null,
          appSessionId: sessionKey,
          reattached: true,
        });
        // Живой баннер для уже открытой вкладки (subscribe отдаст pending
        // только при следующей подписке).
        if (typeof emit === 'function' && options.length > 0) {
          try {
            emit(createNormalizedMessage({
              provider: 'devin',
              sessionId: sessionKey,
              kind: 'permission_request',
              requestId: entry.requestId,
              toolName: entry.toolName,
              input: entry.input,
              context: { options },
            }));
          } catch {
            // рассылка не удалась — запрос всё равно виден по listPending
          }
        }
        return;
      }
      // fs/*, terminal/*, неизвестные запросы агента — вежливый отказ.
      link.writeLine(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `cc2 does not implement ${msg.method}` },
      }));
    },
    onTurnEnd() {
      // Ход кончился: незакрытые запросы гасим и отпускаем агента — по
      // отключении без prompt'а супервизор его уберёт.
      cancelPendingPermissions(sessionKey, null, sessionKey, { reattachedOnly: true });
      closeReattach(state);
    },
    onExit() {
      cancelPendingPermissions(sessionKey, null, sessionKey, { reattachedOnly: true, respondCancelled: false });
      closeReattach(state);
    },
    onClose() {
      cancelPendingPermissions(sessionKey, null, sessionKey, { reattachedOnly: true, respondCancelled: false });
      closeReattach(state);
    },
    });
  } catch (error) {
    // Сокет не открылся — супервизор мёртв, запись протухла. Убрать отметку,
    // иначе повторная попытка никогда не случится.
    reattachedDevinSurvivors.delete(sessionKey);
    throw error;
  }
  state.link = link;

  // Если в момент подключения ни prompt'а, ни незакрытых запросов — линк не
  // нужен: простаивающего агента супервизор уберёт по нашему отключению.
  const hasPending = [...pendingPermissions.values()].some((entry) => entry.sessionKey === sessionKey);
  if (!hasPending && !link.promptInFlight) {
    closeReattach(state);
  }
}

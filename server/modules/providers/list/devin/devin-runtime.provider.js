import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

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
import { mapPermissionModeToDevinMode } from '@/modules/providers/list/devin/devin-sessions.provider.js';

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
/** initialize/session/new must answer promptly; a hung handshake = broken CLI. */
const HANDSHAKE_TIMEOUT_MS = 60_000;
/** Devin logs progress to stderr (INFO lines) — keep the tail for error text. */
const STDERR_TAIL_BYTES = 4_000;

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
  } = options;

  const providerSessionId = context.resolveProviderSessionId(sessionId);

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
    unregisterSurvivor: null,
    finishRun: null,
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

  const childEnv = buildDevinChildEnv();

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

    sendMessage(ws, createCompleteMessage({
      provider: 'devin',
      sessionId: run.devinSessionId || sessionId || null,
      exitCode,
      aborted,
    }));
  };

  return await new Promise((resolve, reject) => {
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
        if (run.finishRun) {
          return;
        }
        const tail = connection.getStderrTail();
        const message = run.aborted
          ? 'Devin run aborted'
          : `Devin exited before finishing the turn${tail ? `: ${tail.trim().split('\n').pop()}` : ''}`;
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
          await connection.call('session/load', {
            sessionId: providerSessionId,
            cwd: workingDirectory,
            mcpServers: [],
          }, HANDSHAKE_TIMEOUT_MS);
          loaded = true;
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
        try {
          await connection.call('session/set_config_option', {
            sessionId: run.devinSessionId,
            configId: 'model',
            value: resolvedModel,
          }, HANDSHAKE_TIMEOUT_MS);
        } catch (error) {
          console.warn('[Devin] session/set_config_option model failed:', error.message);
        }
      }

      // Attachments ride along as path references (the same <images_input> /
      // <files_input> contract Cursor and OpenCode use): the Devin agent reads
      // them with its own filesystem tools.
      const promptText = appendFilesInputTag(appendImagesInputTag(command, images), files);

      const result = await connection.call('session/prompt', {
        sessionId: run.devinSessionId,
        prompt: [{ type: 'text', text: promptText }],
      });

      if (run.aborted) {
        finish(0, true);
        resolve();
        return;
      }

      const stopReason = result?.stopReason;
      const usage = result?.usage;
      if (usage) {
        sendMessage(ws, createNormalizedMessage({
          provider: 'devin',
          sessionId: run.devinSessionId || sessionId || null,
          kind: 'status',
          text: 'token_budget',
          tokenBudget: {
            used: usage.totalTokens ?? 0,
            total: usage.totalTokens ?? 0,
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
      const tail = connection.getStderrTail();
      const detail = tail && !message.includes(tail.trim().split('\n').pop() || '')
        ? `${message} — ${tail.trim().split('\n').pop()}`
        : message;
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

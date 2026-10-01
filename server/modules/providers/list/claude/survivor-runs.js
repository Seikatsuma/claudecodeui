/**
 * Чаты, переживающие перезапуск сайта.
 *
 * Как было. Агент (процесс `claude`) — дочерний процесс веб-сервера. При
 * остановке сервера SDK на выходе посылает всем своим дочерним процессам
 * SIGTERM, и работа обрывается посреди задачи. Проверено пробой 13.09.26:
 * при штатной остановке родителя агент погибал, не дописав отметку; при
 * мгновенном убийстве родителя (уборка SDK не срабатывает) агент спокойно
 * доводил задачу до конца и дописывал переписку в файл.
 *
 * Как стало. Сервер сам запускает процесс агента (опция SDK
 * `spawnClaudeCodeProcess`) и:
 *   1. на время остановки сервера делает «убить» пустой операцией — уборка
 *      SDK больше не достаёт агентов (systemd тоже их не трогает: у службы
 *      KillMode=process);
 *   2. кладёт на диск запись «процесс PID ведёт чат X» — чтобы новый сервер
 *      после старта нашёл продолжающие работу чаты;
 *   3. после старта «усыновляет» живые записи: чат показывается как
 *      работающий, изменения его переписки рассылаются открытым вкладкам, а
 *      когда процесс закончил — вкладки узнают, что чат свободен. «Стоп»
 *      останавливает такой процесс напрямую.
 *
 * Модуль — лист: ничего из приложения не импортирует, всё, что нужно
 * рассылать, передаётся колбэками из server/index.ts. Иначе получился бы
 * круг импортов с наблюдателем за переписками.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { verifyAgentRoom, wrapInAgentRoom } from './agent-rooms.js';

let shuttingDown = false;
/** appSessionId → { pid, provider, providerSessionId, configDir, eventPath, startedAt, transcriptPath, transcriptMtime } */
const survivors = new Map();
let pollTimer = null;

function liveRunsDir() {
  return process.env.CLOUDCLI_LIVE_RUNS_DIR || path.join(os.homedir(), '.cloudcli-shared', 'live-runs');
}

function recordPath(pid) {
  return path.join(liveRunsDir(), `${pid}.json`);
}

function writeRecord(pid, record) {
  try {
    fs.mkdirSync(liveRunsDir(), { recursive: true });
    fs.writeFileSync(recordPath(pid), JSON.stringify(record));
  } catch (error) {
    console.error('[survivor-runs] запись о запуске не сохранилась:', error?.message || error);
  }
}

/**
 * Registers a provider process which owns its own lifetime rather than the
 * web server's lifetime. Claude uses `spawnSurvivableClaude`; Codex uses a
 * detached worker and calls this immediately after spawning it.
 */
export function registerSurvivableProcess(pid, context = {}) {
  if (!pid || !context.appSessionId) return null;
  const record = {
    pid,
    provider: context.provider || 'claude',
    appSessionId: context.appSessionId,
    providerSessionId: context.providerSessionId || null,
    configDir: context.configDir || null,
    eventPath: context.eventPath || null,
    startedAt: context.startedAt || Date.now(),
  };
  writeRecord(pid, record);
  return recordPath(pid);
}

/** Normal completion while the owning server is still alive. */
export function forgetSurvivableProcess(pid) {
  if (!pid) return;
  removeRecord(pid);
}

function removeRecord(pid) {
  try {
    fs.unlinkSync(recordPath(pid));
  } catch {
    // уже нет — нечего убирать
  }
}

/** Жив ли процесс и это ли всё ещё агент Claude (PID мог достаться другой программе). */
function isAgentAlive(recordOrPid) {
  const record = typeof recordOrPid === 'object'
    ? recordOrPid
    : { pid: recordOrPid, provider: 'claude' };
  const pid = Number(record?.pid);
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (record.provider === 'codex') {
      return cmdline.includes('codex-worker.provider')
        && cmdline.includes('--cloudcli-codex-worker');
    }
    return cmdline.includes('claude') && cmdline.includes('stream-json');
  } catch {
    return false;
  }
}

/** Сервер останавливается: с этого момента «убить агента» — пустая операция. */
export function markShuttingDown() {
  shuttingDown = true;
}

/**
 * Замена стандартного запуска процесса в SDK. Повторяет его один в один
 * (те же каналы, окружение, сигнал отмены), но запоминает PID и не даёт
 * уборке SDK убить агента при остановке сервера.
 */
export function spawnSurvivableClaude(spawnOptions, context = {}) {
  const { cwd, signal } = spawnOptions;
  // Своя комната (cgroup) для агента — см. agent-rooms.js. PID тот же.
  const { command, args, env, room } = wrapInAgentRoom(
    spawnOptions.command, spawnOptions.args, spawnOptions.env, context.appSessionId,
  );
  const child = spawn(command, args, {
    cwd,
    env,
    signal,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });

  verifyAgentRoom(child.pid, room);

  if (child.pid && context.appSessionId) {
    registerSurvivableProcess(child.pid, {
      provider: 'claude',
      appSessionId: context.appSessionId,
      providerSessionId: context.providerSessionId || null,
      configDir: context.configDir || null,
    });
    child.once('exit', () => {
      // Выход во время остановки сервера — не наш случай: сервер умирает, а
      // агент нет. Запись нужна новому серверу.
      if (!shuttingDown) {
        removeRecord(child.pid);
      }
    });
  }

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    kill(sig) {
      if (shuttingDown) {
        return false;
      }
      return child.kill(sig);
    },
    on: child.on.bind(child),
    once: child.once.bind(child),
    off: child.off.bind(child),
  };
}

/** Агент сообщил свой номер разговора — дописать в запись, чтобы найти файл переписки. */
export function noteSurvivorProviderSession(appSessionId, providerSessionId) {
  if (!appSessionId || !providerSessionId) return;
  let files = [];
  try {
    files = fs.readdirSync(liveRunsDir()).filter((name) => name.endsWith('.json'));
  } catch {
    return;
  }
  for (const name of files) {
    const file = path.join(liveRunsDir(), name);
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (record.appSessionId === appSessionId && record.providerSessionId !== providerSessionId) {
        record.providerSessionId = providerSessionId;
        fs.writeFileSync(file, JSON.stringify(record));
      }
    } catch {
      // битая запись — пропускаем
    }
  }
}

function findTranscript(record) {
  if (record.provider === 'codex') return record.eventPath || null;
  if (!record.providerSessionId || !record.configDir) return null;
  const root = path.join(record.configDir, 'projects');
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(root, dir, `${record.providerSessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findCodexTranscript(record) {
  if (!record.providerSessionId) return null;
  const root = path.join(record.configDir || path.join(os.homedir(), '.codex'), 'sessions');
  let names = [];
  try {
    names = fs.readdirSync(root, { recursive: true });
  } catch {
    return null;
  }
  const suffix = `${record.providerSessionId}.jsonl`;
  const relative = names.find((name) => String(name).endsWith(suffix));
  return relative ? path.join(root, String(relative)) : null;
}

function readCodexProviderSession(eventPath) {
  if (!eventPath) return null;
  try {
    const text = fs.readFileSync(eventPath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (event?.type === 'thread.started') {
          return event.thread_id || event.id || null;
        }
      } catch {
        // A final line can still be in flight; keep scanning complete lines.
      }
    }
  } catch {
    // The worker creates the file before the first event; it may still be empty.
  }
  return null;
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

const PHASE_TAIL_BYTES = 512 * 1024;
const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task']);

/**
 * Что переживший агент делает сейчас — по хвосту его переписки.
 *
 * Живого потока у такого чата нет, и плашка до конца работы писала «Ожидает
 * модель». 15.09.26 Егор решил, что чат завис, остановил его и написал «я
 * тебя жду»: на деле 4 минуты шёл проверяющий помощник (105 шагов), а его шаги
 * пишутся в отдельный файл — в переписке чата не менялось ничего. Перезапусков
 * сайта в день бывает больше десяти, и каждый переводит все идущие чаты в это
 * состояние.
 *
 * Правило: незакрытый вызов помощника → `agents` (сколько); незакрытый другой
 * инструмент → `tool` (имя); последним пришёл результат → `reading`; размышление
 * → `thinking`; текст ответа → `writing`; сообщение человека → `requesting`.
 *
 * Незакрытый вызов считается идущим, только пока после него не было ничего,
 * кроме результатов. Прерывание («Стоп») не всегда оставляет результат — бывает
 * просто текст «[Request interrupted…]», — а модель не пишет новый текст, пока
 * ждёт инструмент. Поэтому текст/размышление модели и прерывание закрывают все
 * незакрытые вызовы: иначе плашка вечно писала бы «Работает: Bash» у чата,
 * который давно ждёт человека. Сообщение человека и служебные вставки вызовы НЕ
 * закрывают — они приходят и посреди идущей команды.
 *
 * @returns {{ phase: string, detail: string | null } | null}
 */
export function readTranscriptPhase(transcriptPath) {
  if (!transcriptPath) return null;
  let text;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, PHASE_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString('utf8');
      // Первая строка могла начаться с середины — выбросить.
      if (length < size) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  /** id вызова → имя инструмента, пока нет результата */
  const pending = new Map();
  let last = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // Шаги помощников живут в своих файлах, в переписку чата не попадают.
    if (entry?.isSidechain) continue;
    const content = entry?.message?.content;
    if (entry?.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use' && block.id) {
          pending.set(block.id, String(block.name || ''));
          last = 'tool';
        } else if (block?.type === 'thinking') {
          pending.clear();
          last = 'thinking';
        } else if (block?.type === 'text') {
          pending.clear();
          last = 'writing';
        }
      }
    } else if (entry?.type === 'user') {
      if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) {
        for (const block of content) {
          if (block?.type === 'tool_result') pending.delete(block.tool_use_id);
        }
        last = 'reading';
      } else if (!entry.isMeta && (typeof content === 'string' || Array.isArray(content))) {
        const words = String(typeof content === 'string'
          ? content
          : content.map((block) => (block?.type === 'text' ? block.text : '')).join('')).trimStart();
        if (words.startsWith('[Request interrupted')) {
          // Прерывание: незакрытые вызовы остановлены, этап неизвестен.
          pending.clear();
          last = null;
        } else if (!words.startsWith('<')) {
          // Сообщение человека. Вызовы не закрывает: оно могло встать в
          // очередь, пока команда ещё идёт. Служебные вставки
          // (<task-notification> о фоновой задаче и т.п.) этап не меняют —
          // рядом может идти другой вызов (журнал 7048bba0, 15.09.26).
          last = 'requesting';
        }
      }
    }
  }

  const names = Array.from(pending.values());
  const agents = names.filter((name) => SUBAGENT_TOOL_NAMES.has(name)).length;
  if (agents > 0) return { phase: 'agents', detail: String(agents) };
  if (names.length > 0) return { phase: 'tool', detail: names[names.length - 1] || null };
  if (!last || last === 'tool') return null;
  return { phase: last, detail: null };
}

/** Current Codex phase from the worker's durable raw SDK event stream. */
export function readCodexEventPhase(eventPath) {
  if (!eventPath) return null;
  let text;
  try {
    const fd = fs.openSync(eventPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, PHASE_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString('utf8');
      if (length < size) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  let phase = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === 'turn.completed' || event?.type === 'turn.failed' || event?.type === 'worker.completed') {
      phase = null;
      continue;
    }
    if (event?.type === 'turn.started') {
      phase = { phase: 'thinking', detail: null };
      continue;
    }
    if (!event?.type?.startsWith('item.')) continue;
    const item = event.item;
    switch (item?.type) {
      case 'reasoning':
        phase = { phase: 'thinking', detail: null };
        break;
      case 'agent_message':
        phase = { phase: 'writing', detail: null };
        break;
      case 'command_execution':
        phase = { phase: 'tool', detail: 'Bash' };
        break;
      case 'file_change':
        phase = { phase: 'tool', detail: 'Edit' };
        break;
      case 'mcp_tool_call':
        phase = { phase: 'tool', detail: item.tool || item.server || 'MCP' };
        break;
      case 'web_search':
        phase = { phase: 'tool', detail: 'WebSearch' };
        break;
      case 'todo_list':
        phase = { phase: 'thinking', detail: null };
        break;
      default:
        break;
    }
  }
  return phase;
}

function refreshPhase(survivor) {
  const next = survivor.provider === 'codex'
    ? readCodexEventPhase(survivor.eventPath)
    : readTranscriptPhase(survivor.transcriptPath);
  const changed = (next?.phase ?? null) !== (survivor.phase?.phase ?? null)
    || (next?.detail ?? null) !== (survivor.phase?.detail ?? null);
  survivor.phase = next;
  return changed;
}

/**
 * После старта сервера: найти агентов, переживших прошлый сервер, и следить
 * за ними. `onTranscriptChange(appSessionId)` — переписка изменилась,
 * `onPhase(appSessionId, phase)` — сменился этап работы (см. readTranscriptPhase),
 * `onGone(appSessionId)` — агент закончил.
 *
 * @param {{ onTranscriptChange?: (appSessionId: string, provider: 'claude' | 'codex') => void, onPhase?: (appSessionId: string, phase: { phase: string, detail: string | null } | null, provider: 'claude' | 'codex') => void, onGone?: (appSessionId: string, provider: 'claude' | 'codex') => void, onProviderSession?: (appSessionId: string, providerSessionId: string, provider: 'claude' | 'codex', transcriptPath: string | null) => void, pollMs?: number }} [options]
 */
export function adoptSurvivors({ onTranscriptChange = (_id, _provider) => {}, onPhase = (_id, _phase, _provider) => {}, onGone = (_id, _provider) => {}, onProviderSession = (_id, _providerSessionId, _provider) => {}, pollMs = 3000 } = {}) {
  shuttingDown = false;
  let files = [];
  try {
    files = fs.readdirSync(liveRunsDir()).filter((name) => name.endsWith('.json'));
  } catch {
    files = [];
  }

  for (const name of files) {
    const file = path.join(liveRunsDir(), name);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    record.provider ||= 'claude';
    if (!record?.pid || !record.appSessionId) {
      removeRecord(record?.pid ?? name.replace(/\.json$/, ''));
      continue;
    }
    if (record.provider === 'codex' && !record.providerSessionId) {
      record.providerSessionId = readCodexProviderSession(record.eventPath);
      if (record.providerSessionId) {
        writeRecord(record.pid, record);
      }
    }
    if (record.provider === 'codex' && record.providerSessionId) {
      onProviderSession(record.appSessionId, record.providerSessionId, record.provider, findCodexTranscript(record));
    }
    if (!isAgentAlive(record)) {
      removeRecord(record.pid);
      continue;
    }
    const transcriptPath = findTranscript(record);
    const survivor = {
      ...record,
      transcriptPath,
      transcriptMtime: transcriptPath ? mtimeOf(transcriptPath) : 0,
      phase: null,
    };
    refreshPhase(survivor);
    survivors.set(record.appSessionId, survivor);
    console.log(`[survivor-runs] чат ${record.appSessionId} (${record.provider}) пережил перезапуск (PID ${record.pid}), продолжаю показывать его работу`);
  }

  if (pollTimer) clearInterval(pollTimer);
  if (pollMs > 0) {
    pollTimer = setInterval(() => pollSurvivors({ onTranscriptChange, onPhase, onGone, onProviderSession }), pollMs);
    pollTimer.unref?.();
  }
  return listSurvivors();
}

/**
 * @param {{ onTranscriptChange?: (appSessionId: string, provider: 'claude' | 'codex') => void, onPhase?: (appSessionId: string, phase: { phase: string, detail: string | null } | null, provider: 'claude' | 'codex') => void, onGone?: (appSessionId: string, provider: 'claude' | 'codex') => void, onProviderSession?: (appSessionId: string, providerSessionId: string, provider: 'claude' | 'codex', transcriptPath: string | null) => void }} [options]
 */
export function pollSurvivors({ onTranscriptChange = (_id, _provider) => {}, onPhase = (_id, _phase, _provider) => {}, onGone = (_id, _provider) => {}, onProviderSession = (_id, _providerSessionId, _provider) => {} } = {}) {
  for (const [appSessionId, survivor] of survivors) {
    if (!isAgentAlive(survivor)) {
      survivors.delete(appSessionId);
      removeRecord(survivor.pid);
      onGone(appSessionId, survivor.provider || 'claude');
      continue;
    }
    if (survivor.provider === 'codex' && !survivor.providerSessionId) {
      survivor.providerSessionId = readCodexProviderSession(survivor.eventPath);
      if (survivor.providerSessionId) {
        writeRecord(survivor.pid, survivor);
        onProviderSession(appSessionId, survivor.providerSessionId, survivor.provider, findCodexTranscript(survivor));
      }
    }
    if (!survivor.transcriptPath) {
      survivor.transcriptPath = findTranscript(survivor);
    }
    const mtime = survivor.transcriptPath ? mtimeOf(survivor.transcriptPath) : 0;
    if (mtime && mtime !== survivor.transcriptMtime) {
      survivor.transcriptMtime = mtime;
      onTranscriptChange(appSessionId, survivor.provider || 'claude');
      if (refreshPhase(survivor)) {
        onPhase(appSessionId, survivor.phase, survivor.provider || 'claude');
      }
    }
  }
}

export function isSurvivorRunning(appSessionId) {
  return Boolean(appSessionId) && survivors.has(appSessionId);
}

/** Этап пережившего агента для ответа на подписку вкладки; null — неизвестен или не переживший. */
export function getSurvivorPhase(appSessionId) {
  return survivors.get(appSessionId)?.phase ?? null;
}

export function getSurvivorProvider(appSessionId) {
  return survivors.get(appSessionId)?.provider || null;
}

export function listSurvivors() {
  return Array.from(survivors.values()).map((survivor) => ({
    sessionId: survivor.appSessionId,
    provider: survivor.provider || 'claude',
    startedAt: survivor.startedAt,
    lastSeq: 0,
  }));
}

/** «Стоп» для пережившего перезапуск агента: сервер уже не держит его канал, остаётся сигнал. */
export function stopSurvivor(appSessionId) {
  const survivor = survivors.get(appSessionId);
  if (!survivor) return false;
  try {
    process.kill(survivor.pid, 'SIGTERM');
  } catch {
    // уже завершился
  }
  survivors.delete(appSessionId);
  removeRecord(survivor.pid);
  return true;
}

/** Только для тестов. */
export function resetSurvivorsForTests() {
  survivors.clear();
  shuttingDown = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

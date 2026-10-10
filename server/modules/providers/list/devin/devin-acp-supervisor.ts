/**
 * devin-acp-supervisor — держатель процесса `devin acp`, переживающий
 * перезапуск сервера.
 *
 * Зачем. `devin acp` читает JSON-RPC из stdin: смерть сервера — это EOF на
 * stdin, и агент умирал посреди хода. Супервизор — отдельный процесс
 * (spawn detached + unref): он держит stdin агента открытым, а сервер
 * подключается к нему по unix-сокету и проксирует строки JSON-RPC. Сервер
 * умер — супервизор и агент живут; новый сервер подключается к тому же
 * сокету (путь лежит в записи live-runs) и отвечает на запросы агента.
 *
 * Протокол сокета — JSON-строки:
 *   супервизор → клиент:
 *     {c:'hello', runId, devinPid, supervisorPid, promptInFlight} — сразу
 *       после подключения; promptInFlight = идёт session/prompt.
 *     {c:'req', data:'<строка JSON-RPC>'} — повтор неотвеченного запроса
 *       агента (session/request_permission и пр.): идёт сразу после hello
 *       при переподключении.
 *     {c:'out', data:'<строка stdout агента>'} — каждая строка stdout.
 *     {c:'err', data:'<кусок stderr>'}.
 *     {c:'turn_end'} — пришёл ответ на session/prompt.
 *     {c:'exit', code, signal} — агент завершился.
 *   клиент → супервизор:
 *     {c:'in', data:'<строка JSON-RPC>'} — записать в stdin агента.
 *     {c:'stop', signal?} — убить агента (по умолчанию SIGTERM→SIGKILL 3с).
 *
 * Правило жизни: супервизор нужен, чтобы донести идущий session/prompt
 * через перезапуск. Клиент отключился БЕЗ идущего prompt — агент простаивает
 * и убивается (то же, что делает рантайм после хода). Prompt завершился
 * пока клиента не было — тоже уборка. Новое подключение при идущем prompt —
 * обычная работа дальше.
 *
 * Запуск: `node devin-acp-supervisor.<js|ts> <путь к spec.json>`.
 * Spec: { command, args, cwd, env, socketPath, runId } — файл mode 0600,
 * супервизор удаляет его сразу после чтения.
 *
 * Файл — лист: запускается отдельным процессом, импортов приложения у него
 * быть не может. Синтаксис ограничен стираемыми типами, чтобы `node` мог
 * выполнить и .ts-исходник (type stripping в Node ≥22.18) — в тестах и
 * dev-режиме собранного .js рядом нет.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

type SupervisorSpec = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  socketPath: string;
  runId: string;
};

/** Ждать первого клиента не дольше минуты — иначе агент и супервизор сироты. */
const FIRST_CLIENT_TIMEOUT_MS = 60_000;
/** Сколько SIGTERM ждёт уступок, прежде чем SIGKILL. */
const KILL_GRACE_MS = 3_000;
/**
 * Отключение клиента без идущего prompt — не мгновенный приговор: сервер мог
 * просто переподключиться. Через пару секунд без возврата агент убирается.
 */
const DISCONNECT_REAP_GRACE_MS = 2_000;

const specPath = process.argv[2];
if (!specPath) {
  console.error('[devin-supervisor] spec path required');
  process.exit(2);
}

let spec: SupervisorSpec;
try {
  spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as SupervisorSpec;
} catch (error) {
  console.error('[devin-supervisor] spec unreadable:', (error as Error)?.message || error);
  process.exit(2);
}
// Спека несёт env целиком — не оставляем её лежать на диске.
try { fs.unlinkSync(specPath); } catch { /* уже нет */ }

const logPath = `${spec.socketPath}.log`;
function log(line: string): void {
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // журнал — best effort, не должен ронять супервизор
  }
}

let client: net.Socket | null = null;
/** Первый клиент был — с этого момента отключение клиента решает судьбу агента. */
let hadClient = false;
/** Незавершённый session/prompt — то, ради чего супервизор существует. */
const pendingPromptIds = new Set<string | number>();
/** Запросы агента, на которые клиент ещё не ответил (id → исходная строка). */
const pendingAgentRequests = new Map<string | number, string>();
let childExited = false;
let exitCode: number | null = null;
let exitSignal: NodeJS.Signals | null = null;

const child = spawn(spec.command, spec.args, {
  cwd: spec.cwd,
  env: spec.env as NodeJS.ProcessEnv,
  stdio: ['pipe', 'pipe', 'pipe'],
});
log(`spawned ${spec.command} ${spec.args.join(' ')} pid=${child.pid}`);

function sendClient(payload: Record<string, unknown>): void {
  if (!client) {
    return;
  }
  try {
    client.write(JSON.stringify(payload) + '\n');
  } catch {
    // сокет умер — разберётся on('close')
  }
}

function killChild(signal: NodeJS.Signals = 'SIGTERM'): void {
  try {
    child.kill(signal);
  } catch {
    // уже нет
  }
  if (signal !== 'SIGKILL') {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* уже нет */ }
    }, KILL_GRACE_MS);
    timer.unref();
  }
}

function shutdown(): void {
  try { server.close(); } catch { /* не слушал */ }
  try { fs.unlinkSync(spec.socketPath); } catch { /* уже нет */ }
  // Spec лежит на диске с окружением агента — после выхода он мусор и кредсы
  // в нём держать на диске дольше жизни процесса незачем.
  try { fs.unlinkSync(specPath); } catch { /* уже нет */ }
  log('shutdown');
  process.exit(0);
}

/**
 * Ответ на session/prompt пришёл: ход закончился. Клиенту — метка
 * `turn_end`; без клиента смысла держать агента больше нет — уборка.
 */
function onPromptFinished(): void {
  if (client) {
    sendClient({ c: 'turn_end' });
  } else {
    killChild();
  }
}

/** Разбор одной строки stdout агента: учёт запросов и пересылка клиенту. */
function handleAgentLine(line: string): void {
  let msg: Record<string, unknown> | null = null;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    msg = null;
  }
  if (msg && msg.method !== undefined && msg.id !== undefined) {
    // Запрос агента клиенту — помним до ответа, чтобы повторить новому серверу.
    pendingAgentRequests.set(msg.id as string | number, line);
  } else if (msg && msg.id !== undefined) {
    // Ответ агента на наш запрос.
    if (pendingPromptIds.delete(msg.id as string | number)) {
      sendClient({ c: 'out', data: line });
      onPromptFinished();
      return;
    }
  }
  sendClient({ c: 'out', data: line });
}

/** Разбор одного кадра от клиента. */
function handleClientFrame(frame: Record<string, unknown>): void {
  if (frame.c === 'in' && typeof frame.data === 'string') {
    let msg: Record<string, unknown> | null = null;
    try {
      msg = JSON.parse(frame.data) as Record<string, unknown>;
    } catch {
      msg = null;
    }
    if (msg && msg.id !== undefined) {
      if (msg.method !== undefined) {
        if (msg.method === 'session/prompt') {
          pendingPromptIds.add(msg.id as string | number);
        }
      } else {
        // Ответ на запрос агента — он больше не незавершённый.
        pendingAgentRequests.delete(msg.id as string | number);
      }
    }
    try {
      child.stdin.write(frame.data + '\n');
    } catch {
      // агент мёртв — close разберётся
    }
    return;
  }
  if (frame.c === 'stop') {
    log(`stop requested signal=${typeof frame.signal === 'string' ? frame.signal : 'SIGTERM'}`);
    killChild(typeof frame.signal === 'string' ? (frame.signal as NodeJS.Signals) : 'SIGTERM');
  }
}

let stdoutBuffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  stdoutBuffer += chunk;
  let idx;
  while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
    const line = stdoutBuffer.slice(0, idx).replace(/\r$/, '');
    stdoutBuffer = stdoutBuffer.slice(idx + 1);
    if (line) {
      handleAgentLine(line);
    }
  }
});
child.stderr?.setEncoding('utf8');
child.stderr?.on('data', (chunk: string) => {
  log(`stderr: ${chunk.slice(0, 500).replace(/\n/g, ' | ')}`);
  sendClient({ c: 'err', data: chunk });
});
child.stdin.on('error', () => {
  // EPIPE на убитом агенте — 'close' скажет обо всём сам.
});
child.once('close', (code, signal) => {
  childExited = true;
  exitCode = code;
  exitSignal = signal;
  log(`agent exited code=${code} signal=${signal}`);
  const socket = client;
  if (socket) {
    try {
      // Сначала довести кадр до ядра, потом закрывать — process.exit не
      // дожидается отложенной записи, и 'exit' мог не дойти.
      socket.write(JSON.stringify({ c: 'exit', code, signal }) + '\n', () => {
        try { socket.end(); } catch { /* уже закрыт */ }
      });
    } catch {
      // сокет мёртв
    }
  }
  // Клиент отключится по 'exit' (close → shutdown); 1 с — запасной выход.
  setTimeout(shutdown, 1_000).unref();
});
child.once('error', (error) => {
  log(`agent spawn error: ${error?.message || error}`);
});

// Устаревший сокет прошлого супервизора с этим именем — только мусор.
try { fs.unlinkSync(spec.socketPath); } catch { /* не было */ }

const server = net.createServer((socket) => {
  // Клиент всегда один — самый свежий вытесняет прежний (старый сервер мёртв).
  // Вытеснение без записи в журнале стоило разбора 11.10.26: у рантайма
  // оборвался сокет, ход отпал от реестра, а агент остался жить с замком.
  log(client ? 'client connected (replaces previous)' : 'client connected');
  if (client) {
    try { client.destroy(); } catch { /* уже умер */ }
  }
  client = socket;
  hadClient = true;
  socket.setEncoding('utf8');

  sendClient({
    c: 'hello',
    runId: spec.runId,
    devinPid: child.pid,
    supervisorPid: process.pid,
    promptInFlight: pendingPromptIds.size > 0,
  });
  for (const line of pendingAgentRequests.values()) {
    sendClient({ c: 'req', data: line });
  }
  if (childExited) {
    sendClient({ c: 'exit', code: exitCode, signal: exitSignal });
  }

  let buffer = '';
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!raw) {
        continue;
      }
      let frame: Record<string, unknown> | null = null;
      try {
        frame = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        frame = null;
      }
      if (frame) {
        handleClientFrame(frame);
      }
    }
  });
  socket.on('error', () => {
    // Сокет умер — разбираемся в 'close'.
  });
  socket.on('close', () => {
    log(`client disconnected${pendingPromptIds.size > 0 ? ' (prompt in flight)' : ''}`);
    if (client === socket) {
      client = null;
    }
    if (childExited) {
      shutdown();
      return;
    }
    // Смысл супервизора — донести идущий ход. Без клиента и без prompt
    // держать агента незачем: это тот же конец хода, что делает рантайм.
    // Отсрочка на пару секунд — переподключение не должно убивать агента.
    if (pendingPromptIds.size === 0) {
      const timer = setTimeout(() => {
        if (!client && !childExited && pendingPromptIds.size === 0) {
          killChild();
        }
      }, DISCONNECT_REAP_GRACE_MS);
      timer.unref();
    }
  });
});

server.on('error', (error) => {
  log(`server error: ${(error as Error)?.message || error}`);
  shutdown();
});
server.listen(spec.socketPath, () => {
  log(`listening ${spec.socketPath}`);
});

// Никто не подключился — сервер умер до нас. Бесхозный агент не нужен.
const firstClientTimer = setTimeout(() => {
  if (!hadClient) {
    log('no client within 60s — reaping');
    killChild();
  }
}, FIRST_CLIENT_TIMEOUT_MS);
firstClientTimer.unref();

process.on('SIGTERM', () => {
  killChild('SIGKILL');
  shutdown();
});
process.on('SIGINT', () => {
  killChild('SIGKILL');
  shutdown();
});

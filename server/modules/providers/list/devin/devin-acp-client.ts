/**
 * Клиентская сторона devin-acp-supervisor (см. devin-acp-supervisor.ts).
 *
 * `spawnSupervisedDevin` поднимает супервизора отдельным detached-процессом,
 * подключается к его unix-сокету и возвращает объект с тем же срезом
 * интерфейса, который рантайм ждёт от ChildProcess (stdin/stdout/stderr,
 * pid, kill, close/exit) — `createAcpConnection` работает с ним без правок.
 *
 * `connectSupervisedDevin` — подключение к уже живому супервизору (запись
 * socketPath берётся из live-runs): так новый сервер отвечает на незакрытые
 * запросы агента (session/request_permission) после перезапуска.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Рядом с этим файлом — в dist-server собранный .js, в исходниках .ts. */
function resolveSupervisorScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const name of ['devin-acp-supervisor.js', 'devin-acp-supervisor.ts']) {
    const candidate = path.join(here, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`devin-acp-supervisor script not found next to ${here}`);
}

/** Каталог сокетов/спеков супервизоров; CLOUDCLI_DEVIN_RUNS_DIR — для тестов. */
export function devinRunsDir(): string {
  return process.env.CLOUDCLI_DEVIN_RUNS_DIR?.trim()
    || path.join(os.homedir(), '.cloudcli-shared', 'devin-runs');
}

export type SupervisedDevinSpec = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
};

/** Тот кусок ChildProcess, который нужен рантайму и survivor-реестру. */
export type SupervisedDevinChild = {
  pid: number | null;
  supervisorPid: number | null;
  runId: string;
  socketPath: string;
  stdin: { write(data: string): void };
  stdout: EventEmitter & { setEncoding(enc: string): void };
  stderr: EventEmitter & { setEncoding(enc: string): void };
  killed: boolean;
  exitCode: number | null;
  kill(signal?: string): boolean;
  /**
   * Просто отключиться от супервизора — НЕ убивая агента. Так устроена смерть
   * сервера: сокет рвётся, агент живёт дальше по правилам супервизора.
   */
  disconnect(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
};

type SocketFrame = Record<string, unknown> & { c?: string };

/** Разбор кадров сокета в события виртуального процесса. */
function attachFrameReader(socket: net.Socket, handlers: {
  onOut(line: string): void;
  onErr(chunk: string): void;
  onHello(hello: SocketFrame): void;
  onReq(line: string): void;
  onTurnEnd(): void;
  onExit(code: number | null, signal: string | null): void;
  onSocketClose(): void;
}): void {
  socket.setEncoding('utf8');
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
      let frame: SocketFrame | null = null;
      try {
        frame = JSON.parse(raw) as SocketFrame;
      } catch {
        frame = null;
      }
      if (!frame) {
        continue;
      }
      switch (frame.c) {
        case 'hello':
          handlers.onHello(frame);
          break;
        case 'out':
          if (typeof frame.data === 'string') handlers.onOut(frame.data);
          break;
        case 'req':
          if (typeof frame.data === 'string') handlers.onReq(frame.data);
          break;
        case 'err':
          if (typeof frame.data === 'string') handlers.onErr(frame.data);
          break;
        case 'turn_end':
          handlers.onTurnEnd();
          break;
        case 'exit':
          handlers.onExit(
            typeof frame.code === 'number' ? frame.code : null,
            typeof frame.signal === 'string' ? frame.signal : null,
          );
          break;
        default:
          break;
      }
    }
  });
  socket.on('close', () => handlers.onSocketClose());
  socket.on('error', () => {
    // Разрыв виден в 'close'.
  });
}

function writeFrame(socket: net.Socket, frame: Record<string, unknown>): void {
  try {
    socket.write(JSON.stringify(frame) + '\n');
  } catch {
    // сокет умер — 'close' обработает
  }
}

function fakePipe(): EventEmitter & { setEncoding(enc: string): void } {
  const emitter = new EventEmitter() as EventEmitter & { setEncoding(enc: string): void };
  emitter.setEncoding = () => emitter;
  return emitter;
}

type FrameHandlers = Parameters<typeof attachFrameReader>[1];

function makeVirtualChild(socket: net.Socket, hello: SocketFrame, socketPath: string, handlers: FrameHandlers): SupervisedDevinChild {
  const emitter = new EventEmitter();
  const stdout = fakePipe();
  const stderr = fakePipe();
  const state = {
    killed: false,
    exited: false,
    exitCode: null as number | null,
  };

  const child: SupervisedDevinChild = {
    pid: typeof hello.devinPid === 'number' ? hello.devinPid : null,
    supervisorPid: typeof hello.supervisorPid === 'number' ? hello.supervisorPid : null,
    runId: typeof hello.runId === 'string' ? hello.runId : '',
    socketPath,
    stdin: {
      write(data: string) {
        for (const line of data.split('\n')) {
          if (line) {
            writeFrame(socket, { c: 'in', data: line });
          }
        }
      },
    },
    stdout,
    stderr,
    get killed() {
      return state.killed;
    },
    get exitCode() {
      return state.exitCode;
    },
    kill(signal?: string) {
      state.killed = true;
      writeFrame(socket, { c: 'stop', signal: signal || 'SIGTERM' });
      return true;
    },
    disconnect() {
      try { socket.end(); } catch { /* уже закрыт */ }
    },
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
  };

  // Читатель сокета уже стоит (он же дождался hello): перенаправляем кадры
  // в эмиттеры процесса — ни одна строка между hello и этой точкой не теряется.
  handlers.onHello = () => {};
  handlers.onOut = (line) => stdout.emit('data', `${line}\n`);
  handlers.onErr = (chunk) => stderr.emit('data', chunk);
  handlers.onReq = (line) => {
    // Повтор неотвеченного запроса агента — для слушателя та же строка stdout.
    stdout.emit('data', `${line}\n`);
  };
  handlers.onTurnEnd = () => {};
  handlers.onExit = (code, signal) => {
    if (state.exited) {
      return;
    }
    state.exited = true;
    state.exitCode = code;
    emitter.emit('exit', code, signal);
    emitter.emit('close', code, signal);
    try { socket.end(); } catch { /* уже закрыт */ }
  };
  handlers.onSocketClose = () => {
    if (state.exited) {
      return;
    }
    // Супервизор умер/порвал связь — для хода это смерть процесса.
    state.exited = true;
    emitter.emit('exit', null, null);
    emitter.emit('close', null, null);
  };

  return child;
}

function connectToSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', (error) => reject(error));
  });
}

async function connectWithRetry(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await connectToSocket(socketPath);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw (lastError instanceof Error ? lastError : new Error(`connect ${socketPath} timed out`));
}

/**
 * Поднять `devin acp` под супервизором и вернуть виртуальный процесс.
 * Бросает ошибку, если супервизор не поднялся/не ответил — вызывающий решает,
 * откатываться ли на прямой spawn.
 */
export async function spawnSupervisedDevin(
  spec: SupervisedDevinSpec,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<SupervisedDevinChild> {
  const runsDir = devinRunsDir();
  fs.mkdirSync(runsDir, { recursive: true });
  const runId = randomUUID();
  const socketPath = path.join(runsDir, `${runId}.sock`);
  const specPath = path.join(runsDir, `${runId}.spec.json`);
  // env несёт креды — спек только для супервизора, читается один раз и стирается.
  fs.writeFileSync(specPath, JSON.stringify({ ...spec, socketPath, runId }), { mode: 0o600 });

  const supervisor = spawn(process.execPath, [resolveSupervisorScriptPath(), specPath], {
    detached: true,
    stdio: 'ignore',
  });
  supervisor.unref();
  supervisor.once('error', () => {
    // Сам спавн не удался — соединение ниже исчерпает retries и бросит.
  });

  const socket = await connectWithRetry(socketPath, timeoutMs);
  const handlers: FrameHandlers = {
    onHello() {},
    onOut() {},
    onErr() {},
    onReq() {},
    onTurnEnd() {},
    onExit() {},
    onSocketClose() {},
  };
  attachFrameReader(socket, handlers);
  const hello = await new Promise<SocketFrame>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('devin supervisor hello timed out')), timeoutMs);
    timer.unref?.();
    handlers.onHello = (frame) => {
      clearTimeout(timer);
      resolve(frame);
    };
    handlers.onSocketClose = () => {
      clearTimeout(timer);
      reject(new Error('devin supervisor socket closed before hello'));
    };
  });

  return makeVirtualChild(socket, hello, socketPath, handlers);
}

export type SupervisedDevinLink = {
  devinPid: number | null;
  promptInFlight: boolean;
  closed: boolean;
  /** Отправить строку JSON-RPC агенту (ответы на его запросы и т.п.). */
  writeLine(line: string): void;
  /** Попросить супервизор убить агента. */
  stop(signal?: string): void;
  /** Отключиться; агент дальше живёт по правилам супервизора. */
  close(): void;
};

/**
 * Подключение к живому супервизору без нового агента — сценарий
 * переподключения после рестарта сервера. `onLine` получает и свежие строки
 * stdout, и повторы неотвеченных запросов (`replayed=true`).
 */
export async function connectSupervisedDevin(options: {
  socketPath: string;
  onLine?: (line: string, replayed: boolean) => void;
  onTurnEnd?: () => void;
  onExit?: (code: number | null, signal: string | null) => void;
  onClose?: () => void;
  timeoutMs?: number;
}): Promise<SupervisedDevinLink> {
  const { socketPath } = options;
  const socket = await connectWithRetry(socketPath, options.timeoutMs ?? 10_000);

  const link: SupervisedDevinLink = {
    devinPid: null,
    promptInFlight: false,
    closed: false,
    writeLine(line: string) {
      writeFrame(socket, { c: 'in', data: line });
    },
    stop(signal?: string) {
      writeFrame(socket, { c: 'stop', signal: signal || 'SIGTERM' });
    },
    close() {
      if (link.closed) {
        return;
      }
      link.closed = true;
      try { socket.end(); } catch { /* уже закрыт */ }
    },
  };

  attachFrameReader(socket, {
    onHello(hello) {
      link.devinPid = typeof hello.devinPid === 'number' ? hello.devinPid : null;
      link.promptInFlight = Boolean(hello.promptInFlight);
    },
    onOut(line) {
      options.onLine?.(line, false);
    },
    onErr() {
      // stderr супервизора reattach-ю не нужен.
    },
    onReq(line) {
      options.onLine?.(line, true);
    },
    onTurnEnd() {
      link.promptInFlight = false;
      options.onTurnEnd?.();
    },
    onExit(code, signal) {
      options.onExit?.(code, signal);
      link.close();
    },
    onSocketClose() {
      if (!link.closed) {
        link.closed = true;
        options.onClose?.();
      } else {
        options.onClose?.();
      }
    },
  });

  // hello мог пройти до attachFrameReader — дождаться его через кадр наверняка
  // нельзя, поэтому ждём, пока поля заполнятся (attach стоит сразу после
  // connect, кадры в ядре не теряются).
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (link.devinPid === null && !link.closed && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return link;
}

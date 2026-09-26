import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pty, { type IPty } from 'node-pty';
import { WebSocket, type RawData } from 'ws';

import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';
import { OPEN_REGISTRATION, parseIncomingJsonObject } from '@/shared/utils.js';
import {
  readRequestUserId,
  resolveWebUserRuntimeContext,
  withoutInheritedClaudeAuth,
} from '@/shared/web-user-runtime.js';

type ShellIncomingMessage = {
  type?: string;
  data?: string;
  cols?: number;
  rows?: number;
  projectPath?: string;
  sessionId?: string;
  hasSession?: boolean;
  provider?: string;
  initialCommand?: string;
  isPlainShell?: boolean;
  /** Имя окна командной строки: у каждого окна свой процесс. */
  terminalId?: string;
  forceRestart?: boolean;
};

/**
 * Кольцевой буфер вывода PTY: кусочки вывода — в очередь, общий размер в
 * байтах ограничен и старые куски отбрасываются по мере поступления новых.
 *
 * Пока лимит стоял в «числе кусков» (5000), никто не знал, сколько это байт.
 * Скрипт с длинными строками мог накопить десятки МБ на одну спрятанную
 * вкладку — при восьми окнах это лишние сотни мегабайт «на всякий случай».
 * Теперь предел — фиксированный размер в байтах на окно, и он одинаковый
 * для всех сессий.
 */
type PtyOutputBuffer = {
  chunks: string[];
  bytes: number;
};

type PtySessionEntry = {
  pty: IPty;
  ws: WebSocket | null;
  buffer: PtyOutputBuffer;
  /**
   * Снапшот экрана, снятый клиентом перед уходом (xterm-addon-serialize).
   * Возвращённый клиент применяет его до того, как получит буфер догона —
   * так экран восстанавливается визуально идентичным, а не «сверху вниз с
   * половиной ANSI-последовательностей», которая раньше рисовала мусор.
   */
  snapshot: string | null;
  timeoutId: NodeJS.Timeout | null;
  projectPath: string;
  sessionId: string | null;
};

/** 512 КБ на окно: хватает на несколько тысяч строк даже с цветом. */
const PTY_BUFFER_MAX_BYTES = 512 * 1024;

function appendToBuffer(buffer: PtyOutputBuffer, chunk: string): void {
  buffer.chunks.push(chunk);
  buffer.bytes += chunk.length;
  while (buffer.bytes > PTY_BUFFER_MAX_BYTES && buffer.chunks.length > 1) {
    const dropped = buffer.chunks.shift();
    if (dropped !== undefined) {
      buffer.bytes -= dropped.length;
    }
  }
}

function drainBufferToString(buffer: PtyOutputBuffer): string {
  return buffer.chunks.join('');
}

const ptySessionsMap = new Map<string, PtySessionEntry>();
const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;
const SHELL_URL_PARSE_BUFFER_LIMIT = 32768;
const ANSI_ESCAPE_SEQUENCE_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const TRAILING_URL_PUNCTUATION_REGEX = /[)\]}>.,;:!?]+$/;

function stripAnsiSequences(value: string): string {
  return value.replace(ANSI_ESCAPE_SEQUENCE_REGEX, '');
}

function normalizeDetectedUrl(url: string): string | null {
  const cleanedUrl = url.trim().replace(TRAILING_URL_PUNCTUATION_REGEX, '');
  if (!cleanedUrl) {
    return null;
  }

  try {
    const parsedUrl = new URL(cleanedUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return null;
    }
    return parsedUrl.toString();
  } catch {
    return null;
  }
}

function extractUrlsFromText(value: string): string[] {
  const directMatches = value.match(/https?:\/\/[^\s<>"'`\\\x1b\x07]+/gi) ?? [];

  // Terminal width can split a URL across lines, so valid URL characters on
  // immediately following lines are joined before the URL is validated.
  const wrappedMatches: string[] = [];
  const urlContinuationPattern = /^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/;
  const lines = value.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex].trim();
    const startMatch = line.match(/https?:\/\/[^\s<>"'`\\\x1b\x07]+/i);
    if (!startMatch) {
      continue;
    }

    let combinedUrl = startMatch[0];
    let continuationIndex = lineIndex + 1;
    while (continuationIndex < lines.length) {
      const continuation = lines[continuationIndex].trim();
      if (!continuation || !urlContinuationPattern.test(continuation)) {
        break;
      }
      combinedUrl += continuation;
      continuationIndex += 1;
    }

    wrappedMatches.push(combinedUrl);
  }

  return Array.from(new Set([...directMatches, ...wrappedMatches]));
}

function shouldAutoOpenUrlFromOutput(value: string): boolean {
  const normalizedOutput = value.toLowerCase();
  return (
    normalizedOutput.includes("browser didn't open") ||
    normalizedOutput.includes('open this url') ||
    normalizedOutput.includes('continue in your browser') ||
    normalizedOutput.includes('press enter to open') ||
    normalizedOutput.includes('open_url:')
  );
}

type ShellWebSocketDependencies = {
  resolveProviderSessionId: (
    sessionId: string,
    provider: string,
  ) => string | null | undefined;
  spawnPty?: typeof pty.spawn;
};

/**
 * Reads a string field from untyped payloads and falls back when absent.
 */
function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Reads a boolean field from untyped payloads and falls back when absent.
 */
function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Reads a finite number field from untyped payloads and falls back when absent.
 */
function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Parses incoming websocket shell messages and keeps processing safe when
 * malformed payloads are received.
 */
function parseShellMessage(rawMessage: RawData): ShellIncomingMessage | null {
  const payload = parseIncomingJsonObject(rawMessage);
  if (!payload) {
    return null;
  }

  return payload as ShellIncomingMessage;
}

const SAFE_SESSION_ID_PATTERN = /^[a-zA-Z0-9_.\-:]+$/;

function resolveResumeSessionId(
  message: ShellIncomingMessage,
  dependencies: ShellWebSocketDependencies
): string {
  const hasSession = readBoolean(message.hasSession);
  const sessionId = readString(message.sessionId);
  const provider = readString(message.provider, 'claude');

  if (!hasSession || !sessionId) {
    return '';
  }

  let resumeSessionId: string | null | undefined;
  try {
    resumeSessionId = dependencies.resolveProviderSessionId(sessionId, provider);
  } catch (error) {
    console.error('Failed to resolve provider session ID:', error);
    resumeSessionId = undefined;
  }

  const resolvedSessionId = resumeSessionId === undefined ? sessionId : resumeSessionId;
  if (!resolvedSessionId || !SAFE_SESSION_ID_PATTERN.test(resolvedSessionId)) {
    return '';
  }

  return resolvedSessionId;
}

/**
 * Resolves provider command line for plain shell and agent-backed shell modes.
 */
function buildShellCommand(
  message: ShellIncomingMessage,
  dependencies: ShellWebSocketDependencies
): string {
  const hasSession = readBoolean(message.hasSession);
  const initialCommand = readString(message.initialCommand);
  const provider = readString(message.provider, 'claude');
  const resumeSessionId = resolveResumeSessionId(message, dependencies);
  const isPlainShell =
    readBoolean(message.isPlainShell) ||
    (!!initialCommand && !hasSession) ||
    provider === 'plain-shell';

  if (isPlainShell) {
    return initialCommand;
  }

  if (provider === 'cursor') {
    if (resumeSessionId) {
      return `cursor-agent --resume="${resumeSessionId}"`;
    }
    return 'cursor-agent';
  }

  if (provider === 'codex') {
    if (resumeSessionId) {
      if (os.platform() === 'win32') {
        return `codex resume "${resumeSessionId}"; if ($LASTEXITCODE -ne 0) { codex }`;
      }
      return `codex resume "${resumeSessionId}" || codex`;
    }
    return 'codex';
  }

  if (provider === 'opencode') {
    if (resumeSessionId) {
      return `opencode --session "${resumeSessionId}"`;
    }
    return initialCommand || 'opencode';
  }

  const command = initialCommand || 'claude';
  if (resumeSessionId) {
    if (os.platform() === 'win32') {
      return `claude --resume "${resumeSessionId}"; if ($LASTEXITCODE -ne 0) { claude }`;
    }
    return `claude --resume "${resumeSessionId}" || claude`;
  }
  return command;
}

function readEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const resolvedKey = Object.keys(env).find((envKey) => envKey.toLowerCase() === key.toLowerCase());
  return resolvedKey ? env[resolvedKey] : undefined;
}

function getPathEnvKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
}

function prioritizeUserNpmGlobalBin(env: NodeJS.ProcessEnv): { key: string; value: string | undefined } {
  const pathKey = getPathEnvKey(env);
  const currentPath = env[pathKey];
  if (!currentPath) {
    return { key: pathKey, value: currentPath };
  }

  const delimiter = path.delimiter;
  const pathEntries = currentPath.split(delimiter).filter(Boolean);
  const npmPrefix = readEnvValue(env, 'npm_config_prefix');
  const appData = readEnvValue(env, 'APPDATA');
  const candidates = [
    npmPrefix || '',
    npmPrefix ? path.join(npmPrefix, 'bin') : '',
    appData ? path.join(appData, 'npm') : '',
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
    path.join(os.homedir(), '.npm-global', 'bin'),
  ].filter(Boolean);

  const normalizedPathEntries = pathEntries.map((entry) => os.platform() === 'win32' ? entry.toLowerCase() : entry);
  const preferredEntries = candidates.filter((candidate, index) => {
    const normalizedCandidate = os.platform() === 'win32' ? candidate.toLowerCase() : candidate;
    return (
      candidates.indexOf(candidate) === index &&
      normalizedPathEntries.includes(normalizedCandidate)
    );
  });

  if (preferredEntries.length === 0) {
    return { key: pathKey, value: currentPath };
  }

  const normalizedPreferredEntries = preferredEntries.map((entry) =>
    os.platform() === 'win32' ? entry.toLowerCase() : entry
  );

  const value = [
    ...preferredEntries,
    ...pathEntries.filter((entry) => {
      const normalizedEntry = os.platform() === 'win32' ? entry.toLowerCase() : entry;
      return !normalizedPreferredEntries.includes(normalizedEntry);
    }),
  ].join(delimiter);

  return { key: pathKey, value };
}

/**
 * Used by this module's websocket gateway to connect the standalone Shell UI
 * to a retained PTY while keeping process lifecycle ownership on the server.
 */
export function handleShellConnection(
  ws: WebSocket,
  dependencies: ShellWebSocketDependencies,
  request?: AuthenticatedWebSocketRequest
): void {
  console.log('[INFO] Shell websocket connected');

  // Чей это терминал. Без этого процесс оболочки наследовал каталог настроек
  // сервера — общий, владельца площадки, — и `/login`, набранный в терминале
  // любым приглашённым, менял аккаунт владельцу. Подробности и разбор случая
  // 12.09.26 — в shared/web-user-runtime.ts.
  const runtimeContext = resolveWebUserRuntimeContext(readRequestUserId(request));

  // Не смогли определить, чей это терминал, — не открываем его вовсе. Молча
  // запустить оболочку в общем каталоге значит дать незнакомцу писать в
  // настройки владельца площадки; отказ здесь неприятен, но честен.
  if (OPEN_REGISTRATION && !runtimeContext.claudeConfigDir) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Не удалось определить пользователя — командная строка не открыта. Войдите заново.',
      }));
      ws.close();
    }
    return;
  }

  let shellProcess: IPty | null = null;
  let ptySessionKey: string | null = null;
  let urlDetectionBuffer = '';
  const announcedAuthUrls = new Set<string>();

  ws.on('message', async (rawMessage) => {
    try {
      const data = parseShellMessage(rawMessage);
      if (!data?.type) {
        throw new Error('Invalid websocket payload');
      }

      if (data.type === 'init') {
        const projectPath = readString(data.projectPath, process.cwd());
        const sessionId = readString(data.sessionId) || null;
        const hasSession = readBoolean(data.hasSession);
        const provider = readString(data.provider, 'claude');
        const initialCommand = readString(data.initialCommand);
        const forceRestart = readBoolean(data.forceRestart);
        const isPlainShell =
          readBoolean(data.isPlainShell) ||
          (!!initialCommand && !hasSession) ||
          provider === 'plain-shell';

        urlDetectionBuffer = '';
        announcedAuthUrls.clear();

        const isLoginCommand =
          !!initialCommand &&
          (initialCommand.includes('setup-token') ||
            initialCommand.includes('cursor-agent login') ||
            initialCommand.includes('auth login'));

        const commandSuffix =
          isPlainShell && initialCommand
            ? `_cmd_${Buffer.from(initialCommand).toString('base64').slice(0, 16)}`
            : '';
        // Имя окна входит в ключ.
        //
        // Без него две открытые командные строки в одной папке получали один и
        // тот же ключ и цеплялись к ОДНОМУ процессу: второе окно писало
        // «переподключился к существующему сеансу» и повторяло всё, что
        // набирали в первом. Отдельные окна — отдельные процессы; при обрыве
        // связи окно с тем же именем вернётся в свой.
        const terminalId = readString(data.terminalId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
        const terminalSuffix = terminalId ? `_win_${terminalId}` : '';
        ptySessionKey = `${projectPath}_${sessionId ?? 'default'}${commandSuffix}${terminalSuffix}`;

        if (isLoginCommand || forceRestart) {
          const oldSession = ptySessionsMap.get(ptySessionKey);
          if (oldSession) {
            if (oldSession.timeoutId) {
              clearTimeout(oldSession.timeoutId);
            }
            oldSession.pty.kill();
            ptySessionsMap.delete(ptySessionKey);
          }
        }

        const existingSession =
          isLoginCommand || forceRestart ? null : ptySessionsMap.get(ptySessionKey);
        if (existingSession) {
          shellProcess = existingSession.pty;
          if (existingSession.timeoutId) {
            clearTimeout(existingSession.timeoutId);
            existingSession.timeoutId = null;
          }

          /*
           * Реплей при возврате.
           *
           * Сначала — снапшот экрана, снятый клиентом перед разрывом (если
           * был): xterm.js применяет его как «здесь и было», без прокрутки.
           * Потом — весь накопившийся с тех пор вывод, одним куском вместо
           * тысячи маленьких сообщений: одно сообщение — один redraw в
           * терминале, а не тысяча, так возврат выглядит мгновенным.
           *
           * Технический баннер «Reconnected to existing session» намеренно
           * убран: он лез в самое начало экрана и сбивал вёрстку у программ,
           * которые сами рисуют интерфейс (Клод в терминале, htop, mc). Факт
           * возврата виден клиентом по метке type=snapshot.
           */
          if (existingSession.snapshot) {
            ws.send(
              JSON.stringify({
                type: 'snapshot',
                data: existingSession.snapshot,
              })
            );
          }

          const backlog = drainBufferToString(existingSession.buffer);
          if (backlog.length > 0) {
            ws.send(
              JSON.stringify({
                type: 'output',
                data: backlog,
              })
            );
          }

          existingSession.ws = ws;
          existingSession.snapshot = null;
          return;
        }

        const resolvedProjectPath = path.resolve(projectPath);
        try {
          const stats = fs.statSync(resolvedProjectPath);
          if (!stats.isDirectory()) {
            throw new Error('Not a directory');
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid project path' }));
          return;
        }

        const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
        if (sessionId && !safeSessionIdPattern.test(sessionId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid session ID' }));
          return;
        }

        const shellCommand = buildShellCommand(data, dependencies);
        const resumeSessionId = resolveResumeSessionId(data, dependencies);
        const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
        // Пустая команда означает «просто открой оболочку», а не «выполни
        // ничего». `bash -c ''` честно выполняет пустую строку и сразу
        // выходит с кодом 0 — именно так выглядела кнопка общей командной
        // строки: терминал открывался и тут же умирал. Без команды запускаем
        // обычную интерактивную оболочку с прочитанным профилем.
        const shellArgs = os.platform() === 'win32'
          ? (shellCommand ? ['-Command', shellCommand] : ['-NoLogo'])
          : (shellCommand ? ['-c', shellCommand] : ['-l', '-i']);
        const termCols = readNumber(data.cols, 80);
        const termRows = readNumber(data.rows, 24);
        const prioritizedPath = prioritizeUserNpmGlobalBin(process.env);

        shellProcess = (dependencies.spawnPty ?? pty.spawn)(shell, shellArgs, {
          name: 'xterm-256color',
          cols: termCols,
          rows: termRows,
          cwd: resolvedProjectPath,
          env: {
            // Гостю — без ключей Claude сервера: они владельца площадки.
            ...withoutInheritedClaudeAuth(process.env, runtimeContext),
            [prioritizedPath.key]: prioritizedPath.value,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            FORCE_COLOR: '3',
            // Свой каталог настроек — иначе вход в терминале лёг бы в общий.
            // Проверка выше не пускает сюда неопознанного пользователя, так
            // что на площадке с открытой регистрацией значение здесь есть
            // всегда; на одноаккаунтной остаётся окружение процесса.
            ...(runtimeContext.claudeConfigDir
              ? { CLAUDE_CONFIG_DIR: runtimeContext.claudeConfigDir }
              : {}),
            ...(runtimeContext.anthropicApiKey
              ? { ANTHROPIC_API_KEY: runtimeContext.anthropicApiKey }
              : {}),
          },
        });

        ptySessionsMap.set(ptySessionKey, {
          pty: shellProcess,
          ws,
          buffer: { chunks: [], bytes: 0 },
          snapshot: null,
          timeoutId: null,
          projectPath,
          sessionId,
        });

        shellProcess.onData((chunk) => {
          if (!ptySessionKey) {
            return;
          }

          const session = ptySessionsMap.get(ptySessionKey);
          if (!session) {
            return;
          }

          appendToBuffer(session.buffer, chunk);

          if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            let outputData = chunk;
            const cleanChunk = stripAnsiSequences(chunk);
            urlDetectionBuffer = `${urlDetectionBuffer}${cleanChunk}`.slice(-SHELL_URL_PARSE_BUFFER_LIMIT);

            outputData = outputData.replace(
              /OPEN_URL:\s*(https?:\/\/[^\s\x1b\x07]+)/g,
              '[INFO] Opening in browser: $1'
            );

            const emitAuthUrl = (detectedUrl: string, autoOpen = false) => {
              const normalizedUrl = normalizeDetectedUrl(detectedUrl);
              if (!normalizedUrl) {
                return;
              }

              const isNewUrl = !announcedAuthUrls.has(normalizedUrl);
              if (isNewUrl) {
                announcedAuthUrls.add(normalizedUrl);
                session.ws?.send(
                  JSON.stringify({
                    type: 'auth_url',
                    url: normalizedUrl,
                    autoOpen,
                  })
                );
              }
            };

            const normalizedDetectedUrls = extractUrlsFromText(urlDetectionBuffer)
              .map((url) => normalizeDetectedUrl(url))
              .filter((url): url is string => Boolean(url));

            const dedupedDetectedUrls = Array.from(new Set(normalizedDetectedUrls)).filter(
              (url, _, urls) =>
                !urls.some((otherUrl) => otherUrl !== url && otherUrl.startsWith(url))
            );

            dedupedDetectedUrls.forEach((url) => emitAuthUrl(url, false));

            if (
              shouldAutoOpenUrlFromOutput(cleanChunk) &&
              dedupedDetectedUrls.length > 0
            ) {
              const bestUrl = dedupedDetectedUrls.reduce((longest, current) =>
                current.length > longest.length ? current : longest
              );
              emitAuthUrl(bestUrl, true);
            }

            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: outputData,
              })
            );
          }
        });

        shellProcess.onExit((exitCode) => {
          if (!ptySessionKey) {
            return;
          }

          const session = ptySessionsMap.get(ptySessionKey);
          if (session && session.pty !== shellProcess) {
            return;
          }

          if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: `\r\n\x1b[33mProcess exited with code ${exitCode.exitCode}${
                  exitCode.signal != null ? ` (${exitCode.signal})` : ''
                }\x1b[0m\r\n`,
              })
            );
          }

          if (session?.timeoutId) {
            clearTimeout(session.timeoutId);
          }

          ptySessionsMap.delete(ptySessionKey);
          shellProcess = null;
        });

        let welcomeMsg = `\x1b[36mStarting terminal in: ${projectPath}\x1b[0m\r\n`;
        if (!isPlainShell) {
          const providerName =
            provider === 'cursor'
              ? 'Cursor'
              : provider === 'codex'
                ? 'Codex'
                : provider === 'opencode'
                    ? 'OpenCode'
                  : 'Claude';
          welcomeMsg = hasSession && resumeSessionId
            ? `\x1b[36mResuming ${providerName} session ${resumeSessionId} in: ${projectPath}\x1b[0m\r\n`
            : `\x1b[36mStarting new ${providerName} session in: ${projectPath}\x1b[0m\r\n`;
        }

        ws.send(
          JSON.stringify({
            type: 'output',
            data: welcomeMsg,
          })
        );
        return;
      }

      if (data.type === 'input') {
        if (shellProcess) {
          shellProcess.write(readString(data.data));
        }
        return;
      }

      if (data.type === 'resize') {
        if (shellProcess) {
          shellProcess.resize(readNumber(data.cols, 80), readNumber(data.rows, 24));
        }
        return;
      }

      /*
       * Снапшот экрана от клиента.
       *
       * Xterm-addon-serialize собирает всё, что сейчас видно в терминале
       * (позиция курсора, цвета, содержимое), в одну строку с ANSI-кодами и
       * шлёт её сюда перед закрытием вкладки. Мы просто держим последний
       * снапшот у сессии — если тот же клиент вернётся, реплей начнётся с
       * него, и экран восстановится в точности как был.
       *
       * Лимит на длину — просто отсечка от кривых данных, обычно снапшот
       * помещается в 50-100 КБ.
       */
      if (data.type === 'snapshot') {
        if (ptySessionKey) {
          const session = ptySessionsMap.get(ptySessionKey);
          if (session) {
            const payload = readString(data.data);
            session.snapshot = payload.length > 256 * 1024 ? null : payload;
          }
        }
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Shell WebSocket error:', message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'output',
            data: `\r\n\x1b[31mError: ${message}\x1b[0m\r\n`,
          })
        );
      }
    }
  });

  ws.on('close', () => {
    if (!ptySessionKey) {
      return;
    }

    const session = ptySessionsMap.get(ptySessionKey);
    if (!session) {
      return;
    }

    // Mobile networks can deliver an old socket's close after its replacement
    // has attached. Only the socket that currently owns the PTY may detach it.
    if (session.ws !== ws) {
      return;
    }

    session.ws = null;
    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
    }
    session.timeoutId = setTimeout(() => {
      // A reconnect may win just as this timer becomes runnable. Re-check the
      // active socket so a queued cleanup can never kill a reattached PTY.
      if (ptySessionsMap.get(ptySessionKey as string) !== session || session.ws !== null) {
        return;
      }

      session.pty.kill();
      ptySessionsMap.delete(ptySessionKey as string);
    }, PTY_SESSION_TIMEOUT);
  });

  ws.on('error', (error) => {
    console.error('[ERROR] Shell WebSocket error:', error);
  });
}

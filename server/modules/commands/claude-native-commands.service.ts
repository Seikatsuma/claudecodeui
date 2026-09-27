import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { waitForClaudeCodeExecutable } from '@/shared/claude-cli-path.js';

/**
 * A command the Claude CLI itself accepts in chat (SDK) mode, as the slash menu
 * shows it. `name` carries the leading slash.
 */
export type ClaudeNativeCommand = {
  name: string;
  description: string;
  argumentHint: string;
};

type SdkSlashCommand = {
  name: string;
  description?: string;
  argumentHint?: string;
};

/** Lists the commands a fresh CLI reports; injected so tests need no real CLI. */
export type ClaudeNativeCommandsProbe = () => Promise<SdkSlashCommand[]>;

// Список меняется только с версией Claude — полчаса хватает, чтобы выкатка
// новой версии дошла до меню, и проба (1–5 с процесса claude) не бьёт по серверу.
const CACHE_TTL_MS = 30 * 60 * 1000;
// Неудачную пробу повторяем через минуту, а не через полчаса.
const FAILURE_RETRY_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 20 * 1000;
const PROBE_CWD = path.join(os.tmpdir(), 'ccui-native-commands');

// Claude сообщает их как поддерживаемые, но в чате они не работают:
// /fast отвечает «недоступно в Agent SDK», /agents — «мастер убран»;
// имена с «_» и workflow-launch-exec — служебные (замер 27.09.26, CLI 2.1.283).
const HIDDEN_COMMANDS = new Set(['fast', 'agents', 'workflow-launch-exec']);

/**
 * Starts a CLI with no settings (so no hooks, MCP servers or user skills run —
 * the menu already lists user skills from disk) and asks it which slash
 * commands it accepts. The CLI never gets a prompt, so no tokens are spent.
 */
const probeWithRealCli: ClaudeNativeCommandsProbe = async () => {
  await mkdir(PROBE_CWD, { recursive: true }).catch(() => undefined);
  const abortController = new AbortController();
  const idlePrompt = (async function* idle() {
    await new Promise((resolve) => {
      abortController.signal.addEventListener('abort', resolve, { once: true });
    });
  })();

  const instance = query({
    prompt: idlePrompt as AsyncIterable<never>,
    options: {
      cwd: PROBE_CWD,
      persistSession: false,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      abortController,
      pathToClaudeCodeExecutable: await waitForClaudeCodeExecutable(process.env.CLAUDE_CLI_PATH),
    },
  });

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      instance.supportedCommands(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('probe timed out')), PROBE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    abortController.abort();
    try {
      instance.close();
    } catch {
      // Процесс уже закрыт.
    }
  }
};

const normalizeCommands = (commands: SdkSlashCommand[]): ClaudeNativeCommand[] => {
  const seen = new Set<string>();
  const result: ClaudeNativeCommand[] = [];
  for (const command of commands) {
    const bareName = typeof command?.name === 'string' ? command.name.trim().replace(/^\//, '') : '';
    if (!bareName || bareName.startsWith('_') || HIDDEN_COMMANDS.has(bareName) || seen.has(bareName)) {
      continue;
    }
    seen.add(bareName);
    result.push({
      name: `/${bareName}`,
      description: (command.description || '').trim(),
      argumentHint: (command.argumentHint || '').trim(),
    });
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
};

/**
 * Creates the cached lister of Claude's own slash commands (/context, /usage,
 * /compact, bundled skills like /loop …). Concurrent callers share one probe;
 * a failed probe yields an empty list so the menu still shows everything else.
 */
export function createClaudeNativeCommandsService(
  probe: ClaudeNativeCommandsProbe = probeWithRealCli,
  now: () => number = Date.now,
) {
  let cached: ClaudeNativeCommand[] = [];
  let expiresAt = 0;
  let inFlight: Promise<ClaudeNativeCommand[]> | null = null;

  return {
    async listCommands(): Promise<ClaudeNativeCommand[]> {
      if (now() < expiresAt) return cached;
      if (inFlight) return inFlight;
      inFlight = probe()
        .then((commands) => {
          const normalized = normalizeCommands(commands);
          // Пустой ответ считаем неудачей: иначе меню на полчаса осталось бы без команд.
          if (normalized.length === 0) throw new Error('probe returned no commands');
          cached = normalized;
          expiresAt = now() + CACHE_TTL_MS;
          return cached;
        })
        .catch((error: unknown) => {
          console.warn('[commands] Claude native commands probe failed:', error instanceof Error ? error.message : error);
          expiresAt = now() + FAILURE_RETRY_MS;
          return cached;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}

/** Lister used by the commands module to add Claude's own commands to /api/commands/list. */
export type ClaudeNativeCommandsService = ReturnType<typeof createClaudeNativeCommandsService>;

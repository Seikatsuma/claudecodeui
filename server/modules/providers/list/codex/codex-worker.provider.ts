import { spawn } from 'node:child_process';
import { appendFile, mkdir, open, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Codex,
  type ApprovalMode,
  type Input,
  type ModelReasoningEffort,
  type SandboxMode,
  type ThreadEvent,
} from '@openai/codex-sdk';

import {
  forgetSurvivableProcess,
  registerSurvivableProcess,
} from '@/modules/providers/list/claude/survivor-runs.js';

export type CodexWorkerJob = {
  appSessionId: string;
  providerSessionId: string | null;
  workingDirectory: string;
  model?: string;
  effort?: ModelReasoningEffort;
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalMode;
  turnInput: Input;
  eventPath: string;
};

export type CodexWorkerHandle = {
  pid: number;
  eventPath: string;
  startedAt: number;
};

export type CodexWorkerControlEvent = {
  type: 'worker.completed' | 'worker.error';
  exitCode?: number;
  aborted?: boolean;
  message?: string;
};

const WORKER_MARKER = '--cloudcli-codex-worker';
const POLL_MS = 100;
const CODEX_NOTIFY_MARKER = 'CLOUDCLI_CODEX_NOTIFY';
const CODEX_NOTIFY_SESSION_ID = 'CLOUDCLI_CODEX_NOTIFY_SESSION_ID';
const CODEX_NOTIFY_DATABASE_PATH = 'CLOUDCLI_CODEX_NOTIFY_DATABASE_PATH';

function liveRunsDir(): string {
  return process.env.CLOUDCLI_LIVE_RUNS_DIR
    || path.join(os.homedir(), '.cloudcli-shared', 'live-runs');
}

function safeSessionPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'session';
}

/**
 * Marks only Codex turns launched by this UI. The global Codex notify hook
 * fails closed unless these values point back to a real Codex session in this
 * exact UI database, so unrelated terminal/account activity cannot notify the
 * owner.
 */
export function buildCodexCliEnvironment(
  appSessionId: string,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );

  delete environment[CODEX_NOTIFY_MARKER];
  delete environment[CODEX_NOTIFY_SESSION_ID];
  delete environment[CODEX_NOTIFY_DATABASE_PATH];

  if (typeof appSessionId !== 'string' || appSessionId.trim().length === 0) {
    return environment;
  }

  const homeDirectory = environment.HOME || os.homedir();
  environment[CODEX_NOTIFY_MARKER] = 'cloudcli-chat';
  environment[CODEX_NOTIFY_SESSION_ID] = appSessionId.trim();
  environment[CODEX_NOTIFY_DATABASE_PATH] = environment.DATABASE_PATH
    || path.join(homeDirectory, '.cloudcli', 'auth.db');
  return environment;
}

function workerLaunchArgs(): { command: string; args: string[] } {
  const compiledWorker = fileURLToPath(new URL('./codex-worker.provider.js', import.meta.url));
  if (fs.existsSync(compiledWorker)) {
    return {
      command: process.execPath,
      args: [compiledWorker, WORKER_MARKER],
    };
  }

  // `npm run server:dev` executes source TypeScript directly. Production uses
  // the compiled branch above; this branch preserves identical behaviour in
  // local development and integration tests.
  const sourceWorker = fileURLToPath(new URL('./codex-worker.provider.ts', import.meta.url));
  return {
    command: process.execPath,
    args: ['--import', 'tsx', sourceWorker, WORKER_MARKER],
  };
}

/**
 * Starts the actual Codex SDK in a detached worker. The web server only tails
 * its event file, so closing/restarting the site cannot close SDK pipes or
 * abort the model turn.
 */
export async function launchCodexWorker(job: Omit<CodexWorkerJob, 'eventPath'>): Promise<CodexWorkerHandle> {
  const dir = liveRunsDir();
  await mkdir(dir, { recursive: true });
  const suffix = `${safeSessionPart(job.appSessionId)}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const eventPath = path.join(dir, `codex-${suffix}.events.jsonl`);
  await writeFile(eventPath, '', { encoding: 'utf8', mode: 0o600 });

  const launch = workerLaunchArgs();
  const child = spawn(launch.command, launch.args, {
    cwd: job.workingDirectory,
    env: process.env,
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  });
  if (!child.pid) {
    throw new Error('Codex worker did not return a PID.');
  }

  const startedAt = Date.now();
  registerSurvivableProcess(child.pid, {
    provider: 'codex',
    appSessionId: job.appSessionId,
    providerSessionId: job.providerSessionId,
    configDir: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    eventPath,
    startedAt,
  });
  if (!child.stdin) {
    stopCodexWorker(child.pid);
    forgetSurvivableProcess(child.pid);
    throw new Error('Codex worker did not open its job channel.');
  }
  await new Promise<void>((resolve, reject) => {
    const stdin = child.stdin;
    const onError = (error: Error) => reject(error);
    child.once('error', onError);
    stdin.once('error', onError);
    stdin.end(JSON.stringify({ ...job, eventPath }), () => {
      child.off('error', onError);
      stdin.off('error', onError);
      resolve();
    });
  }).catch((error) => {
    stopCodexWorker(child.pid ?? 0);
    forgetSurvivableProcess(child.pid ?? 0);
    throw error;
  });
  child.unref();

  return { pid: child.pid, eventPath, startedAt };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Follows complete JSONL records while the worker owns and writes the file.
 * A partial final line is retained until the next read.
 */
export async function* followCodexWorkerEvents(
  handle: CodexWorkerHandle,
): AsyncGenerator<ThreadEvent | CodexWorkerControlEvent> {
  const file = await open(handle.eventPath, 'r');
  let offset = 0;
  let pending = '';
  try {
    while (true) {
      const stat = await file.stat();
      if (stat.size > offset) {
        const length = stat.size - offset;
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await file.read(buffer, 0, length, offset);
        offset += bytesRead;
        pending += buffer.subarray(0, bytesRead).toString('utf8');
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        for (const line of lines) {
          if (!line) continue;
          yield JSON.parse(line) as ThreadEvent | CodexWorkerControlEvent;
        }
      }

      if (!isProcessAlive(handle.pid)) {
        // One last pass catches bytes flushed immediately before process exit.
        const finalStat = await file.stat();
        if (finalStat.size > offset) continue;
        if (pending.trim()) {
          yield JSON.parse(pending) as ThreadEvent | CodexWorkerControlEvent;
          pending = '';
        }
        return;
      }
      await sleep(POLL_MS);
    }
  } finally {
    await file.close();
  }
}

export function stopCodexWorker(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

export async function waitForCodexWorkerExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(50);
  }
  return !isProcessAlive(pid);
}

export function releaseCodexWorker(handle: CodexWorkerHandle): void {
  forgetSurvivableProcess(handle.pid);
}

async function appendEvent(eventPath: string, event: ThreadEvent | CodexWorkerControlEvent): Promise<void> {
  await appendFile(eventPath, `${JSON.stringify(event)}\n`, 'utf8');
}

async function readWorkerJob(): Promise<CodexWorkerJob> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as CodexWorkerJob;
}

async function runWorker(): Promise<void> {
  // The parent fully writes and closes stdin before `launchCodexWorker`
  // returns. From that point onward the worker has no live dependency on the
  // site, while the prompt never appears in argv or a temporary file.
  const job = await readWorkerJob();
  const abortController = new AbortController();
  let aborted = false;
  const abort = () => {
    aborted = true;
    abortController.abort();
  };
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);

  try {
    const codex = new Codex({
      config: { model_reasoning_summary: 'detailed' },
      env: buildCodexCliEnvironment(job.appSessionId),
    });
    const threadOptions = {
      workingDirectory: job.workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode: job.sandboxMode,
      approvalPolicy: job.approvalPolicy,
      model: job.model,
      modelReasoningEffort: job.effort,
    };
    const thread = job.providerSessionId
      ? codex.resumeThread(job.providerSessionId, threadOptions)
      : codex.startThread(threadOptions);
    const streamedTurn = await thread.runStreamed(job.turnInput, { signal: abortController.signal });
    for await (const event of streamedTurn.events) {
      await appendEvent(job.eventPath, event);
    }
    await appendEvent(job.eventPath, { type: 'worker.completed', exitCode: 0, aborted });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!aborted) {
      await appendEvent(job.eventPath, { type: 'worker.error', message });
    }
    await appendEvent(job.eventPath, { type: 'worker.completed', exitCode: aborted ? 0 : 1, aborted });
    process.exitCode = aborted ? 0 : 1;
  }
}

const markerIndex = process.argv.indexOf(WORKER_MARKER);
if (markerIndex >= 0) {
  void runWorker().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

/**
 * Codex subscription account and its usage windows, read from Codex itself.
 *
 * Why the app-server and not the chat stream: Codex writes `rate_limits` into
 * its session files only after a turn, so until someone chats the numbers
 * would be missing or hours old. `codex app-server` answers
 * `account/rateLimits/read` from the ChatGPT backend on demand - it reads the
 * meter, it does not spend the quota it shows - and `account/read` gives the
 * signed-in email and plan. It also refreshes the login through the same
 * ~/.codex/auth.json the chat runtime uses, so there is still exactly one
 * token chain on this machine (a second copy of a Codex login elsewhere would
 * rotate it away - that is why the login here is its own, not a copied file).
 */

type CodexUsageWindow = {
  /** `session` = 5-hour window, `weekly_all` = 7-day window (same kinds as Claude's). */
  kind: string;
  percent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
  expired: boolean;
};

type CodexAccountLimits = {
  available: boolean;
  email: string | null;
  planType: string | null;
  fetchedAtMs: number | null;
  limits: CodexUsageWindow[];
  error?: string;
};

type RateLimitWindowPayload = {
  usedPercent?: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
};

type RateLimitSnapshotPayload = {
  primary?: RateLimitWindowPayload | null;
  secondary?: RateLimitWindowPayload | null;
};

type JsonRpcMessage = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
};

/** A fresh read at most this often: the panel polls, the backend is not ours to hammer. */
const CACHE_TTL_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20 * 1000;

let cached: CodexAccountLimits | null = null;
let inFlight: Promise<CodexAccountLimits> | null = null;

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * The same native binary @openai/codex-sdk runs for chats, so the limits
 * reader never drifts to another Codex version than the one chatting.
 * Falls back to `codex` on PATH when the platform package is not installed.
 */
export function resolveCodexBinary(): string {
  try {
    const sdkRequire = createRequire(import.meta.url);
    const codexRequire = createRequire(sdkRequire.resolve('@openai/codex/package.json'));
    const platformPackage = `@openai/codex-${process.platform}-${process.arch}`;
    const vendorRoot = path.join(path.dirname(codexRequire.resolve(`${platformPackage}/package.json`)), 'vendor');
    const triple = process.platform === 'linux'
      ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`
      : `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`;
    const binary = path.join(vendorRoot, triple, 'bin', 'codex');
    if (existsSync(binary)) {
      return binary;
    }
  } catch {
    // Platform package missing - PATH below.
  }
  return 'codex';
}

function windowKind(minutes: number | null | undefined): string {
  if (minutes === 300) return 'session';
  if (minutes === 10080) return 'weekly_all';
  return 'other';
}

function toUsageWindow(window: RateLimitWindowPayload | null | undefined, now: number): CodexUsageWindow | null {
  if (!window || typeof window.usedPercent !== 'number') {
    return null;
  }
  const resetsAtMs = typeof window.resetsAt === 'number' ? window.resetsAt * 1000 : Number.NaN;
  return {
    kind: windowKind(window.windowDurationMins),
    percent: Math.max(0, Math.min(100, Math.round(window.usedPercent))),
    resetsAt: Number.isFinite(resetsAtMs) ? new Date(resetsAtMs).toISOString() : null,
    windowMinutes: window.windowDurationMins ?? null,
    expired: Number.isFinite(resetsAtMs) ? resetsAtMs <= now : false,
  };
}

/** One short-lived app-server: initialize, read account + limits, exit. */
function queryAppServer(): Promise<CodexAccountLimits> {
  return new Promise((resolve) => {
    const child = spawn(resolveCodexBinary(), ['app-server'], {
      env: { ...process.env, CODEX_HOME: codexHome() },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const result: CodexAccountLimits = { available: false, email: null, planType: null, fetchedAtMs: null, limits: [] };
    let buffer = '';
    let settled = false;
    let pending = 2;

    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) result.error = error;
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish('Codex did not answer in time'), REQUEST_TIMEOUT_MS);
    const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`);

    child.on('error', (error) => finish(error.message));
    child.on('exit', () => finish(result.fetchedAtMs ? undefined : 'Codex exited early'));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(line) as JsonRpcMessage;
        } catch {
          continue;
        }
        if (message.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/read', params: { refreshToken: false } });
          send({ id: 3, method: 'account/rateLimits/read' });
        } else if (message.id === 2) {
          const account = message.result?.account as { type?: string; email?: string | null; planType?: string } | null | undefined;
          if (account?.type === 'chatgpt') {
            result.email = account.email ?? null;
            result.planType = account.planType ?? null;
            result.available = true;
          }
          pending -= 1;
        } else if (message.id === 3) {
          if (message.error) {
            result.error = message.error.message ?? 'Codex refused the limits request';
          } else {
            const snapshot = message.result?.rateLimits as RateLimitSnapshotPayload | undefined;
            const now = Date.now();
            result.limits = [toUsageWindow(snapshot?.primary, now), toUsageWindow(snapshot?.secondary, now)]
              .filter((window): window is CodexUsageWindow => window !== null);
            result.fetchedAtMs = now;
          }
          pending -= 1;
        }
        if (pending === 0) {
          finish(result.error);
        }
      }
    });

    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'cloudcli-limits', version: '1' } } });
  });
}

/**
 * Codex account (email, plan) and its 5-hour / weekly windows, cached for two
 * minutes with one read in flight at a time. Without ~/.codex/auth.json it
 * answers `available: false` at once, without starting Codex.
 *
 * Consumer: user module (GET /api/user/codex-account) - the sidebar account
 * switcher and the "Расход" panel.
 */
export async function readCodexAccountLimits(): Promise<CodexAccountLimits> {
  if (!existsSync(path.join(codexHome(), 'auth.json'))) {
    cached = null;
    return { available: false, email: null, planType: null, fetchedAtMs: null, limits: [] };
  }
  if (cached?.fetchedAtMs && Date.now() - cached.fetchedAtMs < CACHE_TTL_MS) {
    return cached;
  }
  if (!inFlight) {
    inFlight = queryAppServer()
      .then((fresh) => {
        // A failed read keeps the last good numbers rather than blanking the panel.
        if (fresh.fetchedAtMs || !cached) {
          cached = fresh;
        }
        return fresh.fetchedAtMs ? fresh : { ...(cached ?? fresh), error: fresh.error };
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

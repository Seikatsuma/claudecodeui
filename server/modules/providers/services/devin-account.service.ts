import spawn from 'cross-spawn';

import { buildDevinChildEnv, isDevinCliInstalled, resolveDevinCliCommand } from '@/shared/utils.js';

/**
 * Devin subscription of the platform owner, as shown in the account menu.
 *
 * Read from `devin auth status`: it only reports whether the credential file is
 * present and the account name — no request to the model, no quota spent. Devin
 * publishes no 5 h / weekly windows to the CLI, so (unlike Codex) there are no
 * usage bars; the quota is on app.devin.ai. The reply carries the name only —
 * never the credential path or token.
 */
export type DevinAccount = {
  available: boolean;
  name: string | null;
  /** The only model family the owner allows on this account. */
  models: string;
  fetchedAtMs: number | null;
};

const CACHE_TTL_MS = 60_000;
const STATUS_TIMEOUT_MS = 8_000;

let cached: { at: number; value: DevinAccount } | null = null;

const UNAVAILABLE: DevinAccount = { available: false, name: null, models: 'SWE-2', fetchedAtMs: null };

function runAuthStatus(): Promise<string> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (text: string) => {
      if (!settled) {
        settled = true;
        resolve(text);
      }
    };
    try {
      const child = spawn(resolveDevinCliCommand(), ['auth', 'status'], {
        env: buildDevinChildEnv(),
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish('');
      }, STATUS_TIMEOUT_MS);
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.on('error', () => {
        clearTimeout(timer);
        finish('');
      });
      child.on('close', () => {
        clearTimeout(timer);
        finish(output);
      });
    } catch {
      finish('');
    }
  });
}

/** Parses the text of `devin auth status` into the owner-facing account record. */
export function parseDevinAuthStatus(text: string): DevinAccount {
  if (!/^\s*Logged in\b/m.test(text)) {
    return UNAVAILABLE;
  }
  const name = /^\s*Name:\s*(\S.*?)\s*$/m.exec(text)?.[1] ?? null;
  return { available: true, name, models: 'SWE-2', fetchedAtMs: Date.now() };
}

export async function readDevinAccount(): Promise<DevinAccount> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  if (!isDevinCliInstalled()) {
    return UNAVAILABLE;
  }
  const value = parseDevinAuthStatus(await runAuthStatus());
  cached = { at: Date.now(), value };
  return value;
}

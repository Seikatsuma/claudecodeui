import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { findFilesRecursivelyCreatedAfter, getClaudeConfigDir, getClaudeJsonPath } from '@/shared/utils.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
// Re-reading and summing every JSONL line across every recent session is
// I/O- and CPU-heavy (measured ~3.5s for ~50k lines on a busy dev account).
// It is only ever a rough supplementary figure (see docstring below), so it
// is cached for a while rather than recomputed on every composer mount.
const TOKEN_ESTIMATE_CACHE_TTL_MS = 15 * 60 * 1000;

type WeeklyLimitEntry = {
  group?: string;
  kind?: string;
  percent?: number;
  is_active?: boolean;
  severity?: string;
  resets_at?: string;
};

type RawUsageUtilizationCache = {
  fetchedAtMs?: number;
  utilization?: {
    limits?: WeeklyLimitEntry[];
  };
};

export type OfficialWeeklyUsage = {
  percent: number;
  resetsAt: string | null;
  severity: string | null;
  fetchedAt: string;
};

export type TokenEstimate = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  windowStart: string;
  windowEnd: string;
  computedAt: string;
};

export type WeeklyUsageSnapshot = {
  official: OfficialWeeklyUsage | null;
  estimate: TokenEstimate | null;
};

type ClaudeWeeklyUsageServiceDependencies = {
  readClaudeJson: () => Promise<string>;
  getProjectsDirectory: () => string;
};

const defaultDependencies: ClaudeWeeklyUsageServiceDependencies = {
  readClaudeJson: () => fsp.readFile(getClaudeJsonPath(), 'utf8'),
  getProjectsDirectory: () => path.join(getClaudeConfigDir(), 'projects'),
};

/**
 * Reads the `claude` CLI's own cached weekly-limit percentage out of its
 * `.claude.json` (the `cachedUsageUtilization.utilization.limits` entry with
 * `kind === "weekly_all"`). This is the exact figure Anthropic's backend
 * computes for the account's plan (already correctly weighted across models
 * and cache-discounted tokens) and is what the CLI itself would show — far
 * more meaningful than re-deriving a percentage from raw token counts, which
 * this app has no reliable way to weight against the real limit formula.
 *
 * This is a CLI-maintained cache, not a live API call: it only refreshes
 * when the CLI itself talks to Anthropic (e.g. on startup), so it can be
 * hours or, after a period of the CLI not running, stale. Callers should
 * surface `fetchedAt` alongside the percent so the UI can be honest about
 * that. This shape is undocumented/internal to the CLI and could change
 * between versions, so every read here is defensive and returns null on any
 * mismatch rather than throwing.
 */
async function readOfficialWeeklyUsage(
  dependencies: ClaudeWeeklyUsageServiceDependencies,
): Promise<OfficialWeeklyUsage | null> {
  try {
    const raw = await dependencies.readClaudeJson();
    const parsed = JSON.parse(raw) as { cachedUsageUtilization?: RawUsageUtilizationCache };
    const cache = parsed.cachedUsageUtilization;
    const limits = cache?.utilization?.limits;
    if (!cache || typeof cache.fetchedAtMs !== 'number' || !Array.isArray(limits)) {
      return null;
    }

    const weeklyAll = limits.find((entry) => entry?.kind === 'weekly_all');
    if (!weeklyAll || typeof weeklyAll.percent !== 'number') {
      return null;
    }

    return {
      percent: weeklyAll.percent,
      resetsAt: typeof weeklyAll.resets_at === 'string' ? weeklyAll.resets_at : null,
      severity: typeof weeklyAll.severity === 'string' ? weeklyAll.severity : null,
      fetchedAt: new Date(cache.fetchedAtMs).toISOString(),
    };
  } catch {
    // Missing file, unreadable JSON, or an unexpected shape all mean "no
    // official figure available" - the caller falls back to the estimate.
    return null;
  }
}

/**
 * Sums input/output/cache tokens for every Claude assistant turn across all
 * projects in the trailing 7 days, read straight from the session JSONL
 * transcripts (the same files `provider-token-usage.service.ts` reads for a
 * single session's context-window usage).
 *
 * IMPORTANT - this is NOT the same figure as `readOfficialWeeklyUsage`'s
 * percent and must never be labeled as a percent of the weekly limit: the
 * real weekly cap is spend-based and discounts cache-read tokens heavily
 * (~90% off), while this sums every token field at face value. On a busy
 * account cache-read tokens alone can be orders of magnitude larger than the
 * other fields, so this number is only meant as a rough "how much did I read
 * and write this week" activity figure, shown as a supplementary detail.
 */
async function computeTokenEstimate(
  dependencies: ClaudeWeeklyUsageServiceDependencies,
): Promise<TokenEstimate> {
  const now = Date.now();
  const windowStartMs = now - SEVEN_DAYS_MS;
  const windowStart = new Date(windowStartMs);

  const projectsDirectory = dependencies.getProjectsDirectory();
  // Bound the scan to files touched in the window instead of the account's
  // entire history. Birthtime-filtered, so a session that STARTED before the
  // window but was also used inside it is still included (find by mtime, not
  // birth), while very old, untouched sessions are skipped cheaply.
  const candidateFiles = await findFilesRecursivelyCreatedAfter(projectsDirectory, '.jsonl', null);

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  await Promise.all(candidateFiles.map(async (filePath) => {
    let fileStat;
    try {
      fileStat = await fsp.stat(filePath);
    } catch {
      return;
    }
    // Subagent/tool-result transcripts repeat the parent session's turns
    // under the same directory tree - skip them so tokens aren't double
    // counted (mirrors ClaudeSessionSynchronizer.isSubagentTranscript).
    const pathParts = path.normalize(filePath).split(path.sep);
    if (pathParts.includes('subagents') || pathParts.includes('tool-results')) {
      return;
    }
    if (fileStat.mtimeMs < windowStartMs) {
      return;
    }

    await new Promise<void>((resolve) => {
      const rl = readline.createInterface({
        input: createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });

      rl.on('line', (line) => {
        if (!line.includes('"type":"assistant"') && !line.includes('"type": "assistant"')) {
          return;
        }
        try {
          const entry = JSON.parse(line) as {
            type?: string;
            timestamp?: string;
            message?: { usage?: Record<string, unknown> };
          };
          if (entry.type !== 'assistant' || !entry.timestamp) {
            return;
          }
          const entryTimeMs = Date.parse(entry.timestamp);
          if (!Number.isFinite(entryTimeMs) || entryTimeMs < windowStartMs) {
            return;
          }
          const usage = entry.message?.usage;
          if (!usage) {
            return;
          }
          inputTokens += Number(usage.input_tokens) || 0;
          outputTokens += Number(usage.output_tokens) || 0;
          cacheReadTokens += Number(usage.cache_read_input_tokens) || 0;
          cacheCreationTokens += Number(usage.cache_creation_input_tokens) || 0;
        } catch {
          // Skip malformed/partial lines (a provider may be writing the
          // last line while this scan runs).
        }
      });
      rl.on('close', resolve);
      rl.on('error', () => resolve());
    });
  }));

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    windowStart: windowStart.toISOString(),
    windowEnd: new Date(now).toISOString(),
    computedAt: new Date(now).toISOString(),
  };
}

/**
 * Creates the weekly usage service backing the composer's usage indicator.
 * Test suites can inject isolated file reads; the default export below wires
 * real dependencies for the provider routes.
 */
export function createClaudeWeeklyUsageService(
  dependencyOverrides: Partial<ClaudeWeeklyUsageServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  let cachedEstimate: TokenEstimate | null = null;
  let cachedEstimateAtMs = 0;
  let inFlightEstimate: Promise<TokenEstimate> | null = null;

  return {
    /**
     * Returns the official CLI-cached weekly-limit percent (if available)
     * plus a best-effort local token estimate. The estimate is cached
     * in-process for `TOKEN_ESTIMATE_CACHE_TTL_MS` since computing it means
     * scanning every recent session transcript.
     */
    async getWeeklyUsageSnapshot(): Promise<WeeklyUsageSnapshot> {
      const officialPromise = readOfficialWeeklyUsage(dependencies);

      const now = Date.now();
      let estimatePromise: Promise<TokenEstimate>;
      if (cachedEstimate && now - cachedEstimateAtMs < TOKEN_ESTIMATE_CACHE_TTL_MS) {
        estimatePromise = Promise.resolve(cachedEstimate);
      } else if (inFlightEstimate) {
        estimatePromise = inFlightEstimate;
      } else {
        inFlightEstimate = computeTokenEstimate(dependencies).then((result) => {
          cachedEstimate = result;
          cachedEstimateAtMs = Date.now();
          inFlightEstimate = null;
          return result;
        }).catch((error) => {
          inFlightEstimate = null;
          throw error;
        });
        estimatePromise = inFlightEstimate;
      }

      const [official, estimate] = await Promise.all([
        officialPromise,
        estimatePromise.catch(() => null),
      ]);

      return { official, estimate };
    },
  };
}

/** Used by the provider routes to serve the composer's usage indicator. */
export const claudeWeeklyUsageService = createClaudeWeeklyUsageService();

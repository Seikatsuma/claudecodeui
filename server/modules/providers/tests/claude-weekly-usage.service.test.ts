import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createClaudeWeeklyUsageService } from '@/modules/providers/services/claude-weekly-usage.service.js';

const NOW = new Date('2026-08-29T12:00:00.000Z');
const WITHIN_WINDOW = new Date('2026-08-27T12:00:00.000Z');
const OUTSIDE_WINDOW = new Date('2026-08-01T12:00:00.000Z');

function assistantLine(usage: Record<string, number>, timestamp: string) {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: { usage },
  });
}

test('getWeeklyUsageSnapshot reads the CLI-cached weekly_all percent, ignoring other limit kinds', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'claude-weekly-usage-official-'));
  const projectsDirectory = path.join(tempDirectory, 'projects');
  await mkdir(projectsDirectory, { recursive: true });

  try {
    const service = createClaudeWeeklyUsageService({
      readClaudeJson: async () => JSON.stringify({
        cachedUsageUtilization: {
          fetchedAtMs: NOW.getTime(),
          utilization: {
            limits: [
              { kind: 'session', group: 'session', percent: 39, resets_at: null },
              {
                kind: 'weekly_all',
                group: 'weekly',
                percent: 55,
                severity: 'normal',
                resets_at: '2026-08-28T20:00:00.000Z',
              },
              { kind: 'weekly_scoped', group: 'weekly', percent: 23, resets_at: null },
            ],
          },
        },
      }),
      getProjectsDirectory: () => projectsDirectory,
    });

    const { official } = await service.getWeeklyUsageSnapshot();

    assert.deepEqual(official, {
      percent: 55,
      resetsAt: '2026-08-28T20:00:00.000Z',
      severity: 'normal',
      fetchedAt: NOW.toISOString(),
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('getWeeklyUsageSnapshot falls back to a null official figure on missing or malformed cache data', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'claude-weekly-usage-malformed-'));
  const projectsDirectory = path.join(tempDirectory, 'projects');
  await mkdir(projectsDirectory, { recursive: true });

  try {
    const missingFile = createClaudeWeeklyUsageService({
      readClaudeJson: async () => { throw new Error('ENOENT'); },
      getProjectsDirectory: () => projectsDirectory,
    });
    assert.equal((await missingFile.getWeeklyUsageSnapshot()).official, null);

    const noWeeklyEntry = createClaudeWeeklyUsageService({
      readClaudeJson: async () => JSON.stringify({
        cachedUsageUtilization: {
          fetchedAtMs: NOW.getTime(),
          utilization: { limits: [{ kind: 'session', percent: 10 }] },
        },
      }),
      getProjectsDirectory: () => projectsDirectory,
    });
    assert.equal((await noWeeklyEntry.getWeeklyUsageSnapshot()).official, null);

    const unexpectedShape = createClaudeWeeklyUsageService({
      readClaudeJson: async () => JSON.stringify({ somethingElse: true }),
      getProjectsDirectory: () => projectsDirectory,
    });
    assert.equal((await unexpectedShape.getWeeklyUsageSnapshot()).official, null);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('getWeeklyUsageSnapshot estimates tokens from assistant turns in the trailing 7 days, excluding older turns', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'claude-weekly-usage-estimate-'));
  const projectsDirectory = path.join(tempDirectory, 'projects');
  await mkdir(projectsDirectory, { recursive: true });

  const recentFile = path.join(projectsDirectory, 'recent-session.jsonl');
  await writeFile(recentFile, [
    assistantLine({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 10,
    }, WITHIN_WINDOW.toISOString()),
    // A turn older than the 7-day window inside the same file must not count.
    assistantLine({ input_tokens: 999 }, OUTSIDE_WINDOW.toISOString()),
    // Non-assistant lines and malformed JSON must be skipped, not throw.
    JSON.stringify({ type: 'user', timestamp: WITHIN_WINDOW.toISOString() }),
    '{not valid json',
  ].join('\n'));
  // mtime must fall inside the window too - the service pre-filters whole
  // files by mtime before parsing lines.
  await utimes(recentFile, WITHIN_WINDOW, WITHIN_WINDOW);

  const staleFile = path.join(projectsDirectory, 'stale-session.jsonl');
  await writeFile(staleFile, assistantLine({ input_tokens: 500 }, OUTSIDE_WINDOW.toISOString()));
  await utimes(staleFile, OUTSIDE_WINDOW, OUTSIDE_WINDOW);

  // A subagent transcript under the same tree must be excluded so its tokens
  // are never double counted against the parent session.
  const subagentDir = path.join(projectsDirectory, 'some-project', 'subagents');
  await mkdir(subagentDir, { recursive: true });
  const subagentFile = path.join(subagentDir, 'child.jsonl');
  await writeFile(subagentFile, assistantLine({ input_tokens: 5_000 }, WITHIN_WINDOW.toISOString()));
  await utimes(subagentFile, WITHIN_WINDOW, WITHIN_WINDOW);

  try {
    const service = createClaudeWeeklyUsageService({
      readClaudeJson: async () => { throw new Error('no official figure in this test'); },
      getProjectsDirectory: () => projectsDirectory,
    });

    const { estimate } = await service.getWeeklyUsageSnapshot();

    assert.ok(estimate, 'expected a token estimate to be computed');
    assert.equal(estimate?.inputTokens, 100);
    assert.equal(estimate?.outputTokens, 20);
    assert.equal(estimate?.cacheReadTokens, 500);
    assert.equal(estimate?.cacheCreationTokens, 10);
    assert.equal(estimate?.totalTokens, 630);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('getWeeklyUsageSnapshot caches the token estimate instead of rescanning on every call', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'claude-weekly-usage-cache-'));
  const projectsDirectory = path.join(tempDirectory, 'projects');
  await mkdir(projectsDirectory, { recursive: true });

  const sessionFile = path.join(projectsDirectory, 'session.jsonl');
  await writeFile(sessionFile, assistantLine({ input_tokens: 42 }, WITHIN_WINDOW.toISOString()));
  await utimes(sessionFile, WITHIN_WINDOW, WITHIN_WINDOW);

  let scans = 0;

  try {
    const service = createClaudeWeeklyUsageService({
      readClaudeJson: async () => { throw new Error('no official figure in this test'); },
      getProjectsDirectory: () => {
        scans += 1;
        return projectsDirectory;
      },
    });

    const first = await service.getWeeklyUsageSnapshot();
    const second = await service.getWeeklyUsageSnapshot();

    assert.equal(first.estimate?.inputTokens, 42);
    assert.deepEqual(first.estimate, second.estimate);
    assert.equal(scans, 1, 'a second call within the cache TTL must not rescan the projects directory');
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

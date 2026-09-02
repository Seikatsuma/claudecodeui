import { randomUUID } from 'node:crypto';

import { deleteSession, query } from '@anthropic-ai/claude-agent-sdk';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { broadcastSessionUpserted } from '@/modules/providers/services/sessions-watcher.service.js';
import { AppError } from '@/shared/utils.js';

/**
 * One LLM call covers at most this many ungrouped sessions (most recent
 * first). Session titles are short, so this stays well inside a small
 * model's context with room to spare, and keeps the call itself fast - a
 * project with more ungrouped sessions than this just leaves the oldest
 * ones for a later "Organize by topic" click, rather than growing the
 * prompt (and the latency/cost of a single click) unboundedly.
 */
const MAX_SESSIONS_PER_AUTO_GROUP_CALL = 60;

/** Below this many ungrouped sessions, clustering has nothing meaningful to do. */
const MIN_UNGROUPED_SESSIONS_TO_OFFER = 3;

/** A "group" of one session isn't worth a header - it stays ungrouped instead. */
const MIN_SESSIONS_PER_GROUP = 2;

const AUTO_GROUP_TIMEOUT_MS = 45_000;

const TITLE_MAX_CHARS_IN_PROMPT = 200;
const GROUP_LABEL_MAX_CHARS = 60;

export type AutoGroupResult = {
  groups: Array<{ id: string; label: string; sessionIds: string[] }>;
  groupedCount: number;
  ungroupedRemainingCount: number;
  totalConsidered: number;
};

type GroupingResponseGroup = {
  name: string;
  indices: number[];
};

function buildGroupingPrompt(items: Array<{ index: number; title: string }>): string {
  const lines = items
    .map((item) => `${item.index}: ${item.title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX_CHARS_IN_PROMPT)}`)
    .join('\n');

  return `You will see a numbered list of chat session titles from one project. Group titles that share a clear common topic/theme into named clusters.

Rules:
- Only form a group when at least 2 items clearly share a topic. Do not force every item into a group.
- Never invent a catch-all group like "Misc" or "Other" - simply leave items that don't clearly fit anywhere out of every group.
- "name": 2-5 words, Title Case, describing the shared topic (e.g. "Recipe Ideas", "React Debugging").
- "indices": the 0-based indices (from the list below) belonging to this group. Each index may appear in at most one group.
- Respond with ONLY a JSON object, no markdown code fences, no explanation, in exactly this shape:
{"groups":[{"name":"Short Topic Name","indices":[0,2,5]}]}

Titles:
${lines}`;
}

/**
 * Strips optional markdown code fences and parses+validates the model's
 * response into a safe, bounds-checked list of groups. Never throws on
 * malformed model output - returns an empty list instead, since a failed
 * auto-group attempt should surface as "nothing happened", not a crash.
 */
function parseGroupingResponse(rawText: string, itemCount: number): GroupingResponseGroup[] {
  const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = (fenceMatch ? fenceMatch[1] : rawText).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const groupsRaw = (parsed as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(groupsRaw)) {
    return [];
  }

  const usedIndices = new Set<number>();
  const groups: GroupingResponseGroup[] = [];

  for (const candidate of groupsRaw) {
    const name = typeof (candidate as { name?: unknown })?.name === 'string'
      ? (candidate as { name: string }).name.trim()
      : '';
    const rawIndices = (candidate as { indices?: unknown })?.indices;
    if (!name || !Array.isArray(rawIndices)) {
      continue;
    }

    const indices: number[] = [];
    for (const value of rawIndices) {
      const index = typeof value === 'number' ? Math.trunc(value) : Number.NaN;
      if (
        Number.isInteger(index)
        && index >= 0
        && index < itemCount
        && !usedIndices.has(index)
      ) {
        usedIndices.add(index);
        indices.push(index);
      }
    }

    if (indices.length >= MIN_SESSIONS_PER_GROUP) {
      groups.push({ name: name.slice(0, GROUP_LABEL_MAX_CHARS), indices });
    }
  }

  return groups;
}

/**
 * Runs one headless, tool-free prompt through the same Claude provider used
 * for the rest of the app (the Agent SDK's `query()`) and returns its final
 * text. `tools: []` keeps this a plain text-completion call - no file reads,
 * no permission prompts possible - since all it needs is a topic clustering
 * of the titles already in the prompt.
 *
 * Every `query()` call - including this internal, user-invisible one -
 * still makes the CLI persist a normal session transcript on disk under the
 * target project, which the file watcher would otherwise index as a real,
 * visible sidebar session ("Cluster coding session..." showed up in manual
 * testing). Since this call has no conversational value to the user, its
 * transcript is deleted again once the call finishes (best-effort - a
 * failed cleanup just leaves one harmless extra history entry, never a
 * crash), including a corresponding DB row that raced the watcher into
 * being created in the meantime.
 */
async function runOneShotJsonPrompt(prompt: string, cwd: string): Promise<string> {
  const instance = query({
    prompt,
    options: {
      cwd,
      tools: [],
      maxTurns: 1,
    },
  });

  let resultText = '';
  let capturedSessionId: string | undefined;
  const timeoutHandle = setTimeout(() => {
    try {
      instance.close?.();
    } catch {
      // Best-effort close; the for-await loop below will simply end.
    }
  }, AUTO_GROUP_TIMEOUT_MS);
  // Never let a hung/leaked query process keep the Node event loop alive.
  timeoutHandle.unref?.();

  try {
    for await (const message of instance as AsyncIterable<Record<string, unknown>>) {
      if (typeof message.session_id === 'string' && !capturedSessionId) {
        capturedSessionId = message.session_id;
      }
      if (message.type === 'result' && typeof message.result === 'string') {
        resultText = message.result;
      }
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (capturedSessionId) {
    await cleanupEphemeralSession(capturedSessionId, cwd);
  }

  return resultText;
}

/**
 * Removes the on-disk transcript (and, if the watcher already raced it into
 * the DB, the resulting row) for one internal one-shot grouping call. Never
 * throws - this is post-hoc tidying, not correctness-critical.
 */
async function cleanupEphemeralSession(sessionId: string, cwd: string): Promise<void> {
  try {
    await deleteSession(sessionId, { dir: cwd });
  } catch {
    // Transcript may not exist yet, or already removed - fine either way.
  }
  try {
    const row = sessionsDb.getSessionByProviderSessionId(sessionId);
    if (row) {
      sessionsDb.deleteSessionById(row.session_id);
    }
  } catch {
    // Best-effort DB cleanup only.
  }
}

/**
 * Clusters one project's ungrouped active sessions by topic using a single
 * LLM call, then persists the resulting group_id/group_label assignments and
 * broadcasts a `session_upserted` delta per affected session so every open
 * sidebar updates live, the same way file-watcher-driven title syncs do.
 *
 * Deliberately a one-shot, user-triggered action (the "Organize by topic"
 * button) rather than a background job: re-clustering on every sidebar open
 * would be both expensive and visually unstable (labels reshuffling under
 * the user), so this only ever touches sessions that don't already have a
 * group, and never re-groups or renames an existing group.
 */
export async function autoGroupProjectSessions(projectId: string): Promise<AutoGroupResult> {
  const project = projectsDb.getProjectById(projectId);
  if (!project) {
    throw new AppError(`Project "${projectId}" was not found.`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  const candidates = sessionsDb
    .getUngroupedSessionsByProjectPath(project.project_path, MAX_SESSIONS_PER_AUTO_GROUP_CALL)
    .filter((session) => Boolean(session.custom_name?.trim()));

  if (candidates.length < MIN_UNGROUPED_SESSIONS_TO_OFFER) {
    return {
      groups: [],
      groupedCount: 0,
      ungroupedRemainingCount: candidates.length,
      totalConsidered: candidates.length,
    };
  }

  const items = candidates.map((session, index) => ({
    index,
    title: session.custom_name as string,
  }));

  const prompt = buildGroupingPrompt(items);
  const responseText = await runOneShotJsonPrompt(prompt, project.project_path);
  const parsedGroups = parseGroupingResponse(responseText, items.length);

  const assignments: Array<{ sessionId: string; groupId: string; groupLabel: string }> = [];
  const resultGroups: AutoGroupResult['groups'] = [];

  for (const group of parsedGroups) {
    const groupId = randomUUID();
    const sessionIds = group.indices
      .map((index) => candidates[index]?.session_id)
      .filter((sessionId): sessionId is string => Boolean(sessionId));

    if (sessionIds.length < MIN_SESSIONS_PER_GROUP) {
      continue;
    }

    for (const sessionId of sessionIds) {
      assignments.push({ sessionId, groupId, groupLabel: group.name });
    }
    resultGroups.push({ id: groupId, label: group.name, sessionIds });
  }

  sessionsDb.assignSessionGroups(assignments);

  for (const assignment of assignments) {
    await broadcastSessionUpserted(assignment.sessionId);
  }

  return {
    groups: resultGroups,
    groupedCount: assignments.length,
    ungroupedRemainingCount: candidates.length - assignments.length,
    totalConsidered: candidates.length,
  };
}

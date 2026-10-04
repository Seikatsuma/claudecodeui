/**
 * Раскладка чатов по группам силами модели — чтобы в группы попадала почти
 * вся работа, а не только чаты со «словом для подбора» в названии.
 *
 * Как пришли к этому. 16.09.26 Егор: группы «очень хороши», но свежие чаты
 * почти все оседают в «Сегодня / Вчера»; «80–90% чатов, которые я создаю,
 * должны распределяться по группам». Замер в тот же день: из 165 открытых чатов
 * в группах 72 (44%). Подбор по словам не понимает смысла: «Фриз прокрутки
 * чата», «Исчезающие запросы», «Скролл панели чатов» — это всё сайт Claude, но
 * ни одного слова группы в них нет. Смысл понимает только модель.
 *
 * Как устроено:
 * - Слова для подбора остаются первым, бесплатным шагом (chat-groups.ts).
 *   Модель смотрит только чаты, которые словами не разложились.
 * - Модель получает группы аккаунта с примерами названий и решает для каждого
 *   чата одно из трёх: существующая группа; новая тема (кандидат); пропустить
 *   («привет», «/resume», пустое).
 * - Новая тема сразу группой не становится: редкая тема не должна плодить
 *   заголовки. Чат ждёт в общем списке по дням, а тема пишется ему подсказкой
 *   `group_hint`. Когда подсказку набирают CANDIDATE_MIN_CHATS чатов — группа
 *   создаётся и чаты переезжают в неё. Егор: «после появления двух-трёх
 *   чатов тогда уже определяется в группу».
 * - Модели передаются уже ждущие темы-кандидаты, чтобы она называла одно дело
 *   одним именем, а не «Лимиты Claude» и «Расход подписки» вразнобой.
 * - Только чаты человека: набранные в терминале или на сайте (`origin`
 *   terminal / web). Чаты, запущенные программами (`auto`), и тестовые прогоны
 *   в /tmp и e2e-папках в группы не попадают никогда — Егор: «не записывать
 *   туда чаты, которые создала нейросеть».
 * - Ручной выбор группы в шапке чата модель не трогает. Сменилось название —
 *   чат разбирается заново (`group_hint_title` помнит, какое название видела
 *   модель).
 * - Вызов — как у разбора «Хода работы»: без инструментов, без размышлений,
 *   без записи разговора и без чтения настроек (иначе сработали бы хуки), входом
 *   того аккаунта, чьи это чаты.
 */
import { mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { getConnection } from '@/modules/database/connection.js';
import { chatGroupsDb, ensureChatGroupsSchema } from '@/modules/database/repositories/chat-groups.js';

export { isMachineMadeChat } from '@/modules/database/repositories/chat-groups.js';

/** Столько чатов одной темы превращают кандидата в группу. */
export const CANDIDATE_MIN_CHATS = 3;
/** Чатов за один вызов модели. */
const BATCH_SIZE = 30;
/** Вызовов за один проход — старый хвост разбирается за несколько проходов. */
const MAX_BATCHES_PER_PASS = 4;
/** Чаты старше этого срока не разбираются: список слева их почти не показывает. */
const LOOKBACK_DAYS = 60;
/**
 * Черновое название («первые слова сообщения») через несколько минут
 * сменяется настоящим. Разбирать черновик сразу — платить за вызов дважды.
 */
const NAIVE_TITLE_SETTLE_MINUTES = 10;
const PASS_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_PASS_DELAY_MS = 60 * 1000;
const MODEL_TIMEOUT_MS = 120 * 1000;
const EXAMPLES_PER_GROUP = 6;
const TITLE_MAX_CHARS = 160;
const TOPIC_MAX_CHARS = 40;
const CLASSIFIER_CWD = path.join(os.homedir(), '.cloudcli', 'group-classifier-cwd');
const TITLE_STUB_MAX_BYTES = 4096;

/** `folder` — папка проекта, если чат ведётся не в домашней: подсказка о деле. */
export type ClassifierChat = { id: number; title: string; folder?: string };
export type ClassifierGroup = { name: string; examples: string[] };
export type ClassifierCandidate = { topic: string; count: number; examples: string[] };

export type ClassifierDecision =
  | { kind: 'group'; name: string }
  | { kind: 'topic'; topic: string }
  | { kind: 'skip' };

export function normalizeTopic(topic: string): string {
  return topic.trim().replace(/\s+/g, ' ').toLowerCase().replace(/ё/g, 'е');
}

export function buildClassifierPrompt(
  groups: ClassifierGroup[],
  candidates: ClassifierCandidate[],
  chats: ClassifierChat[],
): string {
  const groupLines = groups.length
    ? groups.map((group) => `- «${group.name}»: ${group.examples.map((title) => `«${title}»`).join(', ') || 'пока без чатов'}`).join('\n')
    : '(групп пока нет)';
  const candidateLines = candidates.length
    ? candidates.map((item) => `- «${item.topic}» (${item.count}): ${item.examples.map((title) => `«${title}»`).join(', ')}`).join('\n')
    : '(нет)';

  return [
    'Человек ведёт сотни чатов с ИИ-помощником и хочет видеть их разложенными по группам — по делу, которым занят чат. Цель: почти каждый осмысленный чат в группе.',
    '',
    'Существующие группы и примеры их чатов:',
    groupLines,
    '',
    'Темы, которые уже ждут своей группы (в скобках — сколько чатов):',
    candidateLines,
    '',
    'Для КАЖДОГО чата из списка ниже реши одно:',
    '1. {"id": N, "group": "<имя существующей группы дословно>"} — если чат про дело этой группы. Смотри на смысл, а не на слова: жалоба на прокрутку или вкладки в интерфейсе чата — это группа про сайт/интерфейс Claude, если такая есть.',
    '2. {"id": N, "topic": "<тема>"} — если ни одна группа не подходит. Тема — широкое дело на 1–3 слова по-русски (например «Покупки и поиск товаров», «Расход лимитов Claude», «Документы и транскрибация»), не пересказ одного чата. Если подходит тема из ждущих — пиши её дословно. Не заводи тему, близкую по смыслу к существующей группе или ждущей теме, — клади туда.',
    '3. {"id": N, "skip": true} — если по названию дело не понять вообще (приветствие, служебная команда вроде /resume или /model, «продолжай», «Untitled»), или чат явно создан программой для проверки, а не человеком для дела: «Тест перезапуска сайта», «test worker chat», «create note.txt file», «Say the word …».',
    '',
    'Ответь ТОЛЬКО JSON-массивом, по одному элементу на каждый id, без пояснений.',
    '',
    'Чаты:',
    JSON.stringify(chats.map((chat) => ({
      id: chat.id,
      title: chat.title.slice(0, TITLE_MAX_CHARS),
      ...(chat.folder ? { folder: chat.folder } : {}),
    }))),
  ].join('\n');
}

/**
 * Ответ модели → решение на каждый id. Имя группы, которого нет, не
 * выдумывается в группу: такое решение становится темой-кандидатом.
 */
export function parseClassifierResponse(
  raw: string,
  chatIds: number[],
  groupNames: string[],
): Map<number, ClassifierDecision> {
  const decisions = new Map<number, ClassifierDecision>();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end <= start) return decisions;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return decisions;
  }
  if (!Array.isArray(parsed)) return decisions;

  const known = new Set(chatIds);
  const groupByNormalized = new Map(groupNames.map((name) => [normalizeTopic(name), name]));
  for (const item of parsed) {
    const { id, group, topic, skip } = (item ?? {}) as Record<string, unknown>;
    if (typeof id !== 'number' || !known.has(id) || decisions.has(id)) continue;
    if (typeof group === 'string' && group.trim()) {
      const existing = groupByNormalized.get(normalizeTopic(group));
      decisions.set(id, existing ? { kind: 'group', name: existing } : { kind: 'topic', topic: cleanTopic(group) });
    } else if (typeof topic === 'string' && topic.trim()) {
      const existing = groupByNormalized.get(normalizeTopic(topic));
      decisions.set(id, existing ? { kind: 'group', name: existing } : { kind: 'topic', topic: cleanTopic(topic) });
    } else if (skip === true) {
      decisions.set(id, { kind: 'skip' });
    }
  }
  return decisions;
}

function cleanTopic(topic: string): string {
  const text = topic.trim().replace(/\s+/g, ' ').replace(/^[«"']+|[»"']+$/g, '');
  return text.length > TOPIC_MAX_CHARS ? text.slice(0, TOPIC_MAX_CHARS).trim() : text;
}

function projectFolder(projectPath: string | null): string | undefined {
  if (!projectPath || path.resolve(projectPath) === os.homedir()) return undefined;
  return path.basename(projectPath);
}

type CandidateRow = {
  session_id: string;
  custom_name: string;
  project_path: string | null;
  group_source: string | null;
  group_id: string | null;
};

// Чаты Devin сюда не попадают: режим «Devin» работает только на токенах Devin (Егор 03.10.26), а
// разбор по группам — запрос к Claude. Название чата Devin Claude не отправляется: ни как чат на разбор,
// ни как пример группы (groupExamples).
const HUMAN_CHAT_SQL = `
  isArchived = 0
  AND provider <> 'devin'
  AND (origin IS NULL OR origin IN ('terminal', 'web'))
  AND COALESCE(project_path, '') NOT LIKE '/tmp/%'
  AND COALESCE(project_path, '') NOT LIKE '%/e2e%'`;

/** Чаты аккаунта, которые ждут решения модели. */
function pickChatsToClassify(accountDir: string, limit: number): CandidateRow[] {
  return getConnection()
    .prepare(
      `SELECT session_id, custom_name, project_path, group_source, group_id FROM sessions
       WHERE account_dir = ? AND ${HUMAN_CHAT_SQL}
         AND TRIM(COALESCE(custom_name, '')) <> ''
         AND (group_source IS NULL OR group_source = 'ai')
         AND (group_hint_title IS NULL OR group_hint_title <> custom_name)
         AND datetime(REPLACE(COALESCE(updated_at, created_at), 'T', ' ')) >= datetime('now', ?)
         AND (title_source <> 'naive'
              OR datetime(REPLACE(created_at, 'T', ' ')) <= datetime('now', ?))
       ORDER BY COALESCE(updated_at, created_at) DESC
       LIMIT ?`,
    )
    .all(accountDir, `-${LOOKBACK_DAYS} days`, `-${NAIVE_TITLE_SETTLE_MINUTES} minutes`, limit) as CandidateRow[];
}

function groupExamples(accountDir: string): ClassifierGroup[] {
  const db = getConnection();
  return chatGroupsDb.list(accountDir).map((group) => ({
    name: group.name,
    examples: (
      db.prepare(
        `SELECT custom_name FROM sessions
         WHERE group_id = ? AND isArchived = 0 AND provider <> 'devin' AND TRIM(COALESCE(custom_name, '')) <> ''
         ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?`,
      ).all(group.id, EXAMPLES_PER_GROUP) as Array<{ custom_name: string }>
    ).map((row) => row.custom_name.slice(0, 80)),
  }));
}

function waitingCandidates(accountDir: string): ClassifierCandidate[] {
  const rows = getConnection()
    .prepare(
      `SELECT group_hint, custom_name FROM sessions
       WHERE account_dir = ? AND ${HUMAN_CHAT_SQL}
         AND group_id IS NULL AND group_hint IS NOT NULL
       ORDER BY COALESCE(updated_at, created_at) DESC`,
    )
    .all(accountDir) as Array<{ group_hint: string; custom_name: string | null }>;
  const byTopic = new Map<string, ClassifierCandidate>();
  for (const row of rows) {
    const key = normalizeTopic(row.group_hint);
    const item = byTopic.get(key) ?? { topic: row.group_hint, count: 0, examples: [] };
    item.count += 1;
    if (item.examples.length < 3 && row.custom_name) item.examples.push(row.custom_name.slice(0, 80));
    byTopic.set(key, item);
  }
  return [...byTopic.values()].sort((a, b) => b.count - a.count).slice(0, 40);
}

/**
 * Темы, набравшие CANDIDATE_MIN_CHATS чатов, становятся группами.
 * Возвращает чаты, у которых появилась группа.
 */
export function promoteCandidates(accountDir: string): string[] {
  ensureChatGroupsSchema();
  const db = getConnection();
  const changed: string[] = [];
  let createdGroup = false;
  for (const candidate of waitingCandidates(accountDir)) {
    if (candidate.count < CANDIDATE_MIN_CHATS) continue;
    const name = candidate.topic.trim();
    const existing = chatGroupsDb.list(accountDir).find((group) => normalizeTopic(group.name) === normalizeTopic(name));
    const groupId = existing?.id ?? chatGroupsDb.create(accountDir, { name, keywords: [] }).id;
    if (!existing) createdGroup = true;
    const groupName = existing?.name ?? name;
    const ids = (
      db.prepare(
        `SELECT session_id, group_hint FROM sessions
         WHERE account_dir = ? AND ${HUMAN_CHAT_SQL} AND group_id IS NULL AND group_hint IS NOT NULL`,
      ).all(accountDir) as Array<{ session_id: string; group_hint: string }>
    )
      .filter((row) => normalizeTopic(row.group_hint) === normalizeTopic(name))
      .map((row) => row.session_id);
    const update = db.prepare(
      `UPDATE sessions SET group_id = ?, group_label = ?, group_source = 'ai', group_hint = NULL
       WHERE session_id = ? AND (group_source IS NULL OR group_source = 'ai')`,
    );
    db.transaction(() => {
      for (const id of ids) {
        if (update.run(groupId, groupName, id).changes > 0) changed.push(id);
      }
    })();
  }
  if (createdGroup) {
    // Появилась новая группа — чаты, ждущие со своей темой, могут подойти к
    // ней. Сбросом «уже разбирали» модель посмотрит их ещё раз.
    db.prepare(
      `UPDATE sessions SET group_hint_title = NULL
       WHERE account_dir = ? AND group_id IS NULL AND group_hint IS NOT NULL`,
    ).run(accountDir);
  }
  return changed;
}

/** Применяет решения модели. Возвращает чаты, у которых сменилась группа. */
export function applyDecisions(
  accountDir: string,
  rows: CandidateRow[],
  decisions: Map<number, ClassifierDecision>,
): string[] {
  ensureChatGroupsSchema();
  const db = getConnection();
  const groupsByName = new Map(chatGroupsDb.list(accountDir).map((group) => [group.name, group]));
  const changed: string[] = [];
  const update = db.prepare(
    `UPDATE sessions SET group_id = ?, group_label = ?, group_source = ?, group_hint = ?, group_hint_title = ?
     WHERE session_id = ? AND (group_source IS NULL OR group_source = 'ai')`,
  );

  const markSeen = db.prepare('UPDATE sessions SET group_hint_title = ? WHERE session_id = ?');

  db.transaction(() => {
    rows.forEach((row, index) => {
      const decision = decisions.get(index);
      if (!decision) {
        // Модель про чат промолчала. Молчание — не решение «убрать из
        // группы»: группа остаётся, чат лишь помечается разобранным. Иначе он
        // уходил бы модели на каждом проходе, вечно и за счёт подписки.
        markSeen.run(row.custom_name, row.session_id);
        return;
      }
      const group = decision.kind === 'group' ? groupsByName.get(decision.name) : undefined;
      const nextGroupId = group?.id ?? null;
      const result = update.run(
        nextGroupId,
        group?.name ?? null,
        group ? 'ai' : null,
        decision.kind === 'topic' ? decision.topic : null,
        row.custom_name,
        row.session_id,
      );
      if (result.changes > 0 && nextGroupId !== row.group_id) changed.push(row.session_id);
    });
  })();
  return changed;
}

async function removeTitleStub(configDir: string, sessionId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return;
  const projectsDir = path.join(configDir, 'projects');
  let dirs: string[] = [];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return;
  }
  await Promise.all(dirs.map(async (dir) => {
    const file = path.join(projectsDir, dir, `${sessionId}.jsonl`);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > TITLE_STUB_MAX_BYTES) return;
      const lines = (await readFile(file, 'utf-8')).split('\n').filter((line) => line.trim());
      const onlyTitles = lines.length > 0 && lines.every((line) => {
        try {
          const type = (JSON.parse(line) as { type?: unknown }).type;
          return type === 'ai-title' || type === 'custom-title';
        } catch {
          return false;
        }
      });
      if (onlyTitles) await unlink(file);
    } catch {
      // Файла нет — убирать нечего.
    }
  }));
}

export async function askClassifierModel(prompt: string, accountDir: string): Promise<string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  env.CLAUDE_CONFIG_DIR = accountDir;
  await mkdir(CLASSIFIER_CWD, { recursive: true }).catch(() => undefined);

  const instance = query({
    prompt,
    options: {
      cwd: CLASSIFIER_CWD,
      model: 'sonnet',
      tools: [],
      maxTurns: 1,
      thinking: { type: 'disabled' },
      persistSession: false,
      settingSources: [],
      env,
    },
  });

  let resultText = '';
  let sessionId: string | undefined;
  const timer = setTimeout(() => {
    try {
      instance.close?.();
    } catch {
      // Цикл ниже просто закончится.
    }
  }, MODEL_TIMEOUT_MS);
  timer.unref?.();
  try {
    for await (const message of instance as AsyncIterable<Record<string, unknown>>) {
      if (typeof message.session_id === 'string' && !sessionId) sessionId = message.session_id;
      if (message.type === 'result' && typeof message.result === 'string') resultText = message.result;
    }
  } finally {
    clearTimeout(timer);
    if (sessionId) {
      const id = sessionId;
      await removeTitleStub(accountDir, id);
      setTimeout(() => void removeTitleStub(accountDir, id), 20 * 1000).unref?.();
    }
  }
  return resultText;
}

type Ask = (prompt: string, accountDir: string) => Promise<string>;

/** Один проход по аккаунту. Возвращает чаты, у которых сменилась группа. */
export async function classifyAccountChats(accountDir: string, ask: Ask = askClassifierModel): Promise<string[]> {
  ensureChatGroupsSchema();
  const changed = new Set<string>();
  const seen = new Set<string>();
  for (let batch = 0; batch < MAX_BATCHES_PER_PASS; batch += 1) {
    const rows = pickChatsToClassify(accountDir, BATCH_SIZE).filter((row) => !seen.has(row.session_id));
    if (rows.length === 0) break;
    rows.forEach((row) => seen.add(row.session_id));

    const groups = groupExamples(accountDir);
    const prompt = buildClassifierPrompt(
      groups,
      waitingCandidates(accountDir),
      rows.map((row, id) => ({ id, title: row.custom_name, folder: projectFolder(row.project_path) })),
    );
    const decisions = parseClassifierResponse(
      await ask(prompt, accountDir),
      rows.map((_, id) => id),
      groups.map((group) => group.name),
    );
    if (decisions.size === 0) {
      // Ни одного решения — сбой модели, а не ответ. Чаты не помечаются, а
      // проход бросает ошибку: startChatGroupClassifier отложит аккаунт.
      throw new Error('модель не дала ни одного решения');
    }
    applyDecisions(accountDir, rows, decisions).forEach((id) => changed.add(id));
    promoteCandidates(accountDir).forEach((id) => changed.add(id));
  }
  return [...changed];
}

function accountsWithHumanChats(): string[] {
  return (
    getConnection()
      .prepare(`SELECT DISTINCT account_dir FROM sessions WHERE account_dir IS NOT NULL AND ${HUMAN_CHAT_SQL}`)
      .all() as Array<{ account_dir: string }>
  ).map((row) => row.account_dir);
}

// Один процесс сервера на базу — флаг в памяти этого достаточно.
let running = false;
/** Сбои подряд по аккаунту и время, раньше которого аккаунт не разбирается. */
const failures = new Map<string, { count: number; retryAt: number }>();
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

/** Фоновый разбор: раз в несколько минут, по одному проходу за раз. */
export function startChatGroupClassifier(onChanged: (sessionIds: string[]) => Promise<void> | void): void {
  if (process.env.CHAT_GROUP_CLASSIFIER === 'off') return;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      for (const accountDir of accountsWithHumanChats()) {
        const failure = failures.get(accountDir);
        if (failure && Date.now() < failure.retryAt) continue;
        try {
          const changed = await classifyAccountChats(accountDir);
          failures.delete(accountDir);
          if (changed.length) {
            console.log(`[groups] ${accountDir}: разложено чатов ${changed.length}`);
            await onChanged(changed);
          }
        } catch (error) {
          // Сбой модели (лимит, таймаут, битый ответ) — пауза растёт вдвое
          // с каждым сбоем подряд, чтобы не жечь подписку одним и тем же входом.
          const count = (failure?.count ?? 0) + 1;
          const delay = Math.min(PASS_INTERVAL_MS * 2 ** count, MAX_BACKOFF_MS);
          failures.set(accountDir, { count, retryAt: Date.now() + delay });
          console.error(`[groups] разбор ${accountDir} не удался (${count} подряд, пауза ${Math.round(delay / 60000)} мин):`, error);
        }
      }
    } finally {
      running = false;
    }
  };
  setTimeout(() => void pass(), FIRST_PASS_DELAY_MS).unref?.();
  setInterval(() => void pass(), PASS_INTERVAL_MS).unref?.();
}

export const __testing = { pickChatsToClassify, waitingCandidates };

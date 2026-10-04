import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyAccountChats,
  isMachineMadeChat,
  parseClassifierResponse,
} from '@/modules/chat-groups/chat-group-classifier.js';
import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { chatGroupsDb } from '@/modules/database/repositories/chat-groups.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

const ACCOUNT = '/accounts/egor';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'chat-group-classifier-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function addChat(id: string, title: string, origin = 'web', projectPath = '/home/egor') {
  sessionsDb.createSession(id, 'claude', projectPath, title);
  getConnection()
    .prepare("UPDATE sessions SET account_dir = ?, origin = ?, title_source = 'ai' WHERE session_id = ?")
    .run(ACCOUNT, origin, id);
}

function row(id: string) {
  return getConnection()
    .prepare('SELECT group_id, group_label, group_source, group_hint FROM sessions WHERE session_id = ?')
    .get(id) as { group_id: string | null; group_label: string | null; group_source: string | null; group_hint: string | null };
}

/** Модель-заглушка: отвечает по названию чата из подсказки. */
function fakeModel(answer: (title: string) => Record<string, unknown>) {
  /** Названия чатов, отданных модели на разбор, — по вызову на элемент. */
  const prompts: string[] = [];
  const ask = async (prompt: string) => {
    const chats = JSON.parse(prompt.slice(prompt.lastIndexOf('\n[') + 1)) as Array<{ id: number; title: string }>;
    prompts.push(chats.map((chat) => chat.title).join('\n'));
    return JSON.stringify(chats.map((chat) => ({ id: chat.id, ...answer(chat.title) })));
  };
  return { ask, prompts };
}

test('чаты Devin модели (Claude) не отдаются: режим Devin тратит только токены Devin', async () => {
  await withIsolatedDatabase(async () => {
    // Чат Claude (должен уйти на разбор) и чат Devin с обычным названием и обычной папкой.
    addChat('claude-chat', 'Правка сайта');
    sessionsDb.createSession('devin-chat', 'devin', '/home/egor', 'Разведка по коду');
    getConnection()
      .prepare("UPDATE sessions SET account_dir = ?, origin = 'web', title_source = 'ai' WHERE session_id = 'devin-chat'")
      .run(ACCOUNT);

    const asked: string[] = [];
    await classifyAccountChats(ACCOUNT, async (prompt) => {
      asked.push(prompt);
      return JSON.stringify({ decisions: [] });
    }).catch(() => undefined); // пустой ответ модели — сбой прохода, нам важен только состав запроса

    assert.ok(asked.length > 0, 'чат Claude должен был уйти на разбор');
    assert.ok(asked.every((prompt) => !prompt.includes('Разведка по коду')), 'название чата Devin ушло в Claude');
    assert.ok(asked.some((prompt) => prompt.includes('Правка сайта')));
  });
});

test('ответ модели: несуществующая группа становится темой, лишние id отбрасываются', () => {
  const decisions = parseClassifierResponse(
    'вот: [{"id":0,"group":"сайт claude"},{"id":1,"group":"Покупки"},{"id":2,"skip":true},{"id":9,"group":"Сайт Claude"}]',
    [0, 1, 2],
    ['Сайт Claude'],
  );
  assert.deepEqual(decisions.get(0), { kind: 'group', name: 'Сайт Claude' });
  assert.deepEqual(decisions.get(1), { kind: 'topic', topic: 'Покупки' });
  assert.deepEqual(decisions.get(2), { kind: 'skip' });
  assert.equal(decisions.size, 3);
  assert.equal(parseClassifierResponse('не json', [0], []).size, 0);
});

test('чаты программ и тестовых прогонов — не чаты человека', () => {
  assert.equal(isMachineMadeChat({ origin: 'auto', project_path: '/home/claude' }), true);
  assert.equal(isMachineMadeChat({ origin: 'terminal', project_path: '/home/claude/ask-bot/data/e2e-chatA4' }), true);
  assert.equal(isMachineMadeChat({ origin: 'terminal', project_path: '/tmp/claude-1000/x/scratchpad' }), true);
  assert.equal(isMachineMadeChat({ origin: 'web', project_path: '/home/claude' }), false);
  assert.equal(isMachineMadeChat({ origin: 'terminal', project_path: '/home/claude/sunschool' }), false);
});

test('модель кладёт чат в группу; новая тема становится группой только с третьего чата', async () => {
  await withIsolatedDatabase(async () => {
    const site = chatGroupsDb.create(ACCOUNT, { name: 'Сайт Claude', keywords: ['claude ui'] });
    addChat('s1', 'Фриз прокрутки чата');
    addChat('p1', 'Прошивка Marantz');
    addChat('p2', 'Прошивка Marantz через архивы');
    addChat('bot', 'test worker chat', 'terminal', '/home/claude/ask-bot/data/e2e-chatA');
    addChat('hidden', 'Say the word EPSILON', 'auto');

    const { ask, prompts } = fakeModel((title) => (title.startsWith('Фриз')
      ? { group: 'Сайт Claude' }
      : title.startsWith('Прошивка') ? { topic: 'Оборудование' } : { group: 'Сайт Claude' }));

    await classifyAccountChats(ACCOUNT, ask);
    assert.equal(row('s1').group_id, site.id);
    assert.equal(row('s1').group_source, 'ai');
    // Две — ещё не группа: ждут в общем списке с темой.
    assert.equal(row('p1').group_id, null);
    assert.equal(row('p1').group_hint, 'Оборудование');
    // Чаты программ модели даже не показываются.
    assert.ok(prompts.every((prompt) => !prompt.includes('test worker chat') && !prompt.includes('EPSILON')));
    assert.equal(row('bot').group_id, null);

    addChat('p3', 'Прошивка усилителя');
    await classifyAccountChats(ACCOUNT, ask);
    const created = chatGroupsDb.list(ACCOUNT).find((group) => group.name === 'Оборудование');
    assert.ok(created, 'третий чат темы создаёт группу');
    for (const id of ['p1', 'p2', 'p3']) {
      assert.equal(row(id).group_id, created.id);
      assert.equal(row(id).group_hint, null);
    }
  });
});

test('ручной выбор модель не трогает, а подбор по словам не сбрасывает решение модели', async () => {
  await withIsolatedDatabase(async () => {
    const site = chatGroupsDb.create(ACCOUNT, { name: 'Сайт Claude', keywords: ['claude ui'] });
    const other = chatGroupsDb.create(ACCOUNT, { name: 'Сервер', keywords: ['ssh'] });
    addChat('m', 'Скролл панели чатов');
    addChat('a', 'Исчезающие запросы');
    chatGroupsDb.assignManually(ACCOUNT, 'm', other.id);

    const { ask, prompts } = fakeModel(() => ({ group: 'Сайт Claude' }));
    await classifyAccountChats(ACCOUNT, ask);
    assert.equal(row('m').group_id, other.id);
    assert.ok(prompts.every((prompt) => !prompt.includes('Скролл панели')));
    assert.equal(row('a').group_id, site.id);

    // Наблюдатель переписки перезапускает подбор по словам — слов нет, но
    // группа, выбранная моделью, остаётся.
    chatGroupsDb.autoAssignSession('a');
    assert.equal(row('a').group_id, site.id);

    // Повторный проход не зовёт модель ради уже разобранных чатов.
    const before = prompts.length;
    await classifyAccountChats(ACCOUNT, ask);
    assert.equal(prompts.length, before);
  });
});

test('сбой модели не помечает чаты, а молчание про чат — пропуск без повторных вызовов', async () => {
  await withIsolatedDatabase(async () => {
    chatGroupsDb.create(ACCOUNT, { name: 'Сайт Claude', keywords: [] });
    addChat('x', 'Исчезающие запросы');
    addChat('y', 'Фриз прокрутки');

    await assert.rejects(classifyAccountChats(ACCOUNT, async () => 'лимит исчерпан'));
    assert.equal(
      (getConnection().prepare("SELECT COUNT(*) AS n FROM sessions WHERE group_hint_title IS NOT NULL").get() as { n: number }).n,
      0,
    );

    let calls = 0;
    const answerOnlyFirst = async (prompt: string) => {
      calls += 1;
      const chats = JSON.parse(prompt.slice(prompt.lastIndexOf('\n[') + 1)) as Array<{ id: number; title: string }>;
      return JSON.stringify([{ id: chats[0].id, group: 'Сайт Claude' }]);
    };
    await classifyAccountChats(ACCOUNT, answerOnlyFirst);
    const afterFirst = calls;
    await classifyAccountChats(ACCOUNT, answerOnlyFirst);
    assert.equal(calls, afterFirst, 'чат без ответа не уходит модели снова');
  });
});

test('молчание модели про чат, уже лежащий в группе, группу не стирает', async () => {
  await withIsolatedDatabase(async () => {
    const site = chatGroupsDb.create(ACCOUNT, { name: 'Сайт Claude', keywords: [] });
    addChat('g', 'Фриз прокрутки');
    addChat('n', 'Исчезающие запросы');
    await classifyAccountChats(ACCOUNT, fakeModel(() => ({ group: 'Сайт Claude' })).ask);
    assert.equal(row('g').group_id, site.id);

    // Название сменилось — чат снова у модели, но она ответила только про другой.
    getConnection().prepare("UPDATE sessions SET custom_name = 'Фриз прокрутки ленты' WHERE session_id = 'g'").run();
    getConnection().prepare("UPDATE sessions SET custom_name = 'Исчезающие запросы в чате' WHERE session_id = 'n'").run();
    await classifyAccountChats(ACCOUNT, async (prompt) => {
      const chats = JSON.parse(prompt.slice(prompt.lastIndexOf('\n[') + 1)) as Array<{ id: number; title: string }>;
      const other = chats.find((chat) => chat.title.startsWith('Исчезающие'));
      return JSON.stringify(other ? [{ id: other.id, group: 'Сайт Claude' }] : []);
    });
    assert.equal(row('g').group_id, site.id);
  });
});

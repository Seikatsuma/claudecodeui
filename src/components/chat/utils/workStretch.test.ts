import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../types/types';
import { isToolGroupItem } from './toolGrouping';
import { describeWorkStretch, groupWorkStretches, isMostlyRussian, isWorkStretchItem, lastStepDescription, workStretchLiveTail, workStretchRows } from './workStretch';

const at = (n: number) => `2026-09-13T10:00:${String(n).padStart(2, '0')}Z`;
const user = (text: string, n = 0): ChatMessage => ({ type: 'user', content: text, timestamp: at(n) });
const reply = (text: string, n = 0): ChatMessage => ({ type: 'assistant', content: text, timestamp: at(n) });
const think = (text: string, n = 0): ChatMessage => ({ type: 'assistant', isThinking: true, content: text, timestamp: at(n) });
const tool = (name: string, n = 0): ChatMessage => ({ type: 'assistant', isToolUse: true, toolName: name, timestamp: at(n) });
const LONG = 'Причина в том, что счётчик событий не сбрасывается между работами, поэтому вкладка теряет сигнал «думает».';
const EN = "I've created a branch from the clean head and I'm starting to build a private list of how message types are handled.";
type Stretch = Extract<ReturnType<typeof groupWorkStretches>[number], { _isStretch: true }>;

test('вся работа между сообщением и ответом — один элемент', () => {
  const items = groupWorkStretches([
    user('почини', 1), think(LONG, 2), tool('Bash', 3), think('жду', 4), tool('Read', 5), tool('Bash', 6), reply('Готово, проверил на сайте.', 7),
  ]);
  assert.equal(items.length, 3);
  assert.equal(isWorkStretchItem(items[1]), true);
  const stretch = items[1] as Stretch;
  assert.equal(stretch.actionCount, 3);
  assert.equal(stretch.thoughts.length, 1, 'короткое «жду» даже на разбор не идёт');
  assert.equal(stretch.messages.length, 5);
});

test('ответ и сообщение человека не прячутся в свёртку', () => {
  const items = groupWorkStretches([user('a', 1), reply('ответ', 2), user('b', 3)]);
  assert.equal(items.filter(isWorkStretchItem).length, 0);
  assert.equal(items.length, 3);
});

test('только пустые размышления не дают ни строки', () => {
  const items = groupWorkStretches([user('a', 1), think('', 2), think('  ', 3), reply('ответ', 4)]);
  assert.equal(items.filter(isWorkStretchItem).length, 0);
  assert.equal(items.length, 2);
});

test('подпись строки: этапы после разбора, до разбора — без выдуманного числа', () => {
  assert.equal(describeWorkStretch({ stageCount: 1, actionCount: 1 }), 'Ход работы · 1 этап · 1 действие');
  assert.equal(describeWorkStretch({ stageCount: 12, actionCount: 22 }), 'Ход работы · 12 этапов · 22 действия');
  assert.equal(describeWorkStretch({ actionCount: 5, hasThoughts: true }), 'Ход работы · 5 действий');
  assert.equal(describeWorkStretch({ actionCount: 0, hasThoughts: true }), 'Ход работы · размышления');
  assert.equal(describeWorkStretch({ stageCount: 0, actionCount: 3 }), 'Ход работы · 3 действия');
});

test('раскрытый ход работы показывает отобранные мысли между действиями', () => {
  const items = groupWorkStretches([
    user('почини', 1), tool('Bash', 2), think(LONG, 3), tool('Bash', 4), think(EN, 5), tool('Bash', 6), reply('Готово.', 7),
  ]);
  const stretch = items[1] as Stretch;
  const rows = workStretchRows(stretch, new Set([stretch.thoughts[0]]));
  const thoughts = rows.filter((row) => !isToolGroupItem(row) && row.isThinking);
  assert.equal(thoughts.length, 1, 'показана только отобранная мысль');
  assert.equal(rows.length, 3, 'действие · мысль · два действия подряд одной строкой');
});

test('ошибки действий видны в свёрнутой строке', () => {
  const failed: ChatMessage = { ...tool('Bash', 3), toolResult: { content: 'boom', isError: true } as ChatMessage['toolResult'] };
  const items = groupWorkStretches([user('a', 1), tool('Read', 2), failed, reply('Не вышло.', 4)]);
  const stretch = items[1] as Stretch;
  assert.equal(stretch.errorCount, 1);
  assert.equal(describeWorkStretch(stretch), 'Ход работы · 2 действия · 1 ошибка');
});

test('план на утверждение и вопрос с вариантами не прячутся в свёртку', () => {
  const items = groupWorkStretches([user('a', 1), tool('Read', 2), tool('ExitPlanMode', 3), tool('Bash', 4), tool('AskUserQuestion', 5)]);
  const visibleTools = items.filter((item) => !isWorkStretchItem(item) && item.isToolUse).map((item) => (item as ChatMessage).toolName);
  assert.deepEqual(visibleTools, ['ExitPlanMode', 'AskUserQuestion']);
});

test('потолка нет: долгая работа отдаёт на разбор все мысли, на любом языке', () => {
  const msgs = [user('a', 1)];
  for (let i = 0; i < 12; i += 1) { msgs.push(think(`${i % 2 ? EN : LONG} Шаг ${i}.`, 2 + i)); msgs.push(tool('Bash', 20 + i)); }
  msgs.push(reply('Готово.', 50));
  const stretch = groupWorkStretches(msgs)[1] as Stretch;
  assert.equal(stretch.thoughts.length, 12);
  const shown = workStretchRows(stretch, new Set(stretch.thoughts)).filter((row) => !isToolGroupItem(row) && row.isThinking);
  assert.equal(shown.length, 12);
  assert.equal(isMostlyRussian(EN), false);
  assert.equal(isMostlyRussian(LONG), true);
});

test('текущий шаг — описание последнего действия, видно без раскрытия', () => {
  const withDesc = (name: string, description: string, n: number): ChatMessage => ({ ...tool(name, n), toolInput: JSON.stringify({ command: 'x', description }) });
  assert.equal(lastStepDescription([withDesc('Bash', 'Собираю сайт', 1), think(LONG, 2), withDesc('Bash', 'Проверяю, дошла ли правка', 3)]), 'Проверяю, дошла ли правка');
  assert.equal(lastStepDescription([withDesc('Bash', 'Собираю сайт', 1), tool('Read', 2)]), 'Собираю сайт', 'действие без описания пропускается');
  assert.equal(lastStepDescription([think(LONG, 1)]), null);
});

// Живой хвост и шаги помощника (19.09.26): Егор хочет видеть, на чём ИИ думает
// во время работы, но чтобы по окончании всё было свёрнуто.
const agentCall = (id: string, description: string, done = false): ChatMessage => ({
  type: 'assistant', isToolUse: true, toolName: 'Agent', toolId: id,
  toolInput: JSON.stringify({ description }), toolResult: done ? { content: 'итог', isError: false } : null, timestamp: at(10),
});
const helperStep = (parent: string, description: string, done = true, isError = false): ChatMessage => ({
  type: 'assistant', isToolUse: true, toolName: 'Bash', parentToolUseId: parent,
  toolInput: JSON.stringify({ description }), toolResult: done ? { content: 'ok', isError } : null, timestamp: at(11),
});
const helperNote = (parent: string, text: string): ChatMessage => ({ type: 'assistant', content: text, parentToolUseId: parent, timestamp: at(12) });

test('реплика помощника — работа, а не ответ чата; его шаги не входят в число действий', () => {
  const items = groupWorkStretches([
    user('проверь', 1), agentCall('t1', 'Проверяющий, круг 2'),
    helperStep('t1', 'Смотрю итог прогона'), helperNote('t1', 'Устойчиво 3/3. Запускаю полный прогон.'),
    helperStep('t1', 'Гоняю ловушки', false),
  ]);
  assert.equal(items.length, 2, 'реплика помощника не рвёт свёртку и не встаёт ответом');
  const stretch = items[1] as Stretch;
  assert.equal(stretch.actionCount, 1, 'после перечитывания переписки шагов помощника нет — число не должно прыгать');
  const rows = workStretchRows(stretch, new Set());
  assert.ok(rows.some((row) => !isToolGroupItem(row) && (row as ChatMessage).content === 'Устойчиво 3/3. Запускаю полный прогон.'),
    'в раскрытой свёртке реплика помощника видна');
});

test('живой хвост: этапы мысли по-русски, шаги с именем помощника, последний — идущий', () => {
  const stretch = groupWorkStretches([
    user('проверь', 1), think(EN, 2), think(LONG, 3), agentCall('t1', 'Проверяющий, круг 2'),
    helperStep('t1', 'Смотрю итог прогона'), helperNote('t1', 'Устойчиво 3/3.'), helperStep('t1', 'Гоняю ловушки', false),
  ])[1] as Stretch;
  const tail = workStretchLiveTail(stretch, (m) => (m.content === EN ? 'Сделал ветку от чистой головы' : null));
  assert.deepEqual(tail.map((line) => [line.kind, line.helper, line.text, line.running]), [
    ['stage', null, 'Сделал ветку от чистой головы', false],
    ['step', null, 'Проверяющий, круг 2', true],
    ['step', 'Проверяющий, круг 2', 'Смотрю итог прогона', false],
    ['note', 'Проверяющий, круг 2', 'Устойчиво 3/3.', false],
    ['step', 'Проверяющий, круг 2', 'Гоняю ловушки', true],
  ], 'неразобранная или неважная мысль в хвост не идёт');
  assert.equal(workStretchLiveTail(stretch, () => null, 2).length, 2, 'хвост ограничен последними строками');
});

test('живой хвост не забивается безымянными exec/Bash вместо текста этапов', () => {
  const described: ChatMessage = {
    ...tool('Bash', 4),
    toolInput: JSON.stringify({ command: 'npm test', description: 'Проверяю тесты' }),
  };
  const stretch = groupWorkStretches([
    user('проверь', 1),
    think(LONG, 2),
    tool('exec', 3),
    tool('Bash', 4),
    described,
  ])[1] as Stretch;

  const tail = workStretchLiveTail(stretch, (message) => message.isThinking ? 'Нашёл причину сбоя' : null);
  assert.deepEqual(tail.map((line) => line.text), ['Нашёл причину сбоя', 'Проверяю тесты']);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from './useSessionStore';
import { computeMerged, isLongReplyAlreadyOnServer } from './sessionMessageReconciliation';

const msg = (id: string, over: Partial<NormalizedMessage>): NormalizedMessage => ({
  id, sessionId: 's1', timestamp: '2026-09-14T13:08:18.000Z', provider: 'claude', kind: 'text', role: 'assistant', content: '', ...over,
});

const REPLY = 'Как я понял задачу. Нужен документ, который за полчаса-час объяснит вам всю финансовую систему.';

test('живая копия длинного ответа узнаётся на диске в любом месте переписки', () => {
  // Снимок Егора 14.09.26: ответ встал второй раз ниже, через «Ход работы» и
  // другой ответ. На диске между сообщением человека и ответом было служебное
  // уведомление, и сверка «в том же ходе» искала не тот ход.
  const server = [
    msg('u1', { role: 'user', content: 'Сделай документ по финансам' }),
    msg('n1', { role: 'user', content: '<task-notification>готово</task-notification>' }),
    msg('a1', { content: REPLY }),
    msg('t1', { kind: 'tool_use', toolName: 'Bash', toolId: 'tool-1' }),
    msg('a2', { content: 'Три правки внесены. Пересобираю документ и снова проверяю вёрстку.' }),
  ];
  assert.equal(isLongReplyAlreadyOnServer(msg('live-a1', { content: `  ${REPLY}\n` }), server), true);
});

test('короткие и отличающиеся ответы копией не считаются', () => {
  const server = [msg('a1', { content: 'Готово.' }), msg('a2', { content: REPLY })];
  assert.equal(isLongReplyAlreadyOnServer(msg('live', { content: 'Готово.' }), server), false, 'короткий повтор может быть настоящим');
  assert.equal(isLongReplyAlreadyOnServer(msg('live', { content: `${REPLY} И ещё строка.` }), server), false);
  assert.equal(isLongReplyAlreadyOnServer(msg('live', { content: REPLY }), [msg('u', { role: 'user', content: REPLY })]), false, 'текст человека — не ответ');
});

test('эхо отправки рядом с серверной копией не ломает сверку хода', () => {
  // Снимок Егора 08.10.26 (Devin): короткие живые реплики («Гоняю юнит и
  // компиляцию.», «Коммичу и перезапускаю службу.») вставали в ленту дважды.
  // В realtimeMessages навсегда остаётся queued_/local_ эхо каждой отправки —
  // счётчик ходов видел его рядом с серверной копией, ordinal уезжал за конец
  // истории, сверка «в том же ходе» отключалась, а «длинный ответ на диске»
  // короткие строки не ловит.
  const server = [
    msg('u1', { role: 'user', content: 'Проверь сборку', timestamp: '2026-10-08T02:00:00.000Z' }),
    msg('a1', { content: 'Смотрю прогон и журнал сборки.', timestamp: '2026-10-08T02:00:10.000Z' }),
    msg('t1', { kind: 'tool_use', toolName: 'Bash', toolId: 'tool-1', timestamp: '2026-10-08T02:00:11.000Z' }),
    msg('a2', { content: 'Гоняю юнит и компиляцию.', timestamp: '2026-10-08T02:00:20.000Z' }),
  ];
  const realtime = [
    // Эхо той же отправки, пришедшее из серверной очереди, — висит в
    // realtimeMessages, хотя серверная копия уже на диске.
    msg('queued_9', { role: 'user', content: 'Проверь сборку', timestamp: '2026-10-08T02:00:01.000Z' }),
    msg('live-a1', { content: 'Смотрю прогон и журнал сборки.', timestamp: '2026-10-08T02:00:40.000Z' }),
    msg('live-t1', { kind: 'tool_use', toolName: 'Bash', toolId: 'tool-1', timestamp: '2026-10-08T02:00:41.000Z' }),
    msg('live-a2', { content: 'Гоняю юнит и компиляцию.', timestamp: '2026-10-08T02:00:42.000Z' }),
  ];
  const merged = computeMerged(server, realtime);
  const texts = merged.filter((m) => m.kind === 'text' && m.role === 'assistant');
  assert.equal(texts.length, 2, `живые копии должны сняться, а не встать дублём: ${texts.map((m) => m.id).join(', ')}`);
  assert.equal(merged.filter((m) => m.role === 'user').length, 1);
});

test('не принятое сервером эхо всё ещё открывает свой ход', () => {
  // Отправка в пути, на диске её нет: живые строки под ней — отдельный ход,
  // сверка не должна склеивать их с ответом ПРОШЛОГО хода с тем же текстом.
  const server = [
    msg('u1', { role: 'user', content: 'Первый', timestamp: '2026-10-08T02:00:00.000Z' }),
    msg('a1', { content: 'Одинаковый ответ.', timestamp: '2026-10-08T02:00:10.000Z' }),
  ];
  const realtime = [
    msg('local_1', { role: 'user', content: 'Второй', timestamp: '2026-10-08T02:10:00.000Z' }),
    msg('live-a2', { content: 'Одинаковый ответ.', timestamp: '2026-10-08T02:10:10.000Z' }),
  ];
  const merged = computeMerged(server, realtime);
  const texts = merged.filter((m) => m.kind === 'text' && m.role === 'assistant');
  assert.equal(texts.length, 2, 'новый ход ещё не на диске — его реплика не дубль прошлого');
});

test('финализированный обрывок потока снимается полным ответом с диска', () => {
  // Обрыв сокета: stream_end/complete доехали, часть дельт потерялась — живая
  // строка уже kind 'text', но держит только кусок ответа. Раньше её ловила
  // только ветка stream_delta; обрубок оставался рядом с полным текстом.
  const server = [
    msg('u1', { role: 'user', content: 'Что там?', timestamp: '2026-10-08T02:00:00.000Z' }),
    msg('a1', { content: 'Нашёл причину: счётчик ходов съезжал на эхо отправки.', timestamp: '2026-10-08T02:00:10.000Z' }),
  ];
  const realtime = [
    msg('text_obryvok', { content: 'Нашёл причину: счётчик ходов', timestamp: '2026-10-08T02:00:40.000Z' }),
  ];
  const merged = computeMerged(server, realtime);
  const texts = merged.filter((m) => m.kind === 'text' && m.role === 'assistant');
  assert.equal(texts.length, 1);
  assert.equal(texts[0].id, 'a1');
});

test('отдельная короткая реплика, похожая на начало другого ответа, остаётся', () => {
  // Страховка от ложного срабатывания fragment-сверки: это ДРУГОЙ ответ того
  // же хода, а не кусок — совпадение началом здесь случайно не бывает, потому
  // что fragment требует полного вхождения строки в серверный ответ.
  const server = [
    msg('u1', { role: 'user', content: 'Два ответа', timestamp: '2026-10-08T02:00:00.000Z' }),
    msg('a1', { content: 'Смотрю логи.', timestamp: '2026-10-08T02:00:10.000Z' }),
    msg('a2', { content: 'Нашёл: таймаут на стороне шлюза, ответы резались.', timestamp: '2026-10-08T02:00:20.000Z' }),
  ];
  const realtime = [
    msg('live-x', { content: 'Смотрю логи.', timestamp: '2026-10-08T02:00:40.000Z' }),
    msg('live-y', { content: 'Третий ответ, которого на диске нет.', timestamp: '2026-10-08T02:00:41.000Z' }),
  ];
  const merged = computeMerged(server, realtime);
  const texts = merged.filter((m) => m.kind === 'text' && m.role === 'assistant');
  assert.equal(texts.length, 3, 'live-y — новая реплика, её снимать нельзя');
  assert.ok(texts.some((m) => m.id === 'live-y'));
});

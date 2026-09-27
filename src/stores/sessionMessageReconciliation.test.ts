import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from './useSessionStore';
import { appendRealtimeWithQueuedEcho, removeOptimisticUserEchoes } from './sessionMessageReconciliation';

const createUserMessage = (
  id: string,
  timestamp: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage => ({
  id,
  sessionId: 'session-1',
  timestamp,
  provider: 'claude',
  kind: 'text',
  role: 'user',
  content: '',
  ...overrides,
});

test('replaces an optimistic image-only turn with its persisted Claude copy', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png', name: 'image.png' }],
  });
  const persisted = createUserMessage('claude_image', '2026-07-28T20:30:26.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('does not collapse an attachment-only turn into a server row without attachments', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png' }],
  });
  const persisted = createUserMessage('claude_empty', '2026-07-28T20:30:22.000Z');

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), [local]);
});

test('matches optimistic attachment turns to persisted turns one-to-one', () => {
  const firstLocal = createUserMessage('local_first', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/first.png' }],
  });
  const secondLocal = createUserMessage('local_second', '2026-07-28T20:30:25.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/second.png' }],
  });
  const firstPersisted = createUserMessage('claude_first', '2026-07-28T20:30:22.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  const remainingRealtime = removeOptimisticUserEchoes(
    [firstPersisted],
    [firstLocal, secondLocal],
  );

  assert.deepEqual(remainingRealtime.map((message) => message.id), ['local_second']);
});

test('keeps the existing optimistic text reconciliation behavior', () => {
  const local = createUserMessage('local_text', '2026-07-28T20:30:21.000Z', {
    content: 'hello',
  });
  const persisted = createUserMessage('claude_text', '2026-07-28T20:30:26.000Z', {
    content: 'hello',
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

// Снимок Егора 21.09.26: «2» в 16:53:39 (пузырь вкладки) и «2» в 16:53:54
// (сервер отправил из очереди, ход ещё дописывался).
test('queued server echo replaces the tab bubble instead of adding a second one', () => {
  const local = createUserMessage('local_2', '2026-09-21T13:53:39.000Z', { content: '2' });
  const reply = { ...createUserMessage('a1', '2026-09-21T13:53:40.000Z'), role: 'assistant' as const, content: 'ok' };
  const queued = createUserMessage('queued_q1', '2026-09-21T13:53:54.300Z', { content: '2' });

  assert.deepEqual(appendRealtimeWithQueuedEcho([local, reply], queued), [queued, reply]);
});

test('queued echo without a tab bubble is simply appended', () => {
  const queued = createUserMessage('queued_q1', '2026-09-21T13:53:54.300Z', { content: '2' });
  const other = createUserMessage('local_x', '2026-09-21T13:53:39.000Z', { content: '1' });

  assert.deepEqual(appendRealtimeWithQueuedEcho([other], queued), [other, queued]);
});

// Снимок Егора 27.09.26: «дизан отличаеться» с картинкой дважды, обе в 17:15:38 —
// одна и та же строка из очереди доставлена вкладке второй раз.
test('the same live row delivered twice stays one row', () => {
  const image = { path: '/home/claude/.cloudcli/assets/shot.png', name: 'shot.png' };
  const queued = createUserMessage('queued_74d5', '2026-09-27T14:15:38.100Z', {
    content: 'дизан отличаеться',
    images: [image],
  });
  const reply = { ...createUserMessage('a1', '2026-09-27T14:15:40.000Z'), role: 'assistant' as const, content: 'ok' };
  const persisted = createUserMessage('claude_d', '2026-09-27T14:17:14.496Z', {
    content: 'дизан отличаеться',
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  const realtime = [queued, reply, queued].reduce(appendRealtimeWithQueuedEcho, [] as NormalizedMessage[]);
  assert.deepEqual(realtime.map((message) => message.id), ['queued_74d5', 'a1']);
  assert.deepEqual(removeOptimisticUserEchoes([persisted], realtime).map((message) => message.id), ['a1']);
});

test('queued echo is dropped once the transcript row lands, even after a long wait', () => {
  const local = createUserMessage('local_2', '2026-09-21T13:40:00.000Z', { content: '2' });
  const queued = createUserMessage('queued_q1', '2026-09-21T13:53:54.300Z', { content: '2' });
  const persisted = createUserMessage('claude_2', '2026-09-21T13:53:54.352Z', { content: '2' });

  const realtime = appendRealtimeWithQueuedEcho([local], queued);
  assert.deepEqual(removeOptimisticUserEchoes([persisted], realtime), []);
});

test('two identical sends keep two rows until both are persisted', () => {
  const first = createUserMessage('local_a', '2026-09-21T13:53:39.000Z', { content: '2' });
  const second = createUserMessage('local_b', '2026-09-21T13:53:45.000Z', { content: '2' });
  const queued = createUserMessage('queued_q1', '2026-09-21T13:53:54.300Z', { content: '2' });

  const realtime = appendRealtimeWithQueuedEcho([first, second], queued);
  assert.equal(realtime.length, 2);
});

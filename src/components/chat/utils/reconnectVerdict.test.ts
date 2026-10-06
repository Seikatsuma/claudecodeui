import assert from 'node:assert/strict';
import test from 'node:test';

import { waitForFreshTailAfterReconnect } from './reconnectVerdict';

// Испытание 06.10.26: iPhone проснулся, первый запрос хвоста повис до срока.
// Вердикт обязан переждать догрузку, а не судить по устаревшей ленте.
type State = {
  sessionId: string | null;
  processing: boolean;
  connected: boolean;
  armed: boolean;
  fetchedAt: number;
  calls: string[];
};

function run(
  state: State,
  onRequest?: (state: State, sid: string) => void,
  extra: { deadlineMs?: number } = {},
) {
  return waitForFreshTailAfterReconnect({
    sessionId: () => state.sessionId,
    isProcessing: () => state.processing,
    isConnected: () => state.connected,
    stillArmed: () => state.armed,
    getFetchedAt: () => state.fetchedAt,
    requestLatest: async (sid: string) => {
      state.calls.push(sid);
      onRequest?.(state, sid);
    },
    reconnectedAt: 1000,
    deadlineMs: extra.deadlineMs ?? 5_000,
    recheckMs: 1,
    sleep: async () => { /* настоящего сна в тестах нет */ },
  });
}

const baseState = (): State => ({
  sessionId: 's1', processing: false, connected: true, armed: true, fetchedAt: 0, calls: [],
});

test('свежий хвост уже применён — судим сразу, без запросов', async () => {
  const state = baseState();
  state.fetchedAt = 2000;
  assert.equal(await run(state), 'fresh-tail');
  assert.deepEqual(state.calls, []);
});

test('хвост приезжает после одной виснущей догрузки — вердикт её дождался', async () => {
  const state = baseState();
  const readiness = await run(state, (s) => {
    if (s.calls.length === 2) s.fetchedAt = 2000; // первая висла, вторая притащила
  });
  assert.equal(readiness, 'fresh-tail');
  assert.equal(state.calls.length, 2);
});

test('работа идёт — приговора нет и догрузку не дёргаем зря', async () => {
  const state = baseState();
  state.processing = true;
  assert.equal(await run(state), 'processing');
  assert.deepEqual(state.calls, []);
});

test('связь оборвалась снова во время ожидания — судит следующий реконнект', async () => {
  const state = baseState();
  const readiness = await run(state, (s) => {
    s.connected = false; // обрыв посреди догрузки
  });
  assert.equal(readiness, 'disconnected');
});

test('ожидание сняли извне (ответ поехал по сокету) — выходим без вердикта', async () => {
  const state = baseState();
  const readiness = await run(state, (s) => {
    s.armed = false;
  });
  assert.equal(readiness, 'disarmed');
});

test('хвост не доехал до потолка — судим по тому, что есть', async () => {
  const state = baseState();
  assert.equal(await run(state, undefined, { deadlineMs: 50 }), 'deadline');
  assert.ok(state.calls.length >= 1);
});

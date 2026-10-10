import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_OPEN_TABS, capTabs, reconcileRemoteTabs } from './openTabsLimit';

const tabs = (count: number, openedAt?: (index: number) => number | undefined) =>
  Array.from({ length: count }, (_, index) => ({ sessionId: `s${index}`, openedAt: openedAt?.(index) }));

test('до 15 вкладок список не трогается', () => {
  const list = tabs(MAX_OPEN_TABS, (i) => i + 1);
  assert.equal(capTabs(list, null), list);
});

test('шестнадцатая вытесняет ту, что дольше всех не открывали, а не крайнюю слева', () => {
  // s0 слева, но открывали недавно; самая давняя — s5.
  const list = tabs(16, (i) => (i === 0 ? 1000 : i === 5 ? 1 : 100 + i));
  const ids = capTabs(list, 's15').map((t) => t.sessionId);
  assert.equal(ids.length, 15);
  assert.ok(!ids.includes('s5'));
  assert.ok(ids.includes('s0'));
  assert.deepEqual(ids, list.map((t) => t.sessionId).filter((id) => id !== 's5'), 'порядок остальных тот же');
});

test('открытый чат не убирается, даже если он самый давний', () => {
  const list = tabs(16, (i) => i + 1);
  const ids = capTabs(list, 's0').map((t) => t.sessionId);
  assert.ok(ids.includes('s0'));
  assert.ok(!ids.includes('s1'));
});

test('вкладки без отметки (старые) уходят первыми, по порядку слева; избыток срезается целиком', () => {
  const list = tabs(20, (i) => (i < 8 ? undefined : i));
  const ids = capTabs(list, null).map((t) => t.sessionId);
  assert.equal(ids.length, MAX_OPEN_TABS);
  assert.deepEqual(ids.slice(0, 3), ['s5', 's6', 's7']);
});

// reconcileRemoteTabs — слияние пришедшего с сервера списка с местным:
// пропавшее без метки закрытия возвращается (устаревшая запись), с меткой —
// уходит (настоящее закрытие на другом устройстве).

test('пропавший из пришедшего списка открытый чат без метки закрытия остаётся — страница никуда не уводит', () => {
  const previous = [{ sessionId: 'a' }, { sessionId: 'me' }, { sessionId: 'b' }];
  const remote = [{ sessionId: 'a' }, { sessionId: 'b' }]; // устаревший снимок без активного чата
  const { tabs: merged, activeDropped } = reconcileRemoteTabs(previous, remote, new Set(), 'me');
  assert.equal(activeDropped, false);
  assert.deepEqual(merged.map((t) => t.sessionId), ['a', 'me', 'b']);
});

test('открытый чат с меткой закрытия уходит — это закрыли на другом устройстве', () => {
  const previous = [{ sessionId: 'a' }, { sessionId: 'me' }, { sessionId: 'b' }];
  const remote = [{ sessionId: 'a' }, { sessionId: 'b' }];
  const { tabs: merged, activeDropped } = reconcileRemoteTabs(previous, remote, new Set(['me']), 'me');
  assert.equal(activeDropped, true);
  assert.deepEqual(merged.map((t) => t.sessionId), ['a', 'b']);
});

test('фоновые вкладки без метки тоже возвращаются, а помеченные закрытыми уходят', () => {
  const previous = [{ sessionId: 'keep' }, { sessionId: 'gone' }, { sessionId: 'closed' }];
  const remote = [{ sessionId: 'keep' }];
  const { tabs: merged } = reconcileRemoteTabs(previous, remote, new Set(['closed']), 'keep');
  assert.deepEqual(merged.map((t) => t.sessionId), ['keep', 'gone']);
});

test('объединение сверх 15 срезается пределом, открытый чат держится', () => {
  const previous = tabs(15, (i) => i + 1);
  const remote = tabs(15, (i) => i + 100).map((t) => ({ ...t, sessionId: `r${t.sessionId}` }));
  // Местный активный s14 нет в пришедшем списке и не помечен — возвращается, 16 → 15.
  const { tabs: merged, activeDropped } = reconcileRemoteTabs(previous, remote, new Set(), 's14');
  assert.equal(activeDropped, false);
  assert.equal(merged.length, MAX_OPEN_TABS);
  assert.ok(merged.some((t) => t.sessionId === 's14'));
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_OPEN_TABS, capTabs } from './openTabsLimit';

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

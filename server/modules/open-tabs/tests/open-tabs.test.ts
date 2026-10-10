import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { normalizeOpenTabs, openTabsDb } from '@/modules/database/repositories/open-tabs.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'open-tabs-'));
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

const userId = (username: string): number => Number(
  getConnection().prepare("INSERT INTO users (username, password_hash) VALUES (?, 'x')").run(username).lastInsertRowid,
);

test('вкладки у каждого пользователя свои, версия растёт только при изменении', async () => {
  await withIsolatedDatabase(() => {
    const egor = userId('egor');
    const other = userId('other');
    assert.deepEqual(openTabsDb.get(egor), { version: 0, tabs: [], updatedAt: null, closed: {} });

    const first = openTabsDb.put(egor, [{ sessionId: 'a', title: 'А' }, { sessionId: 'b' }]);
    assert.equal(first.version, 1);
    assert.equal(openTabsDb.put(egor, [{ sessionId: 'a', title: 'А' }, { sessionId: 'b' }]).version, 1);

    const reordered = openTabsDb.put(egor, [{ sessionId: 'b' }, { sessionId: 'a', title: 'А' }]);
    assert.equal(reordered.version, 2);
    assert.deepEqual(reordered.tabs.map((t) => t.sessionId), ['b', 'a']);
    assert.deepEqual(openTabsDb.get(other).tabs, []);
  });
});

test('первая отправка устройства дописывает, а не затирает', async () => {
  await withIsolatedDatabase(() => {
    const egor = userId('egor');
    openTabsDb.put(egor, [{ sessionId: 'pc-1' }, { sessionId: 'common' }], true);
    const phone = openTabsDb.put(egor, [{ sessionId: 'phone-1' }, { sessionId: 'common' }], true);
    assert.deepEqual(phone.tabs.map((t) => t.sessionId), ['pc-1', 'common', 'phone-1']);
    assert.deepEqual(openTabsDb.put(egor, [{ sessionId: 'common' }]).tabs.map((t) => t.sessionId), ['common']);
  });
});

test('список чистится: повторы, пустые, лишние поля', () => {
  assert.deepEqual(
    normalizeOpenTabs([{ sessionId: 'a', junk: 1 }, { sessionId: 'a' }, { sessionId: '' }, null, { sessionId: 'b', provider: 'claude' }]),
    [{ sessionId: 'a' }, { sessionId: 'b', provider: 'claude' }],
  );
  assert.deepEqual(normalizeOpenTabs('nope'), []);
});

test('время открытия вкладки хранится — по нему страница убирает самую давнюю сверх 15', () => {
  assert.deepEqual(
    normalizeOpenTabs([{ sessionId: 'a', openedAt: 1758800000000.4 }, { sessionId: 'b', openedAt: 'вчера' }, { sessionId: 'c', openedAt: -1 }]),
    [{ sessionId: 'a', openedAt: 1758800000000 }, { sessionId: 'b' }, { sessionId: 'c' }],
  );
});

test('отправка со списком remove объединяет, а не затирает — устаревший снимок не роняет чужие вкладки', async () => {
  await withIsolatedDatabase(() => {
    const egor = userId('egor');
    // Компьютер открыл новый чат: сервер знает [phone-1, pc-new].
    openTabsDb.put(egor, [{ sessionId: 'phone-1' }, { sessionId: 'pc-new' }]);
    // Телефон шлёт УСТАРЕВШИЙ список без pc-new, но с remove — это объединение:
    // pc-new остаётся, а не пропадает (раньше полная замена его роняла).
    const merged = openTabsDb.put(egor, [{ sessionId: 'phone-1' }], false, []);
    assert.deepEqual(merged.tabs.map((t) => t.sessionId), ['phone-1', 'pc-new']);
    assert.deepEqual(merged.closed, {});
  });
});

test('явно закрытая вкладка помечается в closed, возвращённая — снимает метку', async () => {
  await withIsolatedDatabase(() => {
    const egor = userId('egor');
    openTabsDb.put(egor, [{ sessionId: 'a' }, { sessionId: 'b' }]);
    // Устройство закрыло 'b' крестиком: id уходит в remove — сервер ставит метку.
    const closed = openTabsDb.put(egor, [{ sessionId: 'a' }], false, ['b']);
    assert.deepEqual(closed.tabs.map((t) => t.sessionId), ['a']);
    assert.ok(closed.closed.b > 0);
    assert.equal(closed.closed.a, undefined);
    // Чат открыли снова на любом устройстве — метка закрытия снимается.
    const reopened = openTabsDb.put(egor, [{ sessionId: 'a' }, { sessionId: 'b' }], false, []);
    assert.deepEqual(reopened.closed, {});
  });
});

test('старая отправка без remove по-прежнему заменяет список и меток не ставит', async () => {
  await withIsolatedDatabase(() => {
    const egor = userId('egor');
    openTabsDb.put(egor, [{ sessionId: 'a' }, { sessionId: 'b' }], false, ['x']);
    const replaced = openTabsDb.put(egor, [{ sessionId: 'c' }]);
    // Совместимость со старыми клиентами: без remove — полная замена,
    // и пропавшие id метками закрытия не считаются.
    assert.deepEqual(replaced.tabs.map((t) => t.sessionId), ['c']);
    assert.equal(replaced.closed.b, undefined);
    assert.ok(replaced.closed.x > 0);
  });
});

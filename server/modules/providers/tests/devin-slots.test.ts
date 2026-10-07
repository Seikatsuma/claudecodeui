import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Каталоги слота считаются при импорте от HOME — подменяем его до импорта.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-slots-'));
const realHome = process.env.HOME;
const realXdg = process.env.XDG_DATA_HOME;
process.env.HOME = fakeHome;
delete process.env.XDG_DATA_HOME;

const slots = await import('@/shared/devin-slots.js');
const login = await import('@/modules/providers/services/devin-login.service.js');

test.after(() => {
  process.env.HOME = realHome;
  if (realXdg !== undefined) process.env.XDG_DATA_HOME = realXdg;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('активный слот: по умолчанию 1, после выбора 2 — запоминается файлом', () => {
  assert.equal(slots.getActiveDevinSlot(), 1);
  slots.setActiveDevinSlot(2);
  assert.equal(slots.getActiveDevinSlot(), 2);
  slots.setActiveDevinSlot(1);
  assert.equal(slots.getActiveDevinSlot(), 1);
});

test('окружение слота: слот 1 без подмены, слот 2 — отдельный XDG_DATA_HOME', () => {
  assert.deepEqual(slots.getDevinSlotEnv(1), {});
  assert.equal(slots.getDevinSlotEnv(2).XDG_DATA_HOME, slots.DEVIN_SLOT2_DATA_HOME);
  assert.ok(slots.DEVIN_SLOT2_DATA_HOME.startsWith(fakeHome));
});

test('профиль слота 2: cli и mcp — ссылки на каталоги слота 1, существующее не трогаем', () => {
  const main = path.join(fakeHome, '.local', 'share', 'devin');
  fs.mkdirSync(path.join(main, 'cli'), { recursive: true });
  fs.mkdirSync(path.join(main, 'mcp'), { recursive: true });

  const first = slots.ensureDevinSlot2Profile();
  assert.deepEqual(first.skipped, []);
  const cliLink = path.join(slots.DEVIN_SLOT2_DATA_HOME, 'devin', 'cli');
  assert.equal(fs.lstatSync(cliLink).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(cliLink), fs.realpathSync(path.join(main, 'cli')));

  // Повторный вызов ничего не ломает.
  assert.deepEqual(slots.ensureDevinSlot2Profile().skipped, []);

  // Настоящий каталог на месте ссылки — пропускаем и сообщаем, не удаляем.
  fs.unlinkSync(cliLink);
  fs.mkdirSync(cliLink);
  fs.writeFileSync(path.join(cliLink, 'keep.txt'), 'x');
  assert.deepEqual(slots.ensureDevinSlot2Profile().skipped, ['cli']);
  assert.equal(fs.existsSync(path.join(cliLink, 'keep.txt')), true);
});

test('код входа: мусор и пустое отклоняются до отправки Devin; без запущенного входа — «ссылка устарела»', async () => {
  const garbage = await login.submitDevinLoginCode('не код; rm -rf');
  assert.equal(garbage.ok, false);
  assert.match(garbage.message, /Код выглядит неправильно/);

  const noSession = await login.submitDevinLoginCode('AbCdEfGh12345678-_');
  assert.equal(noSession.ok, false);
  assert.match(noSession.message, /Ссылка устарела/);
});

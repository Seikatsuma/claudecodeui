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

test('окружение слота: слот 1 без подмены, слот 2 — отдельные XDG_DATA_HOME и XDG_CONFIG_HOME', () => {
  assert.deepEqual(slots.getDevinSlotEnv(1), {});
  const env2 = slots.getDevinSlotEnv(2);
  assert.equal(env2.XDG_DATA_HOME, slots.DEVIN_SLOT2_DATA_HOME);
  assert.ok(env2.XDG_CONFIG_HOME?.startsWith(fakeHome));
  assert.ok(slots.DEVIN_SLOT2_DATA_HOME.startsWith(fakeHome));
});

test('конфиг слота 2: настройки и хуки общие, org_id основного аккаунта не копируется, свой сохраняется', () => {
  const mainDir = path.join(fakeHome, '.config', 'devin');
  fs.mkdirSync(path.join(mainDir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(mainDir, 'AGENTS.md'), 'правила');
  const mainFile = path.join(mainDir, 'config.json');
  fs.writeFileSync(mainFile, JSON.stringify({ version: 1, devin: { org_id: 'org-main' }, hooks: { a: 1 }, theme_mode: 'dark' }));

  slots.getDevinSlotEnv(2);
  const slotFile = path.join(fakeHome, '.devin-account2', 'config', 'devin', 'config.json');
  const first = JSON.parse(fs.readFileSync(slotFile, 'utf8'));
  assert.equal(first.devin.org_id, undefined);
  assert.deepEqual(first.hooks, { a: 1 });
  assert.equal(first.theme_mode, 'dark');
  assert.equal(fs.lstatSync(path.join(path.dirname(slotFile), 'hooks')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(path.dirname(slotFile), 'AGENTS.md')).isSymbolicLink(), true);

  // Остальное из ~/.config (gh и др.) видно из слота 2 ссылками — иначе программы Devin теряют настройки.
  fs.mkdirSync(path.join(fakeHome, '.config', 'gh'), { recursive: true });
  slots.getDevinSlotEnv(2);
  const ghLink = path.join(fakeHome, '.devin-account2', 'config', 'gh');
  assert.equal(fs.lstatSync(ghLink).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(ghLink), fs.realpathSync(path.join(fakeHome, '.config', 'gh')));

  // Вход второго аккаунта записал свою организацию; общий конфиг поменялся — своя остаётся, новое подтягивается.
  first.devin.org_id = 'org-second';
  fs.writeFileSync(slotFile, JSON.stringify(first));
  fs.writeFileSync(mainFile, JSON.stringify({ version: 1, devin: { org_id: 'org-main' }, hooks: { a: 2 }, theme_mode: 'dark' }));
  slots.getDevinSlotEnv(2);
  const second = JSON.parse(fs.readFileSync(slotFile, 'utf8'));
  assert.equal(second.devin.org_id, 'org-second');
  assert.deepEqual(second.hooks, { a: 2 });
  // Общий конфиг основного аккаунта не тронут.
  assert.equal(JSON.parse(fs.readFileSync(mainFile, 'utf8')).devin.org_id, 'org-main');
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

#!/usr/bin/env node
// Проба собранной программы на той машине, где собирали (Mac/Windows в GitHub):
// запуск → вход пробным аккаунтом → «Этот компьютер» → снимки широкого и узкого
// окна; отдельно — что вложенный Claude запускается (--version).
// Снимки и журнал — в SMOKE_OUT (по умолчанию ./smoke).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const out = path.resolve(process.env.SMOKE_OUT || 'smoke');
fs.mkdirSync(out, { recursive: true });
const log = (line) => {
  console.log(line);
  fs.appendFileSync(path.join(out, 'smoke.log'), `${line}\n`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findApp() {
  const root = path.resolve('release', 'claudeui');
  const candidates = process.platform === 'darwin'
    ? ['mac-arm64', 'mac', 'mac-universal'].map((dir) => path.join(root, dir, 'Claude UI.app', 'Contents', 'MacOS', 'Claude UI'))
    : process.platform === 'win32'
      ? [path.join(root, 'win-unpacked', 'Claude UI.exe')]
      : [path.join(root, 'linux-unpacked', 'claude-ui'), path.join(root, 'linux-unpacked', '@cloudcliai-cloudcli')];
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) throw new Error(`программа не найдена: ${candidates.join(', ')}`);
  return found;
}

const executable = findApp();
log(`программа: ${executable}`);
const appRoot = process.platform === 'darwin'
  ? path.join(path.dirname(executable), '..', 'Resources', 'app')
  : path.join(path.dirname(executable), 'resources', 'app');

// 1. Вложенный Claude запускается на этой системе.
const claudeBin = path.join(appRoot, 'node_modules', '@anthropic-ai',
  `claude-agent-sdk-${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
  process.platform === 'win32' ? 'claude.exe' : 'claude');
try {
  log(`Claude внутри: ${execFileSync(claudeBin, ['--version'], { encoding: 'utf8', timeout: 60000 }).trim()}`);
} catch (error) {
  log(`ОШИБКА Claude внутри: ${error.message}`);
  process.exitCode = 1;
}

// 2. Программа: чистый пользователь, настоящий сервер аккаунтов.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-smoke-'));
const env = { ...process.env, HOME: home, USERPROFILE: home };
const app = await electron.launch({ executablePath: executable, args: [], env, timeout: 90000 });
app.process().stdout?.on('data', (chunk) => fs.appendFileSync(path.join(out, 'app.log'), chunk));
app.process().stderr?.on('data', (chunk) => fs.appendFileSync(path.join(out, 'app.log'), chunk));

const setSize = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => {
  const win = BrowserWindow.getAllWindows().find((item) => item.isVisible()) || BrowserWindow.getAllWindows()[0];
  win.setSize(w, h);
  win.center();
}, [width, height]);

// Снимок всего окна: верхняя полоса программы + вкладка интерфейса.
const snap = async (name) => {
  const data = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((item) => item.isVisible()) || BrowserWindow.getAllWindows()[0];
    const [w, h] = win.getContentSize();
    const base = await win.webContents.capturePage();
    const view = win.getBrowserViews()[0];
    if (!view) return { base: base.toPNG().toString('base64') };
    const bounds = view.getBounds();
    const top = await view.webContents.capturePage();
    return { base: base.toPNG().toString('base64'), top: top.toPNG().toString('base64'), bounds, w, h };
  });
  fs.writeFileSync(path.join(out, `${name}-top.png`), Buffer.from(data.base, 'base64'));
  if (data.top) fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(data.top, 'base64'));
  log(`снимок ${name}`);
};

const main = await app.firstWindow();
await sleep(3000);
await setSize(1280, 820);
await sleep(1000);
await snap('01-вход');

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;
if (email && password && await main.locator('#auth-email').count()) {
  await main.fill('#auth-email', email);
  await main.fill('#auth-password', password);
  await main.click('.auth-go');
  log('вход отправлен');
  let local = null;
  for (let i = 0; i < 120 && !local; i += 1) {
    await sleep(1000);
    local = app.windows().find((page) => /^http:\/\/(localhost|127\.0\.0\.1):\d+/.test(page.url()));
  }
  if (!local) {
    log('ОШИБКА: интерфейс этого компьютера не открылся за 2 минуты');
    process.exitCode = 1;
  } else {
    log(`интерфейс этого компьютера: ${local.url()}`);
    await sleep(8000);
    await snap('02-этот-компьютер-1280');
    await setSize(900, 780);
    await sleep(2500);
    await snap('03-узкое-900');
    const title = await local.title().catch(() => '');
    log(`заголовок страницы: ${title}`);
  }
} else {
  log('вход пропущен: нет SMOKE_EMAIL/SMOKE_PASSWORD');
}

await app.close().catch(() => {});
log('проба закончена');

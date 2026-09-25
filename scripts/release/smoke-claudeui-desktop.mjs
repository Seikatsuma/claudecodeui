#!/usr/bin/env node
// Проба собранной программы на той машине, где собирали (Mac/Windows в GitHub) —
// так, как её запустит человек, без отладчика:
//   1) вложенный Claude запускается (--version);
//   2) вход пробным аккаунтом (SMOKE_EMAIL/SMOKE_PASSWORD) через сервер аккаунтов,
//      ключ устройства кладётся туда, где его хранит программа;
//   3) программа запускается обычным двойным щелчком (без флагов), сама открывает
//      «Этот компьютер»; ждём по её файлу состояния, проверяем сервер интерфейса;
//   4) снимок всего экрана средствами системы.
// Итог — в SMOKE_OUT (по умолчанию ./smoke).
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = path.resolve(process.env.SMOKE_OUT || 'smoke');
fs.mkdirSync(out, { recursive: true });
const log = (line) => {
  console.log(line);
  fs.appendFileSync(path.join(out, 'smoke.log'), `${line}\n`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ACCOUNT_URL = (process.env.CLAUDE_UI_ACCOUNT_URL || 'https://cc2.sobsila.ru/desktop').replace(/\/+$/, '');
let failed = false;
const fail = (line) => {
  failed = true;
  log(`ОШИБКА: ${line}`);
};

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

function userDataDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude UI');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude UI');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Claude UI');
}

function screenshot(name) {
  const file = path.join(out, `${name}.png`);
  try {
    if (process.platform === 'darwin') {
      execFileSync('screencapture', ['-x', file], { timeout: 30000 });
    } else if (process.platform === 'win32') {
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
        '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;',
        '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;',
        '$g=[System.Drawing.Graphics]::FromImage($bmp);',
        '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);',
        `$bmp.Save('${file.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`,
      ].join(' ');
      execFileSync('powershell', ['-NoProfile', '-Command', ps], { timeout: 30000 });
    } else {
      return;
    }
    log(`снимок ${name}`);
  } catch (error) {
    log(`снимок ${name} не вышел: ${error.message}`);
  }
}

const executable = findApp();
log(`программа: ${executable}`);
const appRoot = process.platform === 'darwin'
  ? path.join(path.dirname(executable), '..', 'Resources', 'app')
  : path.join(path.dirname(executable), 'resources', 'app');

// 1. Вложенный Claude.
const claudeBin = path.join(appRoot, 'node_modules', '@anthropic-ai',
  `claude-agent-sdk-${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
  process.platform === 'win32' ? 'claude.exe' : 'claude');
try {
  log(`Claude внутри: ${execFileSync(claudeBin, ['--version'], { encoding: 'utf8', timeout: 60000 }).trim()}`);
} catch (error) {
  fail(`вложенный Claude не запустился: ${error.message}`);
}

// 2. Вход пробным аккаунтом → ключ устройства в хранилище программы.
const statusFile = path.join(out, 'status.json');
if (process.env.SMOKE_EMAIL && process.env.SMOKE_PASSWORD) {
  const response = await fetch(`${ACCOUNT_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.SMOKE_EMAIL, password: process.env.SMOKE_PASSWORD, device: `проба сборки ${process.platform}` }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.api_key) {
    fail(`вход пробным аккаунтом: ${response.status} ${body.error || ''}`);
  } else {
    const dir = userDataDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cloud-account.json'), JSON.stringify({
      deviceId: crypto.randomUUID(),
      email: body.account.email,
      name: body.account.name,
      plan: body.account.plan,
      planLabel: body.account.plan_label,
      apiKey: { encrypted: false, value: body.api_key },
    }, null, 2));
    log(`вход: ${body.account.email} (${body.account.plan_label}), хранилище: ${dir}`);
  }
} else {
  log('вход пропущен: нет SMOKE_EMAIL/SMOKE_PASSWORD — будет экран входа');
}

// 3. Обычный запуск.
const appLog = fs.openSync(path.join(out, 'app.log'), 'a');
const child = spawn(executable, [], {
  env: { ...process.env, CLAUDE_UI_STATUS_FILE: statusFile, CLAUDE_UI_ACCOUNT_URL: ACCOUNT_URL },
  stdio: ['ignore', appLog, appLog],
  detached: false,
});
child.on('exit', (code) => log(`программа завершилась, код ${code}`));
log(`запущена, процесс ${child.pid}`);

let status = null;
for (let i = 0; i < 150; i += 1) {
  await sleep(1000);
  try {
    status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  } catch {
    status = null;
  }
  if (status?.activeTarget?.kind === 'local' && status.localWebUrl) break;
  if (child.exitCode !== null) break;
}
log(`состояние: ${JSON.stringify(status)}`);
screenshot('01-после-запуска');

if (status?.localWebUrl) {
  const health = await fetch(`${status.localWebUrl}/health`).then((r) => r.json()).catch((e) => ({ error: e.message }));
  log(`сервер этого компьютера: ${JSON.stringify(health).slice(0, 200)}`);
  await sleep(10000);
  screenshot('02-этот-компьютер');
} else if (process.env.SMOKE_EMAIL) {
  fail('«Этот компьютер» не открылся за 150 секунд');
}
if (status?.lastError) fail(`программа показала ошибку: ${status.lastError}`);

try {
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  } else {
    child.kill('SIGTERM');
  }
} catch {
  // уже завершилась
}
await sleep(3000);
log(failed ? 'проба: есть ошибки' : 'проба: всё открылось');
process.exit(failed ? 1 : 0);

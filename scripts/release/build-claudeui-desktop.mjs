#!/usr/bin/env node
// Сборка Claude UI для компьютера: одна программа, внутри — интерфейс, его
// сервер со всеми пакетами (нативные пересобраны под Electron), вложенный
// Claude под эту систему и мозги. Ничего не скачивается при первом запуске.
//
//   npm run build                                   # интерфейс и сервер
//   node scripts/release/build-claudeui-desktop.mjs --mac   # на Mac: .dmg и .zip
//   node scripts/release/build-claudeui-desktop.mjs --win   # на Windows: установщик .exe
//   node scripts/release/build-claudeui-desktop.mjs --linux --dir   # проба без упаковки
//
// Собирать на той системе, для которой программа (нативные пакеты и Claude
// берутся под текущую систему и процессор). Итог — release/claudeui/.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const stageDir = path.join(rootDir, '.desktop-build', 'claudeui');
const outputDir = path.join(rootDir, 'release', 'claudeui');
const args = new Set(process.argv.slice(2));
const target = args.has('--mac') ? 'mac' : args.has('--win') ? 'win' : 'linux';
const dirOnly = args.has('--dir');

const rootPackage = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const desktopVersion = JSON.parse(readFileSync(path.join(rootDir, 'desktop', 'version.json'), 'utf8')).version;
const electronVersion = JSON.parse(readFileSync(path.join(rootDir, 'node_modules', 'electron', 'package.json'), 'utf8')).version;

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`$ ${command} ${commandArgs.join(' ')}`);
    const child = spawn(command, commandArgs, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...options,
    });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} завершился с кодом ${code}`))));
  });
}

async function copy(relativePath) {
  await fs.cp(path.join(rootDir, relativePath), path.join(stageDir, relativePath), { recursive: true });
}

const bin = (name) => path.join(rootDir, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);

await fs.rm(stageDir, { recursive: true, force: true });
await fs.mkdir(stageDir, { recursive: true });
for (const item of ['electron', 'dist', 'dist-server', 'public', 'shared', 'desktop', 'package-lock.json']) {
  await copy(item);
}
await fs.mkdir(path.join(stageDir, 'scripts'), { recursive: true });
await copy('scripts/fix-node-pty.js');

// Тот же набор пакетов, что у сервера (иначе npm ci откажется), но своё имя
// программы, версия и настройки упаковки. Скрипты разработки не нужны.
const stagePackage = {
  ...rootPackage,
  version: desktopVersion,
  main: 'electron/main.js',
  productName: 'Claude UI',
  description: 'Claude UI для компьютера',
  scripts: {},
  build: {
    appId: 'ru.sobsila.claudeui',
    productName: 'Claude UI',
    electronVersion,
    asar: false,
    npmRebuild: false,
    directories: { output: outputDir },
    artifactName: 'Claude-UI-${version}-${os}-${arch}.${ext}',
    files: ['**/*', '!**/*.map', '!**/{test,tests,__tests__}/**', '!.desktop-build/**'],
    protocols: [{ name: 'Claude UI', schemes: ['claudeui'] }],
    mac: {
      category: 'public.app-category.productivity',
      icon: 'electron/assets/logo-macos.icns',
      target: ['dmg', 'zip'],
      // Подпись «для себя» (ad-hoc): без неё Mac на M-процессоре не запустит
      // программу вовсе. Настоящая подпись Apple — платная, см. agent.md.
      identity: '-',
      hardenedRuntime: false,
      gatekeeperAssess: false,
      notarize: false,
    },
    dmg: { title: 'Claude UI' },
    win: {
      icon: 'electron/assets/logo-windows.ico',
      target: ['nsis'],
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      installerIcon: 'electron/assets/logo-windows.ico',
      uninstallerIcon: 'electron/assets/logo-windows.ico',
      shortcutName: 'Claude UI',
    },
    linux: { target: ['dir'], icon: 'public/logo-512.png', category: 'Utility' },
  },
};
delete stagePackage.bin;
delete stagePackage.files;
await fs.writeFile(path.join(stageDir, 'package.json'), `${JSON.stringify(stagePackage, null, 2)}\n`, 'utf8');

// Только пакеты для работы (без разработки), с установочными скриптами:
// нативным модулям они нужны до пересборки под Electron.
await run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stageDir });

console.log(`Пересборка нативных модулей под Electron ${electronVersion} (${process.arch})…`);
await run(bin('electron-rebuild'), ['--version', electronVersion, '--module-dir', stageDir, '--arch', process.arch, '--force',
  '--only', 'better-sqlite3,node-pty,bcrypt'], { cwd: rootDir });
await run(process.execPath, ['scripts/fix-node-pty.js'], { cwd: stageDir });

// Claude под эту систему должен лежать внутри — без него программа не думает.
const claudeDir = path.join(stageDir, 'node_modules', '@anthropic-ai',
  `claude-agent-sdk-${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`);
await fs.access(claudeDir).catch(() => {
  throw new Error(`Нет вложенного Claude: ${claudeDir}`);
});

const builderArgs = ['--projectDir', stageDir, `--${target}`, '--publish', 'never'];
if (dirOnly) builderArgs.push('--dir');
await run(bin('electron-builder'), builderArgs, {
  cwd: rootDir,
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});
console.log(`Готово: ${outputDir}`);

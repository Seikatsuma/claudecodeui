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
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const stageDir = path.join(rootDir, '.desktop-build', 'claudeui');
const outputDir = path.join(rootDir, 'release', 'claudeui');
const args = new Set(process.argv.slice(2));
const target = args.has('--mac') ? 'mac' : args.has('--win') ? 'win' : 'linux';
const dirOnly = args.has('--dir');

const rootPackage = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
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
for (const item of ['electron', 'dist', 'dist-server', 'public', 'shared', 'desktop/brains', 'package-lock.json']) {
  await copy(item);
}

// Программа уходит людям, а код сервера, обёртки и страницы лежит внутри
// читаемым текстом: комментарии разработки (с цитатами и именами) вырезаем.
// Сжимаются только пробелы — имена в коде те же, поведение то же.
const esbuild = await import(pathToFileURL(path.join(rootDir, 'node_modules', 'esbuild', 'lib', 'main.js')).href);
async function stripComments(dir) {
  let count = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath || entry.path, entry.name);
    const loader = /\.(?:m|c)?js$/.test(entry.name) ? 'js' : /\.css$/.test(entry.name) ? 'css' : null;
    if (loader) {
      const code = await fs.readFile(file, 'utf8');
      const { code: stripped } = await esbuild.transform(code, { loader, minifyWhitespace: true, legalComments: 'none', charset: 'utf8' });
      await fs.writeFile(file, stripped, 'utf8');
      count += 1;
    } else if (/\.(?:html|svg|xml)$/.test(entry.name)) {
      const html = await fs.readFile(file, 'utf8');
      await fs.writeFile(file, html.replace(/<!--[\s\S]*?-->/g, ''), 'utf8');
      count += 1;
    }
  }
  return count;
}
// Тесты сервера людям не нужны.
for (const entry of await fs.readdir(path.join(stageDir, 'dist-server'), { withFileTypes: true, recursive: true })) {
  if (entry.isDirectory() && entry.name === 'tests') {
    await fs.rm(path.join(entry.parentPath || entry.path, entry.name), { recursive: true, force: true });
  }
}
for (const dir of ['dist-server', 'shared', 'electron', 'dist', 'public']) {
  console.log(`комментарии убраны: ${dir} — ${await stripComments(path.join(stageDir, dir))} файлов`);
}
// Правила сайта владельца, которым не место в программе для всех.
const STAGE_PATCHES = [
  ['dist-server/server/modules/user/thought-translation.js', /имя Egor пиши «Егор»\.\s*/g, ''],
];
for (const [rel, pattern, replacement] of STAGE_PATCHES) {
  const file = path.join(stageDir, rel);
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (text !== null) await fs.writeFile(file, text.replace(pattern, replacement), 'utf8');
}

// Страж: личное и служебное не должно уехать людям. Адрес сервера аккаунтов
// (sobsila.ru) — законная часть программы, остальное — остановка сборки.
const PERSONAL = /Егор|Вячеслав|Славы|Славой|Софь|egor\.ea07|server-my|woezix|artraid_pull|clwduser1/;
const leaks = [];
for (const dir of ['dist-server', 'shared', 'electron', 'desktop', 'dist', 'public']) {
  for (const entry of await fs.readdir(path.join(stageDir, dir), { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.(?:m|c)?js$|\.json$|\.md$|\.html$|\.svg$|\.xml$|\.txt$|\.css$/.test(entry.name)) continue;
    const file = path.join(entry.parentPath || entry.path, entry.name);
    const lines = (await fs.readFile(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (PERSONAL.test(line)) leaks.push(`${path.relative(stageDir, file)}:${index + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
}
if (leaks.length) {
  console.error(`Личное в программе (${leaks.length}):\n${leaks.slice(0, 40).join('\n')}`);
  throw new Error('в программе осталось личное — сборка остановлена');
}
if (process.env.CLAUDEUI_STAGE_ONLY === '1') {
  console.log('Подготовка проверена (CLAUDEUI_STAGE_ONLY), дальше не собираю.');
  process.exit(0);
}
await fs.mkdir(path.join(stageDir, 'scripts'), { recursive: true });
await copy('scripts/fix-node-pty.js');

// Тот же набор пакетов, что у сервера (иначе npm ci откажется), но своё имя
// программы, версия и настройки упаковки. Скрипты разработки не нужны.
// Версия программы = версия интерфейса: сервер и страница сверяют их между собой,
// и расхождение показывается плашкой «обновление установлено — перезапустите».
const stagePackage = {
  ...rootPackage,
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
      // Claude Code работает на macOS 13 и новее — ниже программа бесполезна.
      minimumSystemVersion: '13.0',
      // Здесь собирается одна половина (M или Intel) без упаковки и подписи:
      // половины склеивает в одну программу для любого Mac и подписывает
      // make-mac-universal.mjs (подпись «для себя», настоящая Apple — платная).
      target: ['dir'],
      identity: null,
      hardenedRuntime: false,
      gatekeeperAssess: false,
      notarize: false,
    },
    win: {
      icon: 'electron/assets/logo-windows.ico',
      // Один установщик для Windows 10 и 11 (x64; на ARM-ноутбуках Windows 11
      // запускает его своей эмуляцией).
      target: ['nsis'],
      artifactName: 'Claude-UI-${version}-windows.${ext}',
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

// Mac: в каждой половине Claude для обоих процессоров — тогда у половин
// одинаковый набор файлов и они склеиваются в одну программу для любого Mac.
if (process.platform === 'darwin') {
  const sdkVersion = JSON.parse(readFileSync(path.join(stageDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version;
  for (const arch of ['arm64', 'x64']) {
    const name = `claude-agent-sdk-darwin-${arch}`;
    const target = path.join(stageDir, 'node_modules', '@anthropic-ai', name);
    try {
      await fs.access(path.join(target, 'claude'));
      continue;
    } catch {
      // нет — докачиваем
    }
    const packDir = path.join(stageDir, '.pack');
    await fs.mkdir(packDir, { recursive: true });
    await run('npm', ['pack', `@anthropic-ai/${name}@${sdkVersion}`, '--pack-destination', packDir, '--silent'], { cwd: stageDir });
    await fs.mkdir(target, { recursive: true });
    await run('tar', ['-xzf', path.join(packDir, `anthropic-ai-${name}-${sdkVersion}.tgz`), '-C', target, '--strip-components=1']);
    await fs.chmod(path.join(target, 'claude'), 0o755);
    await fs.rm(packDir, { recursive: true, force: true });
  }
}
// Служебный список установленного у половин разный — людям он не нужен.
await fs.rm(path.join(stageDir, 'node_modules', '.package-lock.json'), { force: true });

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

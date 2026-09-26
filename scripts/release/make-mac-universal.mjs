#!/usr/bin/env node
// Одна программа для любого Mac (M и Intel), как у Claude Desktop:
// склеивает две половины, подписывает «для себя» и кладёт в .dmg
// с папкой «Программы» для перетаскивания.
//
//   node scripts/release/make-mac-universal.mjs <Claude UI.app для x64> <Claude UI.app для arm64> <папка итога> <версия>
//
// Только на Mac (нужны lipo, codesign, hdiutil).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeUniversalApp } from '@electron/universal';

const [x64AppPath, arm64AppPath, outDir, version] = process.argv.slice(2);
if (!x64AppPath || !arm64AppPath || !outDir || !version) {
  console.error('нужно: <x64.app> <arm64.app> <папка итога> <версия>');
  process.exit(64);
}

function run(command, args) {
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} завершился с кодом ${result.status}`);
}

await fs.mkdir(outDir, { recursive: true });
const staging = path.resolve(outDir, 'universal');
await fs.rm(staging, { recursive: true, force: true });
await fs.mkdir(staging, { recursive: true });
const outAppPath = path.join(staging, 'Claude UI.app');

// Пакеты с отдельными папками под каждый процессор (Claude, Codex, нативные
// модули в bin/darwin-<процессор>-…) в каждой половине есть только «свои».
// Дополняем половины друг другом, чтобы набор файлов совпал: такие файлы
// одинаковы в обеих и берутся как есть, а не склеиваются.
async function listFiles(root, rel = '') {
  const out = [];
  for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(root, child));
    else out.push(child);
  }
  return out;
}
const nodeModules = (app) => path.join(path.resolve(app), 'Contents', 'Resources', 'app', 'node_modules');
const x64Files = new Set(await listFiles(nodeModules(x64AppPath)));
const armFiles = new Set(await listFiles(nodeModules(arm64AppPath)));
let synced = 0;
for (const [from, to, fromSet, toSet] of [[x64AppPath, arm64AppPath, x64Files, armFiles], [arm64AppPath, x64AppPath, armFiles, x64Files]]) {
  for (const rel of fromSet) {
    if (toSet.has(rel)) continue;
    const target = path.join(nodeModules(to), rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(path.join(nodeModules(from), rel), target, { preserveTimestamps: true });
    synced += 1;
  }
}
console.log(`половины дополнены друг другом: ${synced} файлов`);

await makeUniversalApp({
  x64AppPath: path.resolve(x64AppPath),
  arm64AppPath: path.resolve(arm64AppPath),
  outAppPath,
  force: true,
  // Файлы под один процессор (лежат в обеих половинах одинаковыми) — как есть.
  x64ArchFiles: '**/*{darwin-x64,darwin-arm64,x86_64-apple-darwin,aarch64-apple-darwin}*/**',
});

// Подпись «для себя»: без неё Mac на M-процессоре не откроет программу.
run('codesign', ['--force', '--deep', '--sign', '-', outAppPath]);
run('codesign', ['--verify', '--deep', '--strict', outAppPath]);
run('lipo', ['-archs', path.join(outAppPath, 'Contents', 'MacOS', 'Claude UI')]);

// .dmg: программа + ярлык «Программы», чтобы перетащить.
await fs.symlink('/Applications', path.join(staging, 'Applications'));
const dmgPath = path.resolve(outDir, `Claude-UI-${version}-mac.dmg`);
await fs.rm(dmgPath, { force: true });
run('hdiutil', ['create', '-volname', 'Claude UI', '-srcfolder', staging, '-ov', '-format', 'UDZO', dmgPath]);
console.log(`Готово: ${dmgPath}`);

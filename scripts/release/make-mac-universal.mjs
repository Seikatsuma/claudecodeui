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

await makeUniversalApp({
  x64AppPath: path.resolve(x64AppPath),
  arm64AppPath: path.resolve(arm64AppPath),
  outAppPath,
  force: true,
  // Claude для каждого процессора лежит в обеих половинах своей папкой —
  // такие файлы берутся как есть, а не склеиваются.
  x64ArchFiles: '**/node_modules/@anthropic-ai/claude-agent-sdk-darwin-*/**',
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

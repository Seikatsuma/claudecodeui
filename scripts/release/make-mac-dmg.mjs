#!/usr/bin/env node
// Программа для Mac одного процессора (M или Intel): подпись «для себя» и .dmg
// с папкой «Программы» для перетаскивания. Отдельные файлы под процессор вдвое
// легче одного общего — человек не качает и не хранит вторую половину.
//
//   node scripts/release/make-mac-dmg.mjs <Claude UI.app> <папка итога> <версия> <M|Intel>
//
// Только на Mac (нужны lipo, codesign, hdiutil).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const [appPath, outDir, version, chip] = process.argv.slice(2);
if (!appPath || !outDir || !version || !['M', 'Intel'].includes(chip)) {
  console.error('нужно: <Claude UI.app> <папка итога> <версия> <M|Intel>');
  process.exit(64);
}

function run(command, args) {
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} завершился с кодом ${result.status}`);
}

await fs.mkdir(outDir, { recursive: true });
const staging = path.resolve(outDir, `dmg-${chip}`);
await fs.rm(staging, { recursive: true, force: true });
await fs.mkdir(staging, { recursive: true });
const outAppPath = path.join(staging, 'Claude UI.app');
run('ditto', [path.resolve(appPath), outAppPath]);

// Подпись «для себя»: без неё Mac на M-процессоре не откроет программу.
run('codesign', ['--force', '--deep', '--sign', '-', outAppPath]);
run('codesign', ['--verify', '--deep', '--strict', outAppPath]);
// Файл должен быть ровно под свой процессор: иначе человек скачает «версию для M»,
// а внутри окажется другая.
const archs = execFileSync('lipo', ['-archs', path.join(outAppPath, 'Contents', 'MacOS', 'Claude UI')], { encoding: 'utf8' }).trim();
const expected = chip === 'M' ? 'arm64' : 'x86_64';
console.log(`процессор программы: ${archs}`);
if (archs !== expected) throw new Error(`программа собрана под «${archs}», а файл — для ${chip} (${expected})`);
const claudeDir = path.join(outAppPath, 'Contents', 'Resources', 'app', 'node_modules', '@anthropic-ai',
  `claude-agent-sdk-darwin-${chip === 'M' ? 'arm64' : 'x64'}`);
await fs.access(path.join(claudeDir, 'claude')).catch(() => {
  throw new Error(`внутри нет Claude для ${chip}: ${claudeDir}`);
});
const otherClaude = path.join(path.dirname(claudeDir), `claude-agent-sdk-darwin-${chip === 'M' ? 'x64' : 'arm64'}`);
if (await fs.access(otherClaude).then(() => true, () => false)) {
  throw new Error(`внутри лишний Claude второго процессора: ${otherClaude}`);
}

// .dmg: программа + ярлык «Программы». Сжатие ULMO (LZMA, macOS 10.15+) —
// самое плотное из встроенных, как у установщика Windows.
await fs.symlink('/Applications', path.join(staging, 'Applications'));
const dmgPath = path.resolve(outDir, `Claude-UI-${version}-mac-${chip}.dmg`);
await fs.rm(dmgPath, { force: true });
run('hdiutil', ['create', '-volname', 'Claude UI', '-srcfolder', staging, '-ov', '-format', 'ULMO', dmgPath]);
console.log(`Готово: ${dmgPath}`);

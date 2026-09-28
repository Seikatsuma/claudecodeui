#!/usr/bin/env node
// Упаковывает «начинку» программы — интерфейс и сервер — для обновления без
// установщика (electron/appUpdate.js). Берёт уже подготовленную сборку
// (.desktop-build/claudeui после build-claudeui-desktop.mjs, можно с
// CLAUDEUI_STAGE_ONLY=1): там вырезаны комментарии и проверено, что нет личного.
//
//   CLAUDEUI_BUILD=<номер> node scripts/release/pack-claudeui-update.mjs [папка-итога]
//
// Итог: claudeui-update-<номер>.tar.gz и update.json (номер, отпечатки, что нового).
// Пакеты (node_modules) и оболочка окна (electron/) в начинку не входят.
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildInfo } from './claudeui-update-meta.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const stageDir = path.join(rootDir, '.desktop-build', 'claudeui');
const outDir = path.resolve(process.argv[2] || path.join(rootDir, 'release', 'claudeui-update'));
const PARTS = ['dist', 'dist-server', 'public', 'shared'];

const info = buildInfo(rootDir);
if (!info.build) {
  console.error('Нужен номер сборки: CLAUDEUI_BUILD=<номер>');
  process.exit(1);
}
for (const part of PARTS) {
  if (!existsSync(path.join(stageDir, part))) {
    console.error(`Нет ${part} в ${stageDir} — сначала build-claudeui-desktop.mjs (можно с CLAUDEUI_STAGE_ONLY=1)`);
    process.exit(1);
  }
}
const stagedInfo = JSON.parse(readFileSync(path.join(stageDir, 'update-build.json'), 'utf8'));
if (stagedInfo.build !== info.build || stagedInfo.depsHash !== info.depsHash) {
  console.error('Подготовленная сборка собрана с другим номером или пакетами — пересоберите её.');
  process.exit(1);
}

// package.json начинки: сервер берёт из него версию и тип модулей. Скрипты и
// списки пакетов не нужны — пакеты берутся из установки.
const rootPackage = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const updatePackage = { name: rootPackage.name, version: rootPackage.version, type: rootPackage.type };

const packDir = path.join(outDir, 'pack');
await fs.rm(packDir, { recursive: true, force: true });
await fs.mkdir(packDir, { recursive: true });
for (const part of PARTS) {
  await fs.cp(path.join(stageDir, part), path.join(packDir, part), { recursive: true });
}
await fs.writeFile(path.join(packDir, 'package.json'), `${JSON.stringify(updatePackage, null, 2)}\n`);
await fs.copyFile(path.join(stageDir, 'update-build.json'), path.join(packDir, 'update-build.json'));

const fileName = `claudeui-update-${info.build}.tar.gz`;
const archive = path.join(outDir, fileName);
const tar = spawnSync('tar', ['-czf', archive, '-C', packDir, '.'], { stdio: 'inherit' });
if (tar.status !== 0) process.exit(tar.status || 1);
await fs.rm(packDir, { recursive: true, force: true });

const sha256 = await new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  createReadStream(archive).on('data', (chunk) => hash.update(chunk)).on('error', reject)
    .on('end', () => resolve(hash.digest('hex')));
});
const { size } = await fs.stat(archive);

// «Что нового» — тема последней правки; служебные сообщения git не нужны. Слияния
// («Merge commit …» — так в программу вливается сайт) пропускаем: берём тему последней
// настоящей правки, она по-русски и о деле.
let notes = '';
try {
  notes = execFileSync('git', ['log', '-1', '--no-merges', '--format=%s'], { cwd: rootDir, encoding: 'utf8' })
    .trim().replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '').replace(/\s*\[skip ci\]\s*/i, '');
} catch {
  notes = '';
}

const manifest = {
  build: info.build,
  version: rootPackage.version,
  depsHash: info.depsHash,
  file: fileName,
  url: fileName,
  sha256,
  size,
  notes,
  published_at: new Date().toISOString(),
};
await fs.writeFile(path.join(outDir, 'update.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Начинка сборки ${info.build}: ${fileName}, ${(size / 1024 / 1024).toFixed(1)} МБ, sha256 ${sha256.slice(0, 12)}…`);

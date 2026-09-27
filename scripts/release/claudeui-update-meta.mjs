// Сведения о сборке для обновления программы без установщика (electron/appUpdate.js).
//
// build     — номер сборки (запуск сборки на GitHub, CLAUDEUI_BUILD). У установщика и у
//             начинки из одного запуска он общий, поэтому свежая установка не видит
//             «обновления» на саму себя. 0 — сборка на своей машине: обновления выключены.
// depsHash  — отпечаток набора пакетов (package-lock.json). Начинка ставится поверх
//             пакетов установки, поэтому обновление доступно, только если он совпал;
//             иначе программа предлагает скачать установщик.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function computeDepsHash(rootDir) {
  const lock = JSON.parse(readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'));
  const entries = Object.entries(lock.packages || {})
    .filter(([key]) => key.startsWith('node_modules/'))
    .map(([key, info]) => `${key}@${info?.version || ''}`)
    .sort();
  return crypto.createHash('sha256').update(entries.join('\n')).digest('hex');
}

export function buildInfo(rootDir) {
  const build = Number(process.env.CLAUDEUI_BUILD || 0);
  return {
    build: Number.isFinite(build) && build > 0 ? build : 0,
    depsHash: computeDepsHash(rootDir),
  };
}

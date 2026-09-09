import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARDS = path.join(HERE, '..', 'process-guards.ts');

/**
 * Проверяем поведением, а не чтением кода: запускаем настоящий процесс,
 * бросаем в нём ошибку и смотрим, выжил он или нет. Иначе легко написать
 * обработчик, который выглядит правильно, но не срабатывает.
 */
async function runWithError(snippet: string): Promise<{ code: number | null; output: string }> {
  const source = `
    import { installProcessGuards } from ${JSON.stringify(GUARDS)};
    installProcessGuards();
    ${snippet}
    // Держим процесс живым чуть дольше, чем срабатывает выход по ошибке.
    setTimeout(() => { console.log('ВЫЖИЛ'); process.exit(0); }, 400);
  `;

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', source],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

test('обрыв соединения не убивает процесс', async () => {
  const { code, output } = await runWithError(`
    setTimeout(() => {
      const error = new Error('write EPIPE');
      error.code = 'EPIPE';
      throw error;
    }, 50);
  `);

  assert.equal(code, 0, 'процесс должен доработать до конца, а не упасть');
  assert.match(output, /ВЫЖИЛ/, 'после обрыва работа продолжается');
});

test('настоящая ошибка приводит к перезапуску, а не к тихой работе дальше', async () => {
  const { code, output } = await runWithError(`
    setTimeout(() => { throw new Error('что-то сломалось по-настоящему'); }, 50);
  `);

  assert.equal(code, 1, 'выходим с ненулевым кодом, чтобы systemd поднял службу');
  assert.doesNotMatch(output, /ВЫЖИЛ/, 'продолжать работу в непонятном состоянии нельзя');
  assert.match(output, /что-то сломалось по-настоящему/, 'причина должна попасть в журнал');
});

test('отказ промиса не роняет процесс', async () => {
  const { code, output } = await runWithError(`
    setTimeout(() => { Promise.reject(new Error('брошенный запрос')); }, 50);
  `);

  assert.equal(code, 0);
  assert.match(output, /ВЫЖИЛ/);
  assert.match(output, /брошенный запрос/, 'причина всё равно пишется в журнал');
});

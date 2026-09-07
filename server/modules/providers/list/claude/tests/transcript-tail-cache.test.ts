import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { forgetTranscriptTail, readSessionLines } from '../transcript-tail-cache.js';

const SESSION = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';

function row(session: string, index: number): string {
  return JSON.stringify({ sessionId: session, n: index, text: `строка ${index}` });
}

async function makeFile(rows: string[]): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tail-cache-'));
  const file = path.join(dir, 'transcript.jsonl');
  await fsp.writeFile(file, rows.join('\n') + '\n', 'utf8');
  return file;
}

test('читает строки только своего сеанса', async () => {
  forgetTranscriptTail();
  const file = await makeFile([row(SESSION, 1), row(OTHER, 2), row(SESSION, 3)]);
  const result = await readSessionLines(file, SESSION, null);
  assert.equal(result.total, 2);
  assert.equal(result.complete, true);
  assert.deepEqual(result.lines.map((l) => JSON.parse(l).n), [1, 3]);
});

test('дочитывает только дописанное, не теряя и не удваивая строки', async () => {
  forgetTranscriptTail();
  const file = await makeFile([row(SESSION, 1), row(SESSION, 2)]);
  const first = await readSessionLines(file, SESSION, null);
  assert.equal(first.total, 2);

  await fsp.appendFile(file, row(SESSION, 3) + '\n', 'utf8');
  const second = await readSessionLines(file, SESSION, null);
  assert.equal(second.total, 3);
  assert.deepEqual(second.lines.map((l) => JSON.parse(l).n), [1, 2, 3]);
});

test('незавершённая последняя строка не засчитывается, пока её не дописали', async () => {
  forgetTranscriptTail();
  const file = await makeFile([row(SESSION, 1)]);
  // Обрывок без перевода строки — так выглядит файл, в который пишут прямо сейчас.
  const partial = row(SESSION, 2);
  await fsp.appendFile(file, partial.slice(0, 20), 'utf8');

  const during = await readSessionLines(file, SESSION, null);
  assert.equal(during.total, 1, 'обрывок не должен попадать в результат');

  await fsp.appendFile(file, partial.slice(20) + '\n', 'utf8');
  const after = await readSessionLines(file, SESSION, null);
  assert.equal(after.total, 2, 'дописанная строка должна появиться целиком');
  assert.deepEqual(after.lines.map((l) => JSON.parse(l).n), [1, 2]);
});

test('переписанный файл читается заново, а не дочитывается', async () => {
  forgetTranscriptTail();
  const file = await makeFile([row(SESSION, 1), row(SESSION, 2), row(SESSION, 3)]);
  await readSessionLines(file, SESSION, null);

  await fsp.writeFile(file, row(SESSION, 9) + '\n', 'utf8');
  const again = await readSessionLines(file, SESSION, null);
  assert.equal(again.total, 1);
  assert.deepEqual(again.lines.map((l) => JSON.parse(l).n), [9]);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  digestTranscriptFile,
  digestTranscriptLines,
  exportDialogFile,
  transcriptLineBoundary,
} from '@/modules/handoff/handoff-digest.js';
import { scrubSecrets, tailFingerprint, transcriptUnchangedUpTo, writeBrief } from '@/modules/handoff/handoff.service.js';

const SID = '11111111-2222-3333-4444-555555555555';
const line = (entry: Record<string, unknown>) => JSON.stringify({ sessionId: SID, timestamp: '2026-09-23T10:00:00Z', ...entry });

test('разбор берёт слова человека и ответы, отбрасывает служебное', () => {
  const digest = digestTranscriptLines([
    line({ type: 'user', message: { content: 'Сделай кнопку <system-reminder>правила хука</system-reminder>' } }),
    line({ type: 'user', message: { content: '<task-notification> фон закончил' } }),
    line({ type: 'user', isMeta: true, message: { content: 'служебное' } }),
    line({ type: 'assistant', message: { content: [
      { type: 'thinking', thinking: 'черновик мыслей' },
      { type: 'text', text: 'Готово, кнопка стоит.' },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/p/a.ts' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/p/a.ts' } },
      { type: 'tool_use', name: 'Read', input: { file_path: '/p/b.ts' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm run build', description: 'Собираю сайт' } },
    ] } }),
    line({ type: 'user', toolUseResult: {}, message: { content: [{ type: 'tool_result', is_error: true, content: 'build failed: heap' }] } }),
    line({ type: 'user', sessionId: 'другой-разговор', message: { content: 'чужое' } }),
  ], SID);

  assert.match(digest.text, /ЧЕЛОВЕК: Сделай кнопку$/m);
  assert.doesNotMatch(digest.text, /правила хука|фон закончил|служебное|черновик мыслей|чужое|b\.ts/);
  assert.match(digest.text, /АГЕНТ: Готово, кнопка стоит\./);
  assert.equal(digest.text.match(/правка файла \/p\/a\.ts/g)?.length, 1, 'одинаковые действия подряд — одной строкой');
  assert.match(digest.text, /команда: Собираю сайт/);
  assert.match(digest.text, /ошибка: build failed: heap/);
  assert.deepEqual(digest.changedFiles, ['/p/a.ts']);
  assert.equal(digest.humanMessages, 1);
});

test('после сжатия: до сводки — только слова человека, сводка и всё после — целиком', () => {
  const digest = digestTranscriptLines([
    line({ type: 'user', message: { content: 'ранняя просьба' } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ранний ответ' }] } }),
    line({ type: 'user', isCompactSummary: true, message: { content: 'СВОДКА: делали кнопку' } }),
    line({ type: 'user', message: { content: 'поздняя просьба' } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'поздний ответ' }] } }),
  ], SID);

  assert.equal(digest.hadCompaction, true);
  assert.match(digest.text, /ранняя просьба/);
  assert.doesNotMatch(digest.text, /ранний ответ/);
  assert.match(digest.text, /СВОДКА: делали кнопку/);
  assert.match(digest.text, /поздний ответ/);
});

test('короткая переписка — две половины одновременно, «куда идём» первой', async () => {
  const prompts: string[] = [];
  const brief = await writeBrief('ЧЕЛОВЕК: привет', '/acc', async (prompt) => {
    prompts.push(prompt);
    return prompt.includes('## Цель —') ? '## Цель\nx' : '## Что сделано\ny';
  });
  assert.equal(brief, '## Цель\nx\n\n## Что сделано\ny');
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) assert.match(prompt, /<transcript>\nЧЕЛОВЕК: привет\n<\/transcript>/);
  assert.match(prompts[0], /## Следующий шаг/);
  assert.doesNotMatch(prompts[0], /## Что сделано/);
  assert.match(prompts[1], /## Где искать/);
  assert.doesNotMatch(prompts[1], /## Где остановились/);
});

test('длинная переписка — части, затем сводка с последней частью целиком', async () => {
  const block = `\nЧЕЛОВЕК: ${'а'.repeat(59_990)}`;
  const digest = block.repeat(12); // ≈ 720 тыс. знаков
  const prompts: string[] = [];
  await writeBrief(digest, '/acc', async (prompt) => {
    prompts.push(prompt);
    return prompt.includes('<notes') ? 'итог' : `заметки ${prompts.length}`;
  });
  const maps = prompts.filter((prompt) => prompt.includes('Это часть'));
  const reduces = prompts.filter((prompt) => prompt.includes('<transcript part="last">'));
  assert.ok(maps.length >= 2, `частей ${maps.length}`);
  assert.equal(reduces.length, 2, 'сводка — двумя половинами');
  assert.deepEqual(prompts.slice(-2), reduces, 'сводка — последними вызовами');
  assert.match(reduces[0], /<notes part="1">/);
});

test('опись вырезается, ссылки входа и ключи скрываются, линии --- убираются', async () => {
  const brief = await writeBrief('ЧЕЛОВЕК: привет', '/acc', async () => [
    '<опись>\n- черновик описи\n</опись>',
    '---',
    '## Цель — чего добивается человек',
    'Сайт: https://cc.example.ru/enter/nMsKcj_ooYAWE4bhfdzm8A, ключ sk-ant-abcdefghijklmnopqrstuv',
    '---',
    '## Следующий шаг',
    'ждать',
  ].join('\n'));
  assert.doesNotMatch(brief, /опись|черновик|nMsKcj|abcdefghijkl|^---$/m);
  assert.match(brief, /^## Цель$/m, 'подсказка из задания в заголовке срезана');
  assert.match(brief, /enter\/\[скрыто\]/);
  assert.match(brief, /\[ключ скрыт\]/);
});

test('задача нового чата попадает в задание модели', async () => {
  let seen = '';
  await writeBrief('ЧЕЛОВЕК: привет', '/acc', async (prompt) => {
    seen ||= prompt;
    return '## Цель\nX';
  }, 'допиши отчёт для Славы');
  assert.match(seen, /Человек уже написал, что делать в новом чате: «допиши отчёт для Славы»/);
  assert.match(seen, /не больше ~\d+ слов/);
});

test('хвост после заготовки читается с границы строки, недописанная строка не теряется', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'handoff-'));
  const file = path.join(dir, 't.jsonl');
  const first = `${line({ type: 'user', message: { content: 'первое' } })}\n`;
  await writeFile(file, `${first}${line({ type: 'user', message: { content: 'второе' } }).slice(0, 20)}`);
  const cut = await transcriptLineBoundary(file);
  assert.equal(cut, Buffer.byteLength(first));
  await writeFile(file, `${first}${line({ type: 'user', message: { content: 'второе' } })}\n`);
  const head = await digestTranscriptFile(file, SID, { end: cut });
  const tail = await digestTranscriptFile(file, SID, { start: cut, end: await transcriptLineBoundary(file) });
  assert.match(head.text, /первое/);
  assert.doesNotMatch(head.text, /второе/);
  assert.match(tail.text, /ЧЕЛОВЕК: второе/);
  assert.doesNotMatch(tail.text, /первое/);
});

test('файл разговора: ответы целиком, без действий и служебного', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'handoff-'));
  const file = path.join(dir, 't.jsonl');
  const long = 'Промпт: '.padEnd(9000, 'я');
  await writeFile(file, [
    line({ type: 'user', message: { content: 'Сделай промпт' } }),
    line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'черновик' }, { type: 'text', text: long }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
    line({ type: 'user', toolUseResult: {}, message: { content: [{ type: 'tool_result', content: 'вывод команды' }] } }),
    line({ type: 'user', isMeta: true, message: { content: 'служебное' } }),
  ].join('\n'));
  const out = path.join(dir, 'sub', 'dialog.md');
  await exportDialogFile(file, SID, out, 'Тест');
  const text = await readFile(out, 'utf8');
  assert.match(text, /^# Разговор чата «Тест»/);
  assert.match(text, /Человек\n\nСделай промпт/);
  assert.ok(text.includes(long), 'длинный ответ — целиком, без обрезки');
  assert.doesNotMatch(text, /черновик|вывод команды|служебное|ls/);
});

test('дословный хвост: ключи и ссылки входа скрыты', () => {
  const text = scrubSecrets('ЧЕЛОВЕК: вот https://cc.example.ru/enter/nMsKcj_ooYAWE4bhfdzm8A и sk-ant-abcdefghijklmnopqrstuv');
  assert.doesNotMatch(text, /nMsKcj|abcdefghijkl/);
  assert.match(text, /enter\/\[скрыто\]/);
});

test('откат чата после заготовки делает её недействительной', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'handoff-'));
  const file = path.join(dir, 't.jsonl');
  const a = `${line({ type: 'user', message: { content: 'ветка А' } })}\n`;
  const b = `${line({ type: 'user', message: { content: 'ответ по ветке А' } })}\n`;
  await writeFile(file, a + b);
  const bytes = await transcriptLineBoundary(file);
  const fingerprint = await tailFingerprint(file, bytes);
  await writeFile(file, `${a + b}${line({ type: 'user', message: { content: 'дальше' } })}\n`);
  assert.equal(await transcriptUnchangedUpTo(file, bytes, fingerprint), true, 'дописан — заготовка годна');
  await writeFile(file, a);
  assert.equal(await transcriptUnchangedUpTo(file, bytes, fingerprint), false, 'урезан — негодна');
  await writeFile(file, a + `${line({ type: 'user', message: { content: 'ветка Б, другой текст той же длины!!' } })}\n`.padEnd(b.length + 10, ' '));
  assert.equal(await transcriptUnchangedUpTo(file, bytes, fingerprint), false, 'переписан после отката — негодна');
});

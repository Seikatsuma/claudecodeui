/**
 * Возврат к сообщению: обрезка разговора по началу выбранной реплики.
 *
 * Проверяем на настоящем файле во временной папке: что убирается ровно
 * выбранное сообщение и всё после него, что полная копия остаётся рядом, что
 * реплика находится и по номеру строки, и по тексту (только что отправленное
 * сообщение номера в ленте ещё не имеет), и что очередь чата снимается, а её
 * тексты возвращаются.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chatMessageQueueDb, closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionRewindService } from '@/modules/providers/services/session-rewind.service.js';

const SESSION_ID = 'rewind-session-0001';
const PROJECT_PATH = '/workspace/rewind-project';

const U1 = '11111111-1111-4111-8111-111111111111';
const A1 = '22222222-2222-4222-8222-222222222222';
const U2 = '33333333-3333-4333-8333-333333333333';
const T2 = '44444444-4444-4444-8444-444444444444';
const A2 = '55555555-5555-4555-8555-555555555555';
const U3 = '66666666-6666-4666-8666-666666666666';

function transcript(): string {
  const rows = [
    { type: 'permission-mode', permissionMode: 'default', sessionId: SESSION_ID },
    { type: 'user', uuid: U1, parentUuid: null, sessionId: SESSION_ID, message: { role: 'user', content: 'Привет, сделай отчёт' } },
    { type: 'assistant', uuid: A1, parentUuid: U1, sessionId: SESSION_ID, message: { role: 'assistant', content: [{ type: 'text', text: 'Готово' }] } },
    { type: 'user', uuid: U2, parentUuid: A1, sessionId: SESSION_ID, message: { role: 'user', content: [{ type: 'text', text: 'Теперь  разошли\nвсем' }] } },
    { type: 'user', uuid: T2, parentUuid: U2, sessionId: SESSION_ID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } },
    { type: 'assistant', uuid: A2, parentUuid: T2, sessionId: SESSION_ID, message: { role: 'assistant', content: [{ type: 'text', text: 'Разослал' }] } },
    { type: 'user', uuid: U3, parentUuid: A2, sessionId: SESSION_ID, message: { role: 'user', content: 'Спасибо' } },
  ];
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

async function withSession(run: (jsonlPath: string, directory: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'session-rewind-'));
  const jsonlPath = path.join(directory, `${SESSION_ID}.jsonl`);
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    await writeFile(jsonlPath, transcript(), 'utf8');
    sessionsDb.createSession(SESSION_ID, 'claude', PROJECT_PATH, undefined, undefined, undefined, jsonlPath);
    await run(jsonlPath, directory);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
}

const uuidsIn = (content: string): string[] =>
  content.trim().split('\n').map((line) => JSON.parse(line).uuid).filter(Boolean);

test('по номеру строки: убирается выбранная реплика и всё после неё, копия остаётся', async () => {
  await withSession(async (jsonlPath, directory) => {
    const original = await readFile(jsonlPath, 'utf8');
    const result = await sessionRewindService.rewind({
      sessionId: SESSION_ID,
      messageId: `${U2}_text_0`,
      text: null,
    });

    assert.equal(result.text, 'Теперь  разошли\nвсем');
    assert.deepEqual(result.queuedTexts, []);
    assert.equal(result.removedLines, 4);

    const after = await readFile(jsonlPath, 'utf8');
    assert.deepEqual(uuidsIn(after), [U1, A1], 'остаются реплики до выбранной');
    assert.ok(after.endsWith('\n'), 'файл кончается целой строкой');
    assert.equal(await readFile(result.backupPath, 'utf8'), original, 'копия — полный исходный разговор');

    const files = await readdir(directory);
    assert.equal(files.filter((name) => name.endsWith('.jsonl')).length, 1, 'копия не выглядит как второй чат');
  });
});

test('по тексту (свежее сообщение без номера): последнее совпадение, пробелы не важны', async () => {
  await withSession(async (jsonlPath) => {
    const result = await sessionRewindService.rewind({
      sessionId: SESSION_ID,
      messageId: 'local-echo-123',
      text: 'Теперь разошли всем ',
    });
    assert.equal(result.removedLines, 4);
    assert.deepEqual(uuidsIn(await readFile(jsonlPath, 'utf8')), [U1, A1]);
  });
});

test('к первому сообщению: остаются только служебные записи', async () => {
  await withSession(async (jsonlPath) => {
    await sessionRewindService.rewind({ sessionId: SESSION_ID, messageId: U1, text: null });
    const after = await readFile(jsonlPath, 'utf8');
    assert.deepEqual(uuidsIn(after), []);
    assert.equal(JSON.parse(after.trim()).type, 'permission-mode');
  });
});

test('не найдено — файл не трогается и копия не создаётся', async () => {
  await withSession(async (jsonlPath, directory) => {
    const original = await readFile(jsonlPath, 'utf8');
    await assert.rejects(
      sessionRewindService.rewind({ sessionId: SESSION_ID, messageId: null, text: 'такого не было' }),
      /Не нашёл это сообщение/,
    );
    assert.equal(await readFile(jsonlPath, 'utf8'), original);
    assert.equal((await readdir(directory)).some((name) => name.includes('before-rewind')), false);
  });
});

test('результат действия — не реплика: по его номеру не возвращаемся', async () => {
  await withSession(async () => {
    await assert.rejects(
      sessionRewindService.rewind({ sessionId: SESSION_ID, messageId: T2, text: null }),
      /Не нашёл это сообщение/,
    );
  });
});

test('очередь чата снимается, её тексты возвращаются', async () => {
  await withSession(async () => {
    chatMessageQueueDb.append({ id: 'q1', sessionId: SESSION_ID, userId: null, content: 'и ещё вот это', options: {} });
    const result = await sessionRewindService.rewind({ sessionId: SESSION_ID, messageId: U3, text: null });
    assert.deepEqual(result.queuedTexts, ['и ещё вот это']);
    assert.equal(chatMessageQueueDb.list(SESSION_ID).length, 0);
  });
});

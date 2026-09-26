import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionConversationsSearchService } from '@/modules/providers/services/session-conversations-search.service.js';

const OWN_ID = '11111111-2222-3333-4444-555555555555';
const FOREIGN_ID = '66666666-7777-8888-9999-000000000000';

const line = (sessionId: string, entry: Record<string, unknown>) =>
  JSON.stringify({ sessionId, uuid: `${Math.random()}`, timestamp: '2026-09-25T10:00:00Z', ...entry });

test('превью: последние слова человека без служебного и вложений, чужой аккаунт не читается', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), 'session-previews-'));
  const ownAccount = path.join(root, 'own');
  const foreignAccount = path.join(root, 'foreign');

  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  process.env.CLAUDE_CONFIG_DIR = ownAccount;
  await initializeDatabase();

  try {
    const ownFile = path.join(ownAccount, 'projects', '-p', `${OWN_ID}.jsonl`);
    await mkdir(path.dirname(ownFile), { recursive: true });
    await writeFile(ownFile, [
      line(OWN_ID, { type: 'user', message: { role: 'user', content: 'ранняя просьба' } }),
      line(OWN_ID, { type: 'user', message: { role: 'user', content: 'Добавь новый чат на главный экран\n<files_input>\n1. /tmp/снимок.heic\n</files_input>' } }),
      line(OWN_ID, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Готово,   кнопка\nстоит.' }] } }),
      line(OWN_ID, { type: 'user', message: { role: 'user', content: '<task-notification> фоновая задача закончила' } }),
      line(OWN_ID, { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: '[Image: original 2560x1600, displayed at 2000x1250.]' }] } }),
      line(OWN_ID, { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /x' }] } }),
    ].join('\n') + '\n');

    const foreignFile = path.join(foreignAccount, 'projects', '-p', `${FOREIGN_ID}.jsonl`);
    await mkdir(path.dirname(foreignFile), { recursive: true });
    await writeFile(foreignFile, `${line(FOREIGN_ID, { type: 'user', message: { role: 'user', content: 'секрет' } })}\n`);

    const ownSession = sessionsDb.createSession(OWN_ID, 'claude', '/p', 'Главный экран', undefined, undefined, ownFile);
    const foreignSession = sessionsDb.createSession(FOREIGN_ID, 'claude', '/p', 'Чужой', undefined, undefined, foreignFile);

    const previews = await sessionConversationsSearchService.readPreviews([ownSession, foreignSession, 'нет-такого']);

    assert.deepEqual(Object.keys(previews), [ownSession], 'чужой и несуществующий чат — без превью');
    assert.equal(previews[ownSession].lastUserText, 'Добавь новый чат на главный экран');
    assert.equal(previews[ownSession].lastAssistantText, 'Готово, кнопка стоит.');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    await rm(root, { recursive: true, force: true });
  }
});

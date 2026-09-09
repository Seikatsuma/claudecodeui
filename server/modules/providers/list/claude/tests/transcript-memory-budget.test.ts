/**
 * Страж памяти: открытие чата не должно дорожать вместе с длиной переписки.
 *
 * Дважды — 07.09 и 09.09 — общая служба падала с «heap out of memory» и
 * уходила в перезапуск по кругу, унося чаты всех, кто в этот момент работал.
 * Оба раза причина была одна и та же и звучала невинно: чтобы отдать
 * страницу в двадцать сообщений (или всего лишь название модели), сервер
 * поднимал в память ВСЮ стенограмму. У чатов на 60–70 МБ это сотни мегабайт
 * при потолке службы 450 МБ.
 *
 * Оба раза правка чинила одно место, а класс ошибки оставался: место, где
 * читают файл целиком, ничем не отличается на вид от места, где читают
 * страницу. Этот тест и есть разница. Он строит заведомо большую стенограмму
 * и требует, чтобы работа с ней укладывалась в бюджет памяти. Любая будущая
 * правка, которая вернёт полное чтение, покраснеет здесь, а не в проде.
 *
 * Если тест мешает — чинить нужно код, а не поднимать бюджет.
 */
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';

import { ClaudeSessionsProvider } from '../claude-sessions.provider.js';
import { ClaudeProviderModels } from '../claude-models.provider.js';
import { forgetTranscriptTail } from '../transcript-tail-cache.js';

const SESSION_ID = 'budget-session-0001';
const PROJECT_PATH = '/workspace/budget-project';
const MODEL = 'claude-sonnet-5';

/** Стенограмма должна быть заведомо больше любого разумного бюджета. */
const TRANSCRIPT_TARGET_BYTES = 48 * 1024 * 1024;

/**
 * Потолок прироста памяти на одну операцию.
 *
 * Считан не с потолка: аккуратное чтение окна укладывается в единицы —
 * десятки мегабайт, а чтение файла целиком даёт втрое больше его размера.
 * Между этими величинами пропасть, поэтому граница не шаткая.
 */
const MEMORY_BUDGET_BYTES = 60 * 1024 * 1024;

async function writeLargeTranscript(filePath: string): Promise<void> {
  const filler = 'а'.repeat(1500);
  const stream = createWriteStream(filePath);
  let written = 0;
  let index = 0;

  while (written < TRANSCRIPT_TARGET_BYTES) {
    const line = `${JSON.stringify({
      sessionId: SESSION_ID,
      type: 'assistant',
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
      message: {
        role: 'assistant',
        model: MODEL,
        content: [{ type: 'text', text: `${index} ${filler}` }],
      },
    })}\n`;

    written += Buffer.byteLength(line, 'utf8');
    index += 1;
    if (!stream.write(line)) {
      await once(stream, 'drain');
    }
  }

  stream.end();
  await once(stream, 'finish');
}

/** Возвращает, на сколько выросла куча за время работы. */
async function measureHeapGrowth(run: () => Promise<unknown>): Promise<number> {
  const before = process.memoryUsage().heapUsed;
  let peak = before;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  }, 10);

  try {
    await run();
  } finally {
    clearInterval(timer);
  }

  peak = Math.max(peak, process.memoryUsage().heapUsed);
  return peak - before;
}

const asMb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} МБ`;

test('открытие длинного чата укладывается в бюджет памяти', async (t) => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'transcript-budget-'));
  const jsonlPath = path.join(directory, `${SESSION_ID}.jsonl`);

  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();

  try {
    await writeLargeTranscript(jsonlPath);
    sessionsDb.createSession(SESSION_ID, 'claude', PROJECT_PATH, undefined, undefined, undefined, jsonlPath);
    forgetTranscriptTail();

    const sessions = new ClaudeSessionsProvider();
    const models = new ClaudeProviderModels();

    let page: Awaited<ReturnType<typeof sessions.fetchHistory>> | null = null;
    const pageGrowth = await measureHeapGrowth(async () => {
      page = await sessions.fetchHistory(SESSION_ID, {
        limit: 20,
        offset: 0,
        providerSessionId: SESSION_ID,
        projectPath: PROJECT_PATH,
      });
    });

    // Присваивание происходит внутри замыкания, и TypeScript этого не видит:
    // после вызова он считает переменную по-прежнему `null` и запрещает читать
    // поля. Снимаем сужение отдельной ссылкой — проверка от этого не слабеет.
    const pageResult = page as Awaited<ReturnType<typeof sessions.fetchHistory>> | null;
    assert.ok(pageResult, 'страница должна прийти');
    assert.equal(pageResult.messages.length, 20, 'страница — двадцать сообщений, как просили');
    assert.equal(pageResult.hasMore, true, 'кнопка «показать ранние» должна остаться');
    t.diagnostic(`страница чата: ${asMb(pageGrowth)}`);
    assert.ok(
      pageGrowth < MEMORY_BUDGET_BYTES,
      `открытие страницы съело ${asMb(pageGrowth)} при бюджете ${asMb(MEMORY_BUDGET_BYTES)} — `
       + 'похоже, стенограмма снова читается целиком',
    );

    forgetTranscriptTail();

    let active: Awaited<ReturnType<typeof models.getCurrentActiveModel>> | null = null;
    const modelGrowth = await measureHeapGrowth(async () => {
      active = await models.getCurrentActiveModel(SESSION_ID);
    });

    assert.equal(active!.model, MODEL, 'модель чата должна определяться по стенограмме');
    t.diagnostic(`название модели: ${asMb(modelGrowth)}`);
    assert.ok(
      modelGrowth < MEMORY_BUDGET_BYTES,
      `запрос модели съел ${asMb(modelGrowth)} при бюджете ${asMb(MEMORY_BUDGET_BYTES)} — `
       + 'название модели не стоит чтения всего файла',
    );
  } finally {
    closeConnection();
    forgetTranscriptTail();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

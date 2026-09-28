/**
 * Разбор мыслей «Хода работы»: какие из них — важные этапы, и их русский текст.
 *
 * Как пришли к этому:
 * - 13.09.26 Егор на ленту из всех размышлений подряд: «слишком много лишнего».
 * - 14.09 ограничили показ тремя последними и перевели на русский (модель
 *   размышляет по-английски — «он так умнее, а результаты пусть показываются
 *   на русском»).
 * - 14.09 Егор против потолка: «если он думал несколько часов, пусть распишет
 *   каждый пункт, который важный, ценный — этап какой-то, research закончил,
 *   критику запустил. Это я хочу видеть. До этого он писал абсолютно всё».
 *
 * Важность — вопрос смысла, длина её не ловит (отбор по длине 13.09 дал стену
 * из 22 абзацев). Поэтому одна дешёвая модель за один проход решает «этап или
 * рабочая мелочь» и переводит этапы на русский.
 *
 * Как устроено и почему так:
 * - Разбираются только мысли свёртки, которую человек раскрыл; каждая — один
 *   раз: итог лежит в файле под хэшем текста, повторное открытие подписку не
 *   тратит.
 * - Мысли идут пачками по порядку: модели нужен ход работы, чтобы отличить
 *   этап от повтора.
 * - Haiku без размышлений и инструментов, входом того, кто смотрит, без
 *   записи разговора и без чтения настроек с диска (`settingSources: []`):
 *   иначе на каждый вызов срабатывали бы хуки и CLAUDE.md.
 * - Не вышло — `null` на месте мысли, и показ оставляет её как есть: мысль не
 *   пропадает.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeConfigDirForEnv } from '@/shared/utils.js';

/** Сколько мыслей принимается за один запрос; длинную работу клиент шлёт страницами. */
export const MAX_THOUGHTS_PER_REQUEST = 60;
/**
 * Сколько мыслей уходит модели за один вызов. На пачке из 20 Haiku вернула 17
 * ответов (замер 14.09.26) — пачки меньше, ответы сверяются по номеру.
 */
const DIGEST_CHUNK_SIZE = 10;
const MAX_THOUGHT_CHARS = 4000;
const DIGEST_TIMEOUT_MS = 120 * 1000;
/**
 * Сколько вызовов Haiku идёт одновременно на весь сайт, и сколько ждут очереди.
 *
 * 21.09.26 в 15:01 за одну минуту запустилось 40 вызовов разом (много чатов и
 * вкладок открыли «Ход работы» одновременно). Каждый — отдельный процесс CLI на
 * ~110 МБ, вместе ~7 ГБ: сервис упёрся в свой потолок памяти, подкачка
 * кончилась, нагрузка сервера дошла до 116, сайт отдавал 502. При перезапуске
 * эти процессы ещё и остались висеть сиротами (KillMode=process).
 * Перевод мыслей — украшение: лучше показать мысль без перевода, чем уронить
 * сайт. Поэтому сверх очереди вызов не ставится вовсе — клиент получит null и
 * покажет оригинал, а следующий заход достанет перевод из кэша или спросит снова.
 */
const MAX_CONCURRENT_DIGESTS = 2;
const MAX_WAITING_DIGESTS = 6;
const CACHE_DIR = path.join(os.homedir(), '.cloudcli', 'thought-digests');
/** Своя папка запуска: не общая /tmp, где лежат записи других разговоров. */
const DIGEST_CWD = path.join(os.homedir(), '.cloudcli', 'thought-translate-cwd');
/** Пустышка с заголовком весит сотню байт; всё крупнее — не трогаем. */
const TITLE_STUB_MAX_BYTES = 4096;

export type ThoughtDigest = {
  /** Важный этап, который человеку стоит видеть. */
  keep: boolean;
  /** Русский текст этапа; для мелочи — null. */
  ru: string | null;
};

/**
 * Файл разговора, в котором нет ничего, кроме служебного заголовка.
 *
 * `persistSession: false` не мешает CLI дописать строку `ai-title` в файл
 * разговора (замер 14.09.26: 128 байт в ~/.claude/projects/-tmp/). Отключить
 * это нечем, поэтому такую пустышку убираем за собой — но только если в ней
 * действительно одни заголовки: настоящий разговор удалять нельзя.
 */
export function isTitleStubOnly(content: string): boolean {
  const lines = content.split('\n').filter((line) => line.trim());
  if (lines.length === 0) return false;
  return lines.every((line) => {
    try {
      const type = (JSON.parse(line) as { type?: unknown }).type;
      return type === 'ai-title' || type === 'custom-title';
    } catch {
      return false;
    }
  });
}

async function removeTitleStub(claudeConfigDir: string | null, sessionId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return;
  const configDir = claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const projectsDir = path.join(configDir, 'projects');
  let projectDirs: string[] = [];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return;
  }
  await Promise.all(projectDirs.map(async (dirName) => {
    const file = path.join(projectsDir, dirName, `${sessionId}.jsonl`);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > TITLE_STUB_MAX_BYTES) return;
      if (isTitleStubOnly(await readFile(file, 'utf-8'))) await unlink(file);
    } catch {
      // Файла нет — убирать нечего.
    }
  }));
}

function cacheFileFor(text: string): string {
  return path.join(CACHE_DIR, `${createHash('sha256').update(text).digest('hex')}.json`);
}

export function isMostlyRussian(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return true;
  const cyrillic = letters.filter((ch) => /[Ѐ-ӿ]/.test(ch)).length;
  return cyrillic / letters.length >= 0.5;
}

function readDigest(value: unknown): ThoughtDigest | null {
  if (!value || typeof value !== 'object') return null;
  const { keep, ru } = value as { keep?: unknown; ru?: unknown };
  if (typeof keep !== 'boolean') return null;
  if (!keep) return { keep: false, ru: null };
  if (typeof ru !== 'string' || !ru.trim()) return null;
  return { keep: true, ru: ru.trim() };
}

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Ответ действительно про эту мысль: модель повторила её первые слова.
 *
 * Замер 14.09.26 на 40 настоящих мыслях: мысль «сборка идёт в фоне, нужно
 * успеть до перезапуска; проверка не удалась — поле поиска не видно» получила
 * перевод одной второй половины — начало потерялось. При путанице номеров
 * (модель уже пропускала элементы) под мыслью оказался бы и вовсе чужой
 * текст. Поэтому без совпадения первых слов ответ не принимается и мысль
 * уходит на повторный разбор.
 */
export function echoMatches(source: string, echo: unknown): boolean {
  if (typeof echo !== 'string') return false;
  const expected = wordsOf(source).slice(0, 3);
  const got = wordsOf(echo).slice(0, 3);
  if (expected.length === 0 || got.length < Math.min(2, expected.length)) return false;
  return got.every((word, index) => word === expected[index]);
}

/**
 * Разбор ответа модели отдельно от вызова — чтобы проверять тестом.
 *
 * Ответы сверяются по номеру мысли, а не по порядку (модель иногда пропускает
 * или склеивает элементы), и по первым словам исходника (защита от перевода
 * без начала и от путаницы номеров). Не сошлось — `null` на месте мысли, её дошлют ещё раз; совсем не
 * JSON — `null`.
 */
export function parseDigest(raw: string, texts: string[]): Array<ThoughtDigest | null> | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const results: Array<ThoughtDigest | null> = texts.map(() => null);
  for (const item of parsed) {
    const { id, start: echo } = (item ?? {}) as { id?: unknown; start?: unknown };
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id >= texts.length) continue;
    if (!echoMatches(texts[id], echo)) continue;
    results[id] = readDigest(item);
  }
  return results;
}

export function buildDigestPrompt(texts: string[]): string {
  return [
    'Ниже по порядку — размышления ИИ-помощника во время одной работы, у каждого свой номер id. Человек, который поручил работу, хочет видеть этапы работы, но не рабочие мелочи.',
    '',
    'Для КАЖДОГО фрагмента реши, важный ли это этап.',
    'ВАЖНО (keep: true) — в фрагменте есть содержание, которое человеку стоит знать:',
    '- закончено исследование, разбор или замер, и есть вывод;',
    '- найдена причина, ошибка или неожиданный факт;',
    '- принято решение или изменён план — и почему;',
    '- запущена крупная проверка, критика, ревью или исследование — и что именно проверяется;',
    '- получен итог проверки или критики;',
    '- подведён итог части работы; упёрлись в препятствие.',
    'НЕ ВАЖНО (keep: false):',
    '- пустые реплики без содержания: «готово», «на этом закончил», «есть всё нужное, отвечаю», «можно двигаться дальше»;',
    '- «сейчас прочитаю / посмотрю / запущу X» без причины и без итога; ожидание;',
    '- пересказ команды, справки или синтаксиса; мелкая починка служебного скрипта;',
    '- повтор того, что уже сказано в предыдущих фрагментах.',
    '',
    'Для важных дай русский текст: точный перевод по смыслу, можно чуть короче, без потери сути и без добавлений от себя. Имена файлов, команды, код и названия программ оставляй как есть; имя Egor пиши «Егор». Если фрагмент уже по-русски — верни его как есть.',
    '',
    'Ответь ТОЛЬКО JSON-массивом, по одному элементу на КАЖДЫЙ id, ничего не пропуская и не объединяя. В поле start — первые три слова ЭТОГО фрагмента дословно, на языке оригинала: {"id": 0, "start": "The build is", "keep": true, "ru": "…"} или {"id": 1, "start": "Сначала изучу код", "keep": false}. Без пояснений.',
    '',
    JSON.stringify(texts.map((text, id) => ({ id, text }))),
  ].join('\n');
}

async function askModel(texts: string[], claudeConfigDir: string | null): Promise<Array<ThoughtDigest | null> | null> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  const configDir = claudeConfigDirForEnv(claudeConfigDir);
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  await mkdir(DIGEST_CWD, { recursive: true }).catch(() => undefined);

  const instance = query({
    prompt: buildDigestPrompt(texts),
    options: {
      cwd: DIGEST_CWD,
      model: 'haiku',
      tools: [],
      maxTurns: 1,
      thinking: { type: 'disabled' },
      persistSession: false,
      settingSources: [],
      env,
    },
  });

  let resultText = '';
  let sessionId: string | undefined;
  const timer = setTimeout(() => {
    try {
      instance.close?.();
    } catch {
      // Цикл ниже просто закончится.
    }
  }, DIGEST_TIMEOUT_MS);
  timer.unref?.();

  try {
    for await (const message of instance as AsyncIterable<Record<string, unknown>>) {
      if (typeof message.session_id === 'string' && !sessionId) {
        sessionId = message.session_id;
      }
      if (message.type === 'result' && typeof message.result === 'string') {
        resultText = message.result;
      }
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (sessionId) {
      const id = sessionId;
      await removeTitleStub(claudeConfigDir, id);
      // Заголовок CLI может дописать уже после ответа — второй заход позже.
      setTimeout(() => void removeTitleStub(claudeConfigDir, id), 20 * 1000).unref?.();
    }
  }

  return parseDigest(resultText, texts);
}

/** Одна и та же пачка из двух вкладок разбирается одним вызовом. */
const inFlight = new Map<string, Promise<Array<ThoughtDigest | null> | null>>();

let digestsRunning = 0;
const digestWaiters: Array<() => void> = [];

/**
 * Место в общей очереди вызовов. Освободившееся место передаётся следующему в
 * очереди напрямую, без уменьшения счётчика, — иначе новый запрос из того же
 * такта успевал бы занять его раньше ждущего и вызовов становилось бы больше
 * предела. `null` — очередь полна, вызова не будет.
 */
export async function withDigestSlot<T>(run: () => Promise<T>): Promise<T | null> {
  if (digestsRunning >= MAX_CONCURRENT_DIGESTS) {
    if (digestWaiters.length >= MAX_WAITING_DIGESTS) return null;
    await new Promise<void>((resolve) => digestWaiters.push(resolve));
  } else {
    digestsRunning += 1;
  }
  try {
    return await run();
  } finally {
    const next = digestWaiters.shift();
    if (next) next();
    else digestsRunning -= 1;
  }
}

async function digestChunk(texts: string[], claudeConfigDir: string | null): Promise<Array<ThoughtDigest | null> | null> {
  const key = `${claudeConfigDir ?? ''}\n${texts.join('\n \n')}`;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = withDigestSlot(() => askModel(texts, claudeConfigDir)).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

/**
 * Итог разбора в том же порядке; `null` на месте мысли, которую разобрать не
 * удалось.
 */
export async function digestThoughts(
  rawTexts: unknown,
  claudeConfigDir: string | null,
): Promise<Array<ThoughtDigest | null>> {
  const texts = (Array.isArray(rawTexts) ? rawTexts : [])
    .slice(0, MAX_THOUGHTS_PER_REQUEST)
    .map((item) => (typeof item === 'string' ? item.slice(0, MAX_THOUGHT_CHARS) : ''));

  const results: Array<ThoughtDigest | null> = texts.map(() => null);
  const missing: number[] = [];

  await Promise.all(texts.map(async (text, index) => {
    if (!text.trim()) return;
    try {
      results[index] = readDigest(JSON.parse(await readFile(cacheFileFor(text), 'utf-8')));
    } catch {
      // Ещё не разбирали.
    }
    if (results[index] === null) missing.push(index);
  }));

  if (missing.length === 0) return results;
  missing.sort((a, b) => a - b);
  await mkdir(CACHE_DIR, { recursive: true }).catch(() => undefined);

  const save = async (index: number, digest: ThoughtDigest) => {
    // Русскую мысль-этап показываем словами автора, а не пересказом модели.
    const final: ThoughtDigest = digest.keep && isMostlyRussian(texts[index])
      ? { keep: true, ru: texts[index] }
      : digest;
    results[index] = final;
    await writeFile(cacheFileFor(texts[index]), JSON.stringify(final), 'utf-8').catch(() => undefined);
  };

  const runChunks = async (indices: number[]): Promise<number[]> => {
    const unresolved: number[] = [];
    for (let start = 0; start < indices.length; start += DIGEST_CHUNK_SIZE) {
      const chunk = indices.slice(start, start + DIGEST_CHUNK_SIZE);
      const digests = await digestChunk(chunk.map((index) => texts[index]), claudeConfigDir);
      await Promise.all(chunk.map(async (index, position) => {
        const digest = digests?.[position] ?? null;
        if (digest) await save(index, digest);
        else unresolved.push(index);
      }));
    }
    return unresolved.sort((a, b) => a - b);
  };

  // Пропущенное моделью досылается ещё раз — отдельной, меньшей пачкой.
  const leftover = await runChunks(missing);
  if (leftover.length > 0) await runChunks(leftover);
  return results;
}

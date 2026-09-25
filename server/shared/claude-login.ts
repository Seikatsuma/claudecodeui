/**
 * Вошёл ли человек в Claude в СВОЕЙ папке настроек — одна проверка на всех.
 *
 * 25.09.26, жалоба Егора: новый человек входит в Claude в командной строке
 * сайта, подтверждает вход, а чат отвечает «Add your Anthropic API key» —
 * «они как будто живут отдельно». Командная строка и экран «вход есть»
 * смотрели в папку человека и видели вход, а чат (правило 02.09, до того как
 * терминал научился писать вход в папку человека) пускал не-владельца только
 * с ключом API из настроек. Две проверки одного и того же разошлись молча —
 * поэтому теперь она одна, здесь.
 *
 * Вторая половина той же истории: короткий ключ (accessToken) живёт около
 * восьми часов, и экран через полдня писал «вход истёк, войдите снова», хотя
 * при живом ключе продления (refreshToken) Claude продлевает вход сам при
 * первом же запросе. Мы ключ только читаем и сами не продлеваем: продление
 * сервером рядом с CLI ломает вход (см. official-usage.ts).
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

/** Ключи Claude, которые процесс мог бы унаследовать от окружения сервера. */
export const INHERITED_CLAUDE_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

export type ClaudeLoginFileStatus = {
  authenticated: boolean;
  email: string | null;
  method: 'credentials_file' | 'api_key' | 'environment' | null;
  error?: string;
};

const MISSING_LOGIN_ERROR = 'Claude CLI is not authenticated. Run claude /login or configure ANTHROPIC_API_KEY.';

const hasErrorCode = (error: unknown, code: string): boolean => (
  error instanceof Error && 'code' in error && error.code === code
);

const isStillValid = (expiresAt: unknown, now: number): boolean => (
  typeof expiresAt !== 'number' || now < expiresAt
);

/** Ключи из `env` в settings.json этой папки — CLI берёт их и без окружения сервера. */
export async function readClaudeSettingsEnv(configDir: string): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(path.join(configDir, 'settings.json'), 'utf8');
    const settings = readObjectRecord(JSON.parse(content));
    return readObjectRecord(settings?.env) ?? {};
  } catch {
    return {};
  }
}

/**
 * Вход в Claude, записанный в этой папке: ключ из settings.json или вход
 * подпиской (`.credentials.json`, его пишет `claude /login`).
 */
export async function readClaudeLoginFromConfigDir(
  configDir: string,
  now: number = Date.now(),
): Promise<ClaudeLoginFileStatus> {
  const settingsEnv = await readClaudeSettingsEnv(configDir);
  if (readOptionalString(settingsEnv.ANTHROPIC_API_KEY)) {
    return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
  }
  if (readOptionalString(settingsEnv.ANTHROPIC_AUTH_TOKEN)) {
    return { authenticated: true, email: 'Configured via settings.json', method: 'api_key' };
  }
  if (readOptionalString(settingsEnv.CLAUDE_CODE_OAUTH_TOKEN)) {
    return { authenticated: true, email: 'OAuth Token (long-lived)', method: 'environment' };
  }

  let content: string;
  try {
    content = await readFile(path.join(configDir, '.credentials.json'), 'utf8');
  } catch (error) {
    return {
      authenticated: false,
      email: null,
      method: null,
      error: hasErrorCode(error, 'ENOENT')
        ? MISSING_LOGIN_ERROR
        : 'Unable to read Claude credentials. Run claude /login again.',
    };
  }

  let creds: Record<string, unknown>;
  try {
    creds = readObjectRecord(JSON.parse(content)) ?? {};
  } catch {
    return {
      authenticated: false,
      email: null,
      method: null,
      error: 'Claude credentials are unreadable. Run claude /login again.',
    };
  }

  const oauth = readObjectRecord(creds.claudeAiOauth);
  if (!readOptionalString(oauth?.accessToken)) {
    return { authenticated: false, email: null, method: null, error: MISSING_LOGIN_ERROR };
  }

  const email = readOptionalString(creds.email) ?? readOptionalString(creds.user) ?? null;
  const accessValid = isStillValid(oauth?.expiresAt, now);
  // Короткий ключ истёк, но есть живой ключ продления — CLI продлит вход сам.
  const renewable = Boolean(readOptionalString(oauth?.refreshToken))
    && isStillValid(oauth?.refreshTokenExpiresAt, now);

  if (accessValid || renewable) {
    return { authenticated: true, email, method: 'credentials_file' };
  }

  return {
    authenticated: false,
    email: null,
    method: null,
    error: 'Claude login has expired. Run claude /login again.',
  };
}

/** То, что нужно проверкам ниже из расчёта пользователя (web-user-runtime.ts). */
export type ClaudeAccessContext = {
  claudeConfigDir: string | null;
  anthropicApiKey: string | null;
  isolateInheritedClaudeAuth: boolean;
};

/**
 * Есть ли у человека СВОЙ доступ к Claude: ключ API в настройках сайта или
 * вход, сделанный в его командной строке (`claude /login` пишет его в папку
 * человека). Чат спрашивает ровно это, а не «есть ли ключ API»: до 25.09.26
 * вход подпиской в командной строке чат не видел, и человеку, только что
 * вошедшему, отвечал «добавьте ключ API».
 */
export async function hasOwnClaudeAccess(context: ClaudeAccessContext): Promise<boolean> {
  if (context.anthropicApiKey) {
    return true;
  }
  if (!context.claudeConfigDir) {
    return false;
  }
  return (await readClaudeLoginFromConfigDir(context.claudeConfigDir)).authenticated;
}

/** Копия окружения без ключей Claude сервера — для процесса гостя (почему — web-user-runtime.ts, isolateInheritedClaudeAuth). */
export function withoutInheritedClaudeAuth(
  env: NodeJS.ProcessEnv,
  context: ClaudeAccessContext,
): NodeJS.ProcessEnv {
  if (!context.isolateInheritedClaudeAuth) {
    return env;
  }
  const copy = { ...env };
  for (const key of INHERITED_CLAUDE_AUTH_ENV_KEYS) {
    delete copy[key];
  }
  return copy;
}

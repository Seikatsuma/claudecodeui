import pty, { type IPty } from 'node-pty';

import { ensureDevinSlot2Profile, setActiveDevinSlot } from '@/shared/devin-slots.js';
import { buildDevinChildEnv, resolveDevinCliCommand } from '@/shared/utils.js';

import { forgetDevinAccountCache, readFreshDevinSlot2 } from './devin-account.service.js';

/**
 * Вход во второй аккаунт Devin прямо из чата: кнопка «Добавить аккаунт» →
 * ссылка → поле для кода (Егор 07.10.26: «стабильную ссылку … я скинул код и
 * всё бы там уже работало»).
 *
 * Ссылка входа Devin одноразовая и привязана к ЖИВОМУ процессу `devin auth login`
 * (PKCE: процесс помнит свой секрет и ждёт код со страницы). Поэтому «стабильность»
 * здесь — кнопка, которая в любой момент запускает свежий вход, а не вечная
 * ссылка. Процесс живёт у сервера не дольше LOGIN_TTL_MS и один: новый запуск
 * закрывает прежний.
 *
 * Devin читает код только с настоящего терминала (в обычный канал отвечает
 * «user canceled»), поэтому он запускается в псевдотерминале, как терминал сайта.
 * Два нюанса, найденных 07.10.26 на пробах: (1) на запрос позиции курсора
 * (ESC[6n) надо ответить, иначе окно ввода не оживает; (2) подтверждение
 * ввода — возврат каретки \r, а не перевод строки: с \n код оставался в строке
 * ввода и не отправлялся. Вход пишется в `credentials.toml` слота 2
 * (shared/devin-slots.ts), основной аккаунт не затрагивается.
 */
export type DevinLoginStart = { url: string };
export type DevinLoginResult = { ok: boolean; name: string | null; message: string };

const LOGIN_TTL_MS = 20 * 60_000;
const URL_WAIT_MS = 20_000;
const EXCHANGE_WAIT_MS = 30_000;
const URL_PATTERN = /https:\/\/app\.devin\.ai\/auth\/cli\/continue\?state=[0-9a-f-]+&prompt=select_account&code_challenge=[A-Za-z0-9_-]+&code_challenge_method=S256&cli_pkce_marker=1/;
const ANSI_PATTERN = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g;
// Код со страницы входа: безопасные символы base64url, без пробелов и управляющих.
const CODE_PATTERN = /^[A-Za-z0-9._~-]{8,300}$/;

type LoginSession = {
  proc: IPty;
  text: string;
  url: string | null;
  exited: boolean;
  exitCode: number | null;
  timer: NodeJS.Timeout;
};

let current: LoginSession | null = null;

function closeSession(session: LoginSession | null): void {
  if (!session) return;
  clearTimeout(session.timer);
  if (!session.exited) {
    try {
      session.proc.kill();
    } catch {
      // Уже завершился.
    }
  }
  if (current === session) {
    current = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Запускает свежий вход и возвращает ссылку, которую человек открывает в браузере. */
export async function startDevinLogin(): Promise<DevinLoginStart> {
  closeSession(current);
  ensureDevinSlot2Profile();

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(buildDevinChildEnv(2))) {
    if (typeof value === 'string') env[key] = value;
  }
  env.TERM = 'xterm-256color';

  const proc = pty.spawn(resolveDevinCliCommand(), ['auth', 'login', '--force-manual-token-flow'], {
    name: 'xterm-256color',
    cols: 300, // широко, чтобы ссылка не переносилась по строкам
    rows: 50,
    cwd: process.env.HOME,
    env,
  });
  const session: LoginSession = {
    proc,
    text: '',
    url: null,
    exited: false,
    exitCode: null,
    timer: setTimeout(() => closeSession(session), LOGIN_TTL_MS),
  };
  session.timer.unref?.();
  current = session;

  proc.onData((chunk) => {
    if (chunk.includes('\x1b[6n')) {
      proc.write('\x1b[1;1R');
    }
    session.text += chunk.replace(ANSI_PATTERN, '');
    if (session.text.length > 20_000) {
      session.text = session.text.slice(-10_000);
    }
    if (!session.url) {
      session.url = URL_PATTERN.exec(session.text)?.[0] ?? null;
    }
  });
  proc.onExit(({ exitCode }) => {
    session.exited = true;
    session.exitCode = exitCode;
  });

  const deadline = Date.now() + URL_WAIT_MS;
  while (!session.url && !session.exited && Date.now() < deadline) {
    await sleep(200);
  }
  if (!session.url) {
    closeSession(session);
    throw new Error('Devin не выдал ссылку входа. Попробуйте ещё раз.');
  }
  return { url: session.url };
}

/** Передаёт код со страницы входа процессу и проверяет, что вход появился. */
export async function submitDevinLoginCode(rawCode: string): Promise<DevinLoginResult> {
  const code = rawCode.trim();
  if (!CODE_PATTERN.test(code)) {
    return { ok: false, name: null, message: 'Код выглядит неправильно: скопируйте его со страницы входа целиком.' };
  }
  const session = current;
  if (!session || session.exited) {
    return { ok: false, name: null, message: 'Ссылка устарела. Нажмите «Новая ссылка» и войдите заново.' };
  }

  session.proc.write(code);
  await sleep(300);
  session.proc.write('\r');

  const deadline = Date.now() + EXCHANGE_WAIT_MS;
  while (!session.exited && Date.now() < deadline) {
    await sleep(250);
  }

  forgetDevinAccountCache();
  const account = await readFreshDevinSlot2();
  if (account.available) {
    // Новый аккаунт сразу делаем рабочим: именно ради него его и добавляли.
    setActiveDevinSlot(2);
    forgetDevinAccountCache();
    closeSession(session);
    return { ok: true, name: account.name, message: 'Аккаунт Devin подключён.' };
  }

  const failed = /Failed to exchange code|Error:/i.test(session.text);
  closeSession(session);
  return {
    ok: false,
    name: null,
    message: failed
      ? 'Код не подошёл или устарел. Нажмите «Новая ссылка», войдите заново и вставьте свежий код.'
      : 'Вход не завершился. Нажмите «Новая ссылка» и попробуйте ещё раз.',
  };
}

/** Закрыть незаконченный вход (окно закрыли) — чтобы процесс не висел. */
export function cancelDevinLogin(): void {
  closeSession(current);
}

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveDevinCliCommand } from '@/shared/utils.js';

import { hideDevinSessionsInDirectory } from './devin-chain.js';

/**
 * Отдельная служебная папка разовых вызовов `devin -p`: беседы в ней —
 * только выжимки и названия, не работа человека. Одна папка на все
 * подобные вызовы: handoff-дайджесты и генератор имён чатов.
 */
export const DEVIN_MODEL_CWD = path.join(os.homedir(), '.cloudcli', 'handoff-devin-cwd');

/** Потребитель: `handoff.service.ts` — выжимка при переносе чата Devin. */
const MODEL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Тот же один ответ, но от Devin — для артефактов чатов Devin (Егор
 * 03.10.26: «только его токены» — выжимку и название чата Devin пишет
 * сам Devin, не Claude). Живёт в модуле провайдера: им пользуются и
 * handoff (выжимка переноса), и синхронизатор (имя чата); импорт из
 * handoff сюда дал бы цикл модулей.
 *
 * `devin -p` всегда создаёт беседу в рабочей папке; она идёт в свою папку
 * DEVIN_MODEL_CWD и после вызова помечается скрытой — в список чатов не
 * попадает. Ответ — текст stdout; при ошибке — stderr и код выхода.
 */
export async function askDevinOnce(prompt: string, timeoutMs = MODEL_TIMEOUT_MS): Promise<string> {
  await mkdir(DEVIN_MODEL_CWD, { recursive: true }).catch(() => undefined);
  const result = await new Promise<{ text: string; error: string | null }>((resolve) => {
    const child = spawn(resolveDevinCliCommand(), [
      '--respect-workspace-trust', 'false',
      '-p', prompt,
    ], {
      cwd: DEVIN_MODEL_CWD,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ text: '', error: 'Devin не ответил вовремя' });
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ text: '', error: error.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({
        text: stdout,
        error: code === 0 ? null : (stderr.trim().split('\n').pop() || `Devin завершился с кодом ${String(code)}`),
      });
    });
  });
  // Беседа вызова пишется в общую базу Devin — прячем, чтобы не всплыла чатом.
  hideDevinSessionsInDirectory(DEVIN_MODEL_CWD);
  if (result.error || !result.text.trim()) {
    throw new Error(result.error || 'Devin не ответил');
  }
  return result.text.trim();
}

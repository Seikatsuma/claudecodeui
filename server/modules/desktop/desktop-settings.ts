import fs from 'node:fs/promises';
import path from 'node:path';

import express from 'express';

import { appConfigDb } from '@/modules/database/repositories/app-config.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { getClaudeConfigDir, validateWorkspacePath } from '@/shared/utils.js';

/**
 * Раздел «Папки» в настройках программы на компьютере (28.09.26, вопрос Ричарда:
 * «хочу рабочую папку, чтобы не захламлять диск C; подтянул мои проекты из Codex»).
 *
 * — Рабочая папка: с неё начинается окно выбора папки у «+». Claude и так
 *   работает только внутри открытой папки — всё, что он создаёт, ложится туда.
 * — Показывать ли проекты из переписки других помощников (Codex, Cursor…):
 *   по умолчанию нет (sessionsDb.createSession), включил — появляются.
 * — Где лежит история переписки Claude и сколько места занимает — честный
 *   ответ на «не захламлять диск C»: её хранит сам Claude в своей папке.
 */

const KEY_WORK_FOLDER = 'desktop.work_folder';
export const KEY_SHOW_OTHER_AGENTS = 'desktop.show_other_agents';

export const showOtherAgentsProjects = (): boolean => appConfigDb.get(KEY_SHOW_OTHER_AGENTS) === '1';

const historyDir = (): string => path.join(getClaudeConfigDir(), 'projects');

/** Размер истории — обходом папки, не дольше 3 секунд (у долгих чатов файлы до 90 МБ, их немного). */
async function folderSizeBytes(dir: string, deadline: number): Promise<number | null> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    if (Date.now() > deadline) return null;
    const current = stack.pop() as string;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += (await fs.stat(full)).size;
        } catch {
          /* файл убрали на ходу */
        }
      }
    }
  }
  return total;
}

// Настройки — сразу; размер истории — отдельным запросом (обход папки до 3 с не держит раздел).
function readSettings() {
  return {
    workFolder: appConfigDb.get(KEY_WORK_FOLDER) || null,
    showOtherAgents: showOtherAgentsProjects(),
    historyFolder: historyDir(),
  };
}

const router = express.Router();

router.use((_req, res, next) => {
  if (process.env.CLAUDE_UI_DESKTOP !== '1') {
    res.status(404).json({ success: false, error: 'Только в программе для компьютера.' });
    return;
  }
  next();
});

router.get('/settings', (_req, res) => {
  res.json({ success: true, data: readSettings() });
});

router.get('/history-size', async (_req, res) => {
  const bytes = await folderSizeBytes(historyDir(), Date.now() + 3000);
  res.json({ success: true, data: { historySizeMb: bytes === null ? null : Math.round((bytes / 1024 / 1024) * 10) / 10 } });
});

router.put('/settings', async (req, res) => {
  const body = (req.body || {}) as { workFolder?: unknown; showOtherAgents?: unknown };

  if (body.workFolder !== undefined) {
    if (body.workFolder === null || body.workFolder === '') {
      appConfigDb.set(KEY_WORK_FOLDER, '');
    } else if (typeof body.workFolder === 'string') {
      const check = await validateWorkspacePath(body.workFolder);
      const stat = check.valid ? await fs.stat(body.workFolder).catch(() => null) : null;
      if (!check.valid || !stat?.isDirectory()) {
        res.status(400).json({ success: false, error: check.valid ? 'Такой папки нет — выберите существующую.' : check.error });
        return;
      }
      appConfigDb.set(KEY_WORK_FOLDER, check.resolvedPath || body.workFolder);
    }
  }

  if (typeof body.showOtherAgents === 'boolean' && body.showOtherAgents !== showOtherAgentsProjects()) {
    appConfigDb.set(KEY_SHOW_OTHER_AGENTS, body.showOtherAgents ? '1' : '0');
    // Сразу, а не только для новых: включил — вернуть такие проекты, выключил — убрать.
    if (body.showOtherAgents) projectsDb.showProjectsOnlyFromOtherAgents();
    else projectsDb.hideProjectsOnlyFromOtherAgents();
  }

  res.json({ success: true, data: readSettings() });
});

export default router;

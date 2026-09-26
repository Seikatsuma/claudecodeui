/**
 * HTTP-роуты «Продолжить в новом чате».
 *
 * POST ставит задачу собрать выжимку чата и сразу отвечает: модель пишет её
 * до пары минут, а прокси и телефон столько не держат запрос. GET отдаёт
 * состояние задачи — кнопка опрашивает его, пока выжимка не готова.
 * Всё в рамках аккаунта запроса: чужой чат не найти и не прочитать.
 */
import express from 'express';

import { getHandoff, HandoffError, prepareHandoff, startHandoff, type HandoffJob } from '@/modules/handoff/handoff.service.js';

const router = express.Router();

function present(job: HandoffJob) {
  return {
    success: true,
    status: job.status,
    message: job.status === 'done' ? job.message : undefined,
    error: job.status === 'error' ? job.error : undefined,
    projectPath: job.projectPath ?? null,
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    fromPrepared: Boolean(job.fromPrepared),
  };
}

/** Сколько POST ждёт готовности: из заготовки выжимка собирается за секунду — сразу и отдаём. */
const QUICK_WAIT_MS = 2500;

router.post('/:sessionId', async (req, res) => {
  try {
    const job = await startHandoff(String(req.params.sessionId), undefined, req.body?.goal);
    if (job.status === 'running' && job.settled) {
      await Promise.race([job.settled, new Promise((resolve) => setTimeout(resolve, QUICK_WAIT_MS))]);
    }
    return res.status(job.status === 'running' ? 202 : 200).json(present(job));
  } catch (error) {
    if (error instanceof HandoffError) return res.status(error.status).json({ error: error.message });
    console.error('[handoff] не удалось начать перенос:', error);
    return res.status(500).json({ error: 'не удалось начать перенос' });
  }
});

/**
 * Заготовка выжимки фоном: вкладка зовёт, когда чат переходит на новый
 * десяток процентов окна, начиная с половины (кнопка в этот момент желтеет).
 */
router.post('/:sessionId/prepare', async (req, res) => {
  try {
    const step = Math.max(0, Math.min(10, Math.floor(Number(req.body?.step) || 0)));
    const result = await prepareHandoff(String(req.params.sessionId), step);
    return res.status(202).json({ success: true, ...result });
  } catch (error) {
    if (error instanceof HandoffError) return res.status(error.status).json({ error: error.message });
    console.error('[handoff] не удалось начать заготовку:', error);
    return res.status(500).json({ error: 'не удалось начать заготовку' });
  }
});

router.get('/:sessionId', (req, res) => {
  const job = getHandoff(String(req.params.sessionId));
  if (!job) return res.status(404).json({ error: 'переноса для этого чата нет' });
  return res.json(present(job));
});

export default router;

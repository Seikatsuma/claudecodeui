import express from 'express';

import type { createUserService } from './user.service.js';

type AuthenticatedRequest = express.Request & { user?: { id?: number | string } };

function readUserId(request: express.Request): number {
  const rawUserId = (request as AuthenticatedRequest).user?.id;
  return Number(rawUserId);
}

/** Creates thin user routes that parse authenticated input and call the service. */
export function createUserRouter(service: ReturnType<typeof createUserService>): express.Router {
  const router = express.Router();

  router.get('/git-config', async (req, res, next) => {
    try {
      res.json(await service.getGitConfig(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/git-config', async (req, res, next) => {
    try {
      const body = req.body as { gitName?: unknown; gitEmail?: unknown };
      res.json(await service.updateGitConfig(readUserId(req), body.gitName, body.gitEmail));
    } catch (error) {
      next(error);
    }
  });

  router.post('/complete-onboarding', (req, res, next) => {
    try {
      res.json(service.completeOnboarding(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  router.get('/onboarding-status', (req, res, next) => {
    try {
      res.json(service.getOnboardingStatus(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  // Важные этапы среди мыслей «Хода работы» по-русски, входом того, кто смотрит.
  router.post('/thought-digest', async (req, res, next) => {
    try {
      const body = req.body as { texts?: unknown };
      res.json(await service.digestThoughts(readUserId(req), body.texts));
    } catch (error) {
      next(error);
    }
  });

  // Замер экрана телефона при открытой клавиатуре — только в журнал службы.
  // iOS сообщает размеры видимой области по-разному в браузере и в приложении
  // с экрана «Домой», эмулятор на сервере это не повторяет (16.09.26).
  router.post('/viewport-probe', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const numbers: Record<string, number | boolean | string> = {};
    for (const [key, value] of Object.entries(body).slice(0, 40)) {
      if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = Math.round(value * 10) / 10;
      else if (typeof value === 'boolean') numbers[key] = value;
      else if (typeof value === 'string') numbers[key] = value.slice(0, 40);
    }
    console.log(`[viewport-probe] user=${readUserId(req)} ${JSON.stringify(numbers)}`);
    res.json({ ok: true });
  });

  // Догрузка хвоста чата после возврата из фона, переподключения, конца хода —
  // только в журнал службы (`[catchup-probe]`). Застывший экран на iPhone в
  // эмуляторе не повторился (22.09.26): ищем причину по данным с телефона.
  router.post('/catchup-probe', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields: Record<string, number | boolean | string> = {};
    for (const [key, value] of Object.entries(body).slice(0, 20)) {
      if (typeof value === 'number' && Number.isFinite(value)) fields[key] = Math.round(value);
      else if (typeof value === 'boolean') fields[key] = value;
      else if (typeof value === 'string') fields[key] = value.slice(0, 80);
    }
    console.log(`[catchup-probe] user=${readUserId(req)} ${JSON.stringify(fields)}`);
    res.json({ ok: true });
  });

  // Сбой запуска страницы на телефоне — только в журнал службы (`[boot-probe]`).
  // Белый экран на iPhone (25.09.26) не оставлял следа: страница не дошла до
  // подключения, а сервер об этом не знал. Страховка в index.html шлёт сюда, что
  // случилось — упала программа, не загрузился файл, телефон выгрузил страницу.
  // Ключ входа приходит в адресе: в момент сбоя страница шлёт маяком без заголовков.
  router.post('/boot-probe', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields: Record<string, number | boolean | string | string[]> = {};
    for (const [key, value] of Object.entries(body).slice(0, 30)) {
      if (typeof value === 'number' && Number.isFinite(value)) fields[key] = Math.round(value);
      else if (typeof value === 'boolean') fields[key] = value;
      else if (typeof value === 'string') fields[key] = value.slice(0, 300);
      else if (Array.isArray(value)) fields[key] = value.slice(0, 8).map((item) => String(item).slice(0, 300));
    }
    console.log(`[boot-probe] user=${readUserId(req)} ${JSON.stringify(fields)}`);
    res.json({ ok: true });
  });

  router.get('/usage-limits', async (req, res, next) => {
    try {
      res.json(await service.getUsageLimits(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  router.get('/owner-account-info', async (req, res, next) => {
    try {
      res.json(await service.getOwnerAccountEmail(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  // Platform-owner-only: list both Claude account slots with their email and
  // availability. Non-owners receive an empty accounts list (not an error).
  router.get('/owner-accounts', async (req, res, next) => {
    try {
      res.json(await service.getOwnerAccounts(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  // Platform-owner-only: switch the active account slot. Body: { slot: 1 | 2 }.
  // Validates that the target slot is available before persisting.
  router.post('/owner-accounts/activate', async (req, res, next) => {
    try {
      const body = req.body as { slot?: unknown };
      res.json(await service.activateOwnerAccount(readUserId(req), body.slot));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

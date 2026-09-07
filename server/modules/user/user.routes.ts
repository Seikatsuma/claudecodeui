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

  router.get('/usage-limits', async (req, res, next) => {
    try {
      res.json(await service.getUsageLimits());
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

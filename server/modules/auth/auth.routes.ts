import express from 'express';
import type { RequestHandler } from 'express';

import { AppError } from '@/shared/utils.js';

import type { createAuthService } from './auth.service.js';

type AuthenticatedRequest = express.Request & { user?: unknown };

/**
 * Creates the Auth transport adapter. Handlers only parse request data and
 * delegate authentication behavior to the injected application service.
 */
export function createAuthRouter(
  service: ReturnType<typeof createAuthService>,
  authenticateToken: RequestHandler,
): express.Router {
  const router = express.Router();

  router.get('/status', (_req, res, next) => {
    try {
      res.json(service.getStatus());
    } catch (error) {
      next(error);
    }
  });

  router.post('/register', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.register(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  // --- OPEN_REGISTRATION-only routes below. Each one 403s via AppError
  // (OPEN_REGISTRATION_DISABLED) on every other install, so mounting them
  // unconditionally cannot change Account 1/2's behavior. ---

  router.post('/register-open', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown };
      res.json(await service.registerOpen(body.username));
    } catch (error) {
      next(error);
    }
  });

  router.post('/enter', async (req, res, next) => {
    try {
      const body = req.body as { token?: unknown };
      res.json(await service.enterWithLoginToken(body.token));
    } catch (error) {
      next(error);
    }
  });

  router.get('/login-link', authenticateToken, (req, res, next) => {
    try {
      res.json(service.getLoginLink((req as AuthenticatedRequest).user));
    } catch (error) {
      next(error);
    }
  });

  router.post('/regenerate-login-link', authenticateToken, (req, res, next) => {
    try {
      res.json(service.regenerateLoginLink((req as AuthenticatedRequest).user));
    } catch (error) {
      next(error);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      // req.ip falls back to the socket address when no trust proxy is
      // configured, which matches this deployment (no reverse proxy yet).
      const ip = req.ip ?? 'unknown';
      res.json(await service.login(body.username, body.password, ip));
    } catch (error) {
      if (error instanceof AppError && error.code === 'AUTH_RATE_LIMITED') {
        const details = error.details as { retryAfterSeconds?: number } | undefined;
        if (details?.retryAfterSeconds) {
          res.setHeader('Retry-After', String(details.retryAfterSeconds));
        }
      }
      next(error);
    }
  });

  router.get('/user', authenticateToken, (req, res) => {
    res.json(service.getCurrentUser((req as AuthenticatedRequest).user));
  });

  router.post('/refresh', authenticateToken, (req, res) => {
    res.json(service.refreshSession((req as AuthenticatedRequest).user));
  });

  router.post('/logout', authenticateToken, (_req, res) => {
    res.json(service.logout());
  });

  return router;
}

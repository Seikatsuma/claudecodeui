/**
 * Populates the AsyncLocalStorage-based request runtime context (see
 * shared/request-context.ts) for every authenticated HTTP request on an
 * OPEN_REGISTRATION instance, so downstream code (getClaudeConfigDir(),
 * getWorkspacesRoot(), the Claude SDK env builder) resolves THIS request's
 * own user instead of one process-wide value.
 *
 * Mount this AFTER authenticateToken - it reads `req.user`, which
 * authenticateToken is what populates. On every other install
 * (OPEN_REGISTRATION unset/false, which includes Account 1/2) this is a
 * plain pass-through: it calls next() directly without ever touching
 * AsyncLocalStorage, so getClaudeConfigDir() etc. keep resolving from
 * process.env exactly as before.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { credentialsDb, userDb } from '@/modules/database/index.js';
import { getWebUserClaudeConfigDir, getWebUserWorkspaceRoot } from '@/shared/web-user-paths.js';
import { isPlatformOwnerWebUser, OPEN_REGISTRATION } from '@/shared/utils.js';
import { runWithRequestRuntimeContext } from '@/shared/request-context.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

const ANTHROPIC_API_KEY_CREDENTIAL_TYPE = 'anthropic_api_key';

export const requestRuntimeContextMiddleware: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  if (!OPEN_REGISTRATION) {
    next();
    return;
  }

  const userId = (req as AuthenticatedRequest).user?.id;
  if (userId === undefined || userId === null) {
    next();
    return;
  }

  const numericUserId = Number(userId);
  const anthropicApiKey = Number.isFinite(numericUserId)
    ? credentialsDb.getActiveCredential(numericUserId, ANTHROPIC_API_KEY_CREDENTIAL_TYPE)
    : null;

  // For the platform owner, resolve which account slot they've selected so
  // that ALL subsequent request handlers (REST, settings, email-display,
  // project-listing) see the correct claudeConfigDir without any additional
  // per-handler logic. BYOK users are unaffected: slot concept is irrelevant
  // for them and they always resolve to their single ~/.claude-webuser-<id>.
  const ownerSlot =
    Number.isFinite(numericUserId) && isPlatformOwnerWebUser(numericUserId)
      ? userDb.getActiveOwnerAccountSlot(numericUserId)
      : undefined;

  runWithRequestRuntimeContext(
    {
      userId,
      claudeConfigDir: getWebUserClaudeConfigDir(userId, ownerSlot),
      workspaceRoot: getWebUserWorkspaceRoot(userId),
      anthropicApiKey,
    },
    next,
  );
};

import crypto from 'node:crypto';
import { createRequire } from 'node:module';

import { getConnection, invitesDb, userDb } from '@/modules/database/index.js';
import { OPEN_REGISTRATION } from '@/shared/utils.js';
import { ensureWebUserDirectories } from '@/shared/web-user-paths.js';

import { authenticateToken, generateToken } from './auth.middleware.js';
import { createAuthRouter } from './auth.routes.js';
import { createAuthService } from './auth.service.js';
import { createLoginRateLimiter } from './login-rate-limiter.js';

/** Generates a random password hash input: 32 random bytes, base64url. Kept
 * long/high-entropy since it feeds bcrypt directly, unlike the shareable
 * tokens below which a human actually has to copy/paste or read aloud. */
function generateLoginToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Generates a shorter random token for links a human actually has to copy,
 * paste, or read aloud (personal login links, invite links): 16 random
 * bytes, base64url (~22 chars) instead of the 32-byte (~43 char) token
 * above. Still 128 bits of entropy (unguessable), but materially less
 * likely to get truncated or mangled when copied through a messaging app -
 * convenience over security is deliberate here, per this instance's
 * zero-friction design (see PLATFORM_OWNER_WEB_USER_IDS elsewhere).
 */
function generateShareableToken(): string {
  return crypto.randomBytes(16).toString('base64url');
}

type BcryptAdapter = {
  hash(password: string, saltRounds: number): Promise<string>;
  compare(password: string, passwordHash: string): Promise<boolean>;
};

// bcrypt does not ship TypeScript declarations in this project, so the
// composition root narrows its CommonJS runtime surface before injecting it.
const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt') as BcryptAdapter;
const databaseConnection = getConnection();

const authService = createAuthService({
  users: {
    hasUsers: () => userDb.hasUsers(),
    createUser: (username, passwordHash) => userDb.createUser(username, passwordHash),
    getUserByUsername: (username) => userDb.getUserByUsername(username),
    updateLastLogin: (userId) => userDb.updateLastLogin(userId),
    createUserWithLoginToken: (username, passwordHash, loginToken) =>
      userDb.createUserWithLoginToken(username, passwordHash, loginToken),
    getUserByLoginToken: (loginToken) => userDb.getUserByLoginToken(loginToken),
    setLoginToken: (userId, loginToken) => userDb.setLoginToken(userId, loginToken),
    getLoginToken: (userId) => userDb.getLoginToken(userId),
  },
  invites: {
    createInvite: (token, createdByUserId, label) => invitesDb.createInvite(token, createdByUserId, label),
    getInviteByToken: (token) => invitesDb.getInviteByToken(token),
    claimInvite: (token, usedByUserId) => invitesDb.claimInvite(token, usedByUserId),
    listInvitesByCreator: (createdByUserId) => invitesDb.listInvitesByCreator(createdByUserId),
  },
  transaction: {
    begin: () => databaseConnection.prepare('BEGIN').run(),
    commit: () => databaseConnection.prepare('COMMIT').run(),
    rollback: () => databaseConnection.prepare('ROLLBACK').run(),
  },
  rateLimiter: createLoginRateLimiter(),
  hashPassword: (password) => bcrypt.hash(password, 12),
  comparePassword: (password, passwordHash) => bcrypt.compare(password, passwordHash),
  generateToken,
  generateLoginToken,
  generateShareableToken,
  provisionWorkspace: (userId) => ensureWebUserDirectories(userId),
  openRegistration: OPEN_REGISTRATION,
});

/** Auth router assembled for the server entrypoint. */
export const authRoutes = createAuthRouter(authService, authenticateToken);

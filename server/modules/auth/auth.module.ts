import crypto from 'node:crypto';
import { createRequire } from 'node:module';

import { getConnection, userDb } from '@/modules/database/index.js';
import { OPEN_REGISTRATION } from '@/shared/utils.js';
import { ensureWebUserDirectories } from '@/shared/web-user-paths.js';

import { authenticateToken, generateToken } from './auth.middleware.js';
import { createAuthRouter } from './auth.routes.js';
import { createAuthService } from './auth.service.js';
import { createLoginRateLimiter } from './login-rate-limiter.js';

/** Generates a persistent, unguessable login-link token: 32 random bytes, base64url. */
function generateLoginToken(): string {
  return crypto.randomBytes(32).toString('base64url');
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
  provisionWorkspace: (userId) => ensureWebUserDirectories(userId),
  openRegistration: OPEN_REGISTRATION,
});

/** Auth router assembled for the server entrypoint. */
export const authRoutes = createAuthRouter(authService, authenticateToken);

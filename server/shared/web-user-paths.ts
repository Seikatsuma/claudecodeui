/**
 * Deterministic per-user filesystem layout for OPEN_REGISTRATION instances.
 *
 * Every web user registered on a shared instance gets one root directory,
 * `~/.claude-webuser-<id>/`, created empty on first login. Nothing is stored
 * in the database to point at these paths - they are derived purely from the
 * user's numeric id, the same way `getClaudeConfigDir()` derives Account 1/2's
 * single shared path from `process.env.CLAUDE_CONFIG_DIR`. That keeps the
 * mapping inspectable from the filesystem alone and impossible to drift out
 * of sync with a stored value.
 *
 *   ~/.claude-webuser-<id>/            <- this user's CLAUDE_CONFIG_DIR
 *     settings.json, .credentials.json, projects/, commands/, skills/  (written by the Claude CLI/SDK)
 *     workspace/                       <- this user's project/workspace browsing root
 */

import os from 'node:os';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

function webUserRootDir(userId: number | string): string {
  return path.join(os.homedir(), `.claude-webuser-${userId}`);
}

/**
 * This user's own Claude CLI config directory (their CLAUDE_CONFIG_DIR).
 *
 * When `slot` is 2 the directory is `~/.claude-webuser-<id>-account2` instead
 * of the default `~/.claude-webuser-<id>`. This lets the platform owner (the
 * one user whose id appears in PLATFORM_OWNER_WEB_USER_IDS) switch between two
 * real Anthropic OAuth sessions without touching non-owner BYOK users, who
 * always use slot 1 (their single directory). The caller is responsible for
 * looking up the active slot from the DB and passing it in — this function
 * stays a pure path deriver with no DB access.
 */
export function getWebUserClaudeConfigDir(userId: number | string, slot?: number): string {
  if (slot === 2) {
    return path.join(os.homedir(), `.claude-webuser-${userId}-account2`);
  }
  return webUserRootDir(userId);
}

/** This user's own project/workspace browsing root (their WORKSPACES_ROOT). */
export function getWebUserWorkspaceRoot(userId: number | string): string {
  return path.join(webUserRootDir(userId), 'workspace');
}

/**
 * Creates this user's config and workspace directories if they do not exist
 * yet. Called once on registration/first login so a brand-new account always
 * has an empty, ready-to-use workspace rather than erroring on first use.
 */
export async function ensureWebUserDirectories(userId: number | string): Promise<void> {
  await fsPromises.mkdir(getWebUserClaudeConfigDir(userId), { recursive: true });
  await fsPromises.mkdir(getWebUserWorkspaceRoot(userId), { recursive: true });
}

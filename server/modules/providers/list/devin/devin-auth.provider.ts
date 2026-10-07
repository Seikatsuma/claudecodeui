import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';

import spawn from 'cross-spawn';

import { DEVIN_SLOT2_DATA_HOME } from '@/shared/devin-slots.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { getDevinDataDir, resolveDevinCliCommand } from '@/shared/utils.js';

/**
 * Auth facet for Devin CLI.
 *
 * Devin keeps a single machine-wide credential at
 * `~/.local/share/devin/credentials.toml`, installed by `devin auth login`.
 * There is no per-web-user Devin account — the provider is gated to the
 * platform owner, so this status only ever describes the owner's machine
 * login. Credentials are never read beyond existence, and never returned.
 */
export class DevinProviderAuth implements IProviderAuth {
  private checkInstalled(): boolean {
    try {
      const result = spawn.sync(resolveDevinCliCommand(), ['--version'], {
        stdio: 'ignore',
        timeout: 5000,
      });
      return !result.error && result.status === 0;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    const hasCredentials = [getDevinDataDir(), path.join(DEVIN_SLOT2_DATA_HOME, 'devin')]
      .some((dir) => this.checkCredentialsFile(path.join(dir, 'credentials.toml')));
    const orgId = this.readOrgId();

    return {
      installed,
      provider: 'devin',
      authenticated: hasCredentials,
      email: orgId,
      method: hasCredentials ? 'devin_cli' : null,
      error: hasCredentials
        ? undefined
        : installed ? 'Devin CLI not authenticated (run "devin auth login")' : 'Devin CLI not installed',
    };
  }

  private checkCredentialsFile(credentialsPath: string): boolean {
    try {
      const stat = fsSync.statSync(credentialsPath);
      // An empty placeholder file counts as not authenticated.
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }

  /** The configured Devin org id from `~/.config/devin/config.json` — a label, not a secret. */
  private readOrgId(): string | null {
    try {
      const configPath = path.join(os.homedir(), '.config', 'devin', 'config.json');
      const config = JSON.parse(fsSync.readFileSync(configPath, 'utf8'));
      const orgId = config?.devin?.org_id;
      return typeof orgId === 'string' && orgId ? orgId : null;
    } catch {
      return null;
    }
  }
}

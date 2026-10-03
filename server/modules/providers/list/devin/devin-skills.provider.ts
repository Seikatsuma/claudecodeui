import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import {
  addUniqueProviderSkillSource,
  findTopmostGitRoot,
} from '@/shared/utils.js';

/**
 * Devin skill directories (`devin skills paths`, CLI 3000.11):
 *
 *   user:    ~/.config/devin/skills, ~/.config/cognition/skills, ~/.agents/skills
 *   project: <repo>/.devin/skills, <repo>/.cognition/skills, <repo>/.agents/skills
 *
 * Skills are invoked with the `/name` prefix.
 */
export class DevinSkillsProvider extends SkillsProvider {
  constructor() {
    super('devin');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();
    const repoRoot = await findTopmostGitRoot(workspacePath);

    const projectDirs = repoRoot
      ? [workspacePath, repoRoot]
      : [workspacePath];
    for (const dir of new Set(projectDirs)) {
      for (const vendorDir of ['.devin', '.cognition', '.agents']) {
        addUniqueProviderSkillSource(sources, seenRootDirs, {
          scope: 'repo',
          rootDir: path.join(dir, vendorDir, 'skills'),
          commandPrefix: '/',
        });
      }
    }

    for (const rootDir of [
      path.join(os.homedir(), '.config', 'devin', 'skills'),
      path.join(os.homedir(), '.config', 'cognition', 'skills'),
      path.join(os.homedir(), '.agents', 'skills'),
    ]) {
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'user',
        rootDir,
        commandPrefix: '/',
      });
    }

    return sources;
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.config', 'devin', 'skills'),
      commandPrefix: '/',
    };
  }
}

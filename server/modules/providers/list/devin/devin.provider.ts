import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import type {
  IProviderAuth,
  IProviderMcp,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionSynchronizer,
  IProviderSessions,
  IProviderSkills,
} from '@/shared/interfaces.js';
import { DevinProviderAuth } from '@/modules/providers/list/devin/devin-auth.provider.js';
import { DevinMcpProvider } from '@/modules/providers/list/devin/devin-mcp.provider.js';
import { DevinModelsProvider } from '@/modules/providers/list/devin/devin-models.provider.js';
import { devinRuntime } from '@/modules/providers/list/devin/devin-runtime.provider.js';
import { DevinSessionSynchronizer } from '@/modules/providers/list/devin/devin-session-synchronizer.provider.js';
import { DevinSessionsProvider } from '@/modules/providers/list/devin/devin-sessions.provider.js';
import { DevinSkillsProvider } from '@/modules/providers/list/devin/devin-skills.provider.js';

/**
 * Devin (Cognition) provider.
 *
 * Talks to `devin acp` — Devin CLI's Agent Client Protocol endpoint — one
 * child process per turn. Sessions persist inside Devin's shared
 * `~/.local/share/devin/cli/sessions.db` and resume across processes via
 * `session/load`.
 *
 * Access note: Devin credentials are machine-global (one login per host), so
 * the provider is owner-only — enforced in provider routes and the chat
 * websocket gateway, not here.
 */
export class DevinProvider extends AbstractProvider {
  readonly runtime: IProviderRuntime = devinRuntime;
  readonly auth: IProviderAuth = new DevinProviderAuth();
  readonly models: IProviderModels = new DevinModelsProvider();
  readonly mcp: IProviderMcp = new DevinMcpProvider();
  readonly skills: IProviderSkills = new DevinSkillsProvider();
  readonly sessions: IProviderSessions = new DevinSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new DevinSessionSynchronizer();

  constructor() {
    super('devin');
  }
}

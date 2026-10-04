// providerRegistry: used by server/index.ts to reach provider runtimes for
// survivor reattach (Devin supervisor links after a service restart).
export { providerRegistry } from './provider.registry.js';

export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { providerMcpService } from './services/mcp.service.js';
export { providerRuntimeService } from './services/provider-runtime.service.js';
// Survivor status: prevents a second run while a detached Claude/Codex process
// from the previous web-server generation still owns the chat.
export {
  getSurvivorPhase,
  getSurvivorProvider,
  isSurvivorRunning,
  listSurvivors,
  stopSurvivor,
} from './list/claude/survivor-runs.js';
export { getLiveLimits, recordRateLimitEvent } from './services/usage-limits.store.js';

// providerModelsService: used by Commands to list models and resolve the active session model.
export { providerModelsService } from './services/provider-models.service.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';
export { broadcastSessionUpserted } from './services/sessions-watcher.service.js';
export { autoGroupProjectSessions } from './services/session-auto-group.service.js';
export { startSessionActivitySync, stopSessionActivitySync } from './services/session-activity-sync.service.js';

// readCodexAccountLimits: used by the user module for the Codex account row and its limits.
export { readCodexAccountLimits } from './services/codex-account-limits.service.js';
// readDevinAccount: used by the user module for the Devin account row in the account menu.
export { readDevinAccount } from './services/devin-account.service.js';
// codexHome / resolveCodexBinary: handoff module writes a Codex-bound brief with Codex itself.
export { codexHome, resolveCodexBinary } from './services/codex-account-limits.service.js';

// Потребитель: `handoff` — «Продолжить в новом чате» выгружает беседу Devin
// построчным файлом формата переписки Claude и скрывает служебные беседы
// разового вызова `devin -p`.
export { exportDevinTranscript } from './list/devin/devin-transcript.js';
export { hideDevinSessionsInDirectory } from './list/devin/devin-chain.js';

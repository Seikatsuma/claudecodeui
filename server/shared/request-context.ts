/**
 * Per-request runtime context for multi-tenant (OPEN_REGISTRATION) instances.
 *
 * Account 1/2 style deployments run one OS process per Claude account, so
 * `CLAUDE_CONFIG_DIR`/`WORKSPACES_ROOT` set once via `process.env` at process
 * start are correct for every request that process ever handles. A shared,
 * open-registration instance serves MANY independent web users from the SAME
 * process, so a single `process.env` value can no longer answer "whose
 * config dir/workspace/API key is this request for?" - that has to be
 * resolved per request instead.
 *
 * `AsyncLocalStorage` carries that per-request answer down through the
 * entire async call graph a request triggers (route handler -> service ->
 * repository -> shared helper) without changing any of those functions'
 * signatures. `getClaudeConfigDir()`/`getClaudeJsonPath()`/`getWorkspacesRoot()`
 * in `shared/utils.ts` check this store FIRST and fall back to the existing
 * `process.env` behavior when it is empty - which is always true for
 * Account 1/2 (nothing ever calls `runWithRequestRuntimeContext` there), so
 * their behavior is provably unchanged.
 *
 * This only covers HTTP request handling. The chat WebSocket's `message`
 * handler runs outside any request's call stack (it fires later, from the
 * event loop, long after the HTTP upgrade request that established the
 * connection returned), so ALS context does not reach it. The chat runtime
 * path resolves per-user config explicitly instead - see
 * `chat-websocket.service.ts` and `claude-runtime.provider.js`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type RequestRuntimeContext = {
  /** The authenticated user's id, or null for unauthenticated/public routes. */
  userId: number | string | null;
  /** This user's own Claude CLI config directory. Unset outside OPEN_REGISTRATION. */
  claudeConfigDir?: string;
  /** This user's own workspace/project browsing root. Unset outside OPEN_REGISTRATION. */
  workspaceRoot?: string;
  /** This user's own Anthropic API key, if they configured one in Settings. */
  anthropicApiKey?: string | null;
};

const requestRuntimeContextStorage = new AsyncLocalStorage<RequestRuntimeContext>();

/** Returns the current request's runtime context, or undefined outside any request. */
export function getRequestRuntimeContext(): RequestRuntimeContext | undefined {
  return requestRuntimeContextStorage.getStore();
}

/** Runs `fn` with `context` available to every function it calls, synchronously or async. */
export function runWithRequestRuntimeContext<T>(context: RequestRuntimeContext, fn: () => T): T {
  return requestRuntimeContextStorage.run(context, fn);
}

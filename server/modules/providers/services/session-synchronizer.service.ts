import { scanStateDb, sessionsDb } from '@/modules/database/index.js';
import { getActiveAccountDir } from '@/shared/session-scope.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider } from '@/shared/types.js';

type SessionSynchronizeResult = {
  processedByProvider: Record<LLMProvider, number>;
  failures: string[];
};

/**
 * Orchestrates provider-specific session indexers and indexed-session lifecycle operations.
 */
export const sessionSynchronizerService = {
  /**
   * Runs all provider synchronizers and advances this account's scan cursor.
   *
   * The cursor is per Claude account, not global. With one shared cursor the
   * first account scanned pushed it to "now", and every other account's
   * transcripts — all older than that — were skipped as already-scanned, so
   * a second account's chat list stayed permanently empty. See
   * ACCOUNT_SCAN_STATE_TABLE_SCHEMA_SQL.
   */
  async synchronizeSessions(): Promise<SessionSynchronizeResult> {
    const accountDir = getActiveAccountDir();
    const lastScanAt = scanStateDb.getLastScannedAtForAccount(accountDir);
    const scanBoundary = new Date();
    const processedByProvider: Record<LLMProvider, number> = {
      claude: 0,
      codex: 0,
      cursor: 0,
      opencode: 0,
    };
    const failures: string[] = [];

    const results = await Promise.allSettled(
      providerRegistry.listProviders().map(async (provider) => ({
        provider: provider.id,
        processed: await provider.sessionSynchronizer.synchronize(lastScanAt ?? undefined),
      }))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        processedByProvider[result.value.provider] = result.value.processed;
        continue;
      }

      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push(reason);
    }

    if (failures.length === 0) {
      scanStateDb.updateLastScannedAtForAccount(accountDir, scanBoundary);
      // Only meaningful right after this account's first full scan, which is
      // the first moment every session has an origin to judge it by.
      const tidied = sessionsDb.archiveAutomatedSessionsOnce(accountDir);
      if (tidied > 0) {
        console.log(`[Sessions] Archived ${tidied} script-launched session(s) for ${accountDir}.`);
      }
    } else {
      console.warn(
        `[Sessions] Skipping scan cursor advance for ${accountDir} because ${failures.length} provider sync(s) failed.`,
      );
    }

    return {
      processedByProvider,
      failures,
    };
  },

  /**
   * Indexes one provider artifact file without running a full provider rescan.
   */
  async synchronizeProviderFile(
    provider: LLMProvider,
    filePath: string
  ): Promise<{ provider: LLMProvider; indexed: boolean; sessionId: string | null }> {
    const resolvedProvider = providerRegistry.resolveProvider(provider);
    const sessionId = await resolvedProvider.sessionSynchronizer.synchronizeFile(filePath);
    return {
      provider,
      indexed: Boolean(sessionId),
      sessionId,
    };
  },
};

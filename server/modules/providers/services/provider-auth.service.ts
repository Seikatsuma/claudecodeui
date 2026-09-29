import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { getRequestRuntimeContext } from '@/shared/request-context.js';
import type { LLMProvider, ProviderAuthStatus } from '@/shared/types.js';
import { isCodexAllowedForWebUser } from '@/shared/utils.js';

export const providerAuthService = {
  /**
   * Resolves a provider and returns its installation/authentication status.
   */
  async getProviderAuthStatus(providerName: string): Promise<ProviderAuthStatus> {
    const provider = providerRegistry.resolveProvider(providerName);
    // Гостю общего экземпляра вход хозяина в Codex не показываем (ни «вошёл»,
    // ни его почту): пользоваться им гость всё равно не может.
    if (providerName === 'codex' && !isCodexAllowedForWebUser(getRequestRuntimeContext()?.userId)) {
      return { installed: false, provider: 'codex', authenticated: false, email: null, method: null, error: 'Codex недоступен для этого аккаунта' };
    }
    return provider.auth.getStatus();
  },

  /**
   * Returns whether a provider runtime appears installed.
   * Falls back to true if status lookup itself fails so callers preserve the
   * original runtime error instead of replacing it with a status-check failure.
   */
  async isProviderInstalled(providerName: LLMProvider): Promise<boolean> {
    try {
      const status = await this.getProviderAuthStatus(providerName);
      return status.installed;
    } catch {
      return true;
    }
  },
};

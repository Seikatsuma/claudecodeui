import { useCallback, useEffect, useState } from 'react';

import { api } from '../../../utils/api';
import { copyTextToClipboard } from '../../../utils/clipboard';

type LoginLinkStatusResponse = {
  loginToken?: string | null;
  error?: string;
};

const buildLoginLink = (loginToken: string): string => `${window.location.origin}/enter/${loginToken}`;

/**
 * Lets an OPEN_REGISTRATION user see their personal login link again (it is
 * only pushed in front of them automatically once, right after registration -
 * see LoginLinkRevealScreen) and regenerate it if they think it leaked.
 * Regenerating invalidates the previous link immediately.
 */
export function useLoginLinkSettings() {
  const [loginLink, setLoginLink] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);

  const loadLoginLink = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await api.auth.getLoginLink();
      const payload = await response.json() as LoginLinkStatusResponse;
      setLoginLink(payload.loginToken ? buildLoginLink(payload.loginToken) : null);
    } catch (error) {
      console.error('Error loading login link:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const copyLoginLink = useCallback(async () => {
    if (!loginLink) {
      return;
    }
    const success = await copyTextToClipboard(loginLink);
    if (success) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  }, [loginLink]);

  const regenerateLink = useCallback(async () => {
    try {
      setIsRegenerating(true);
      setRegenerateError(null);
      const response = await api.auth.regenerateLoginLink();
      const payload = await response.json() as LoginLinkStatusResponse;
      if (!response.ok || !payload.loginToken) {
        setRegenerateError(payload.error || 'Could not regenerate the link.');
        return;
      }
      setLoginLink(buildLoginLink(payload.loginToken));
    } catch (error) {
      console.error('Error regenerating login link:', error);
      setRegenerateError('Could not regenerate the link.');
    } finally {
      setIsRegenerating(false);
    }
  }, []);

  useEffect(() => {
    void loadLoginLink();
  }, [loadLoginLink]);

  return {
    loginLink,
    isLoading,
    isRegenerating,
    copied,
    regenerateError,
    copyLoginLink,
    regenerateLink,
  };
}

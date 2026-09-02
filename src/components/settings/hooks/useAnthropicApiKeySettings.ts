import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

/**
 * Manages this user's own Anthropic API key on an OPEN_REGISTRATION instance
 * (see server/modules/websocket/services/chat-websocket.service.ts and
 * claude-runtime.provider.js, which read it via credentialsDb using this
 * exact credential type). Built on the generic per-user credential store
 * (`/api/settings/credentials`) rather than a dedicated endpoint - no backend
 * change was needed for storage, only "keep at most one" semantics here:
 * saving a new key deletes whichever credential row already held one first.
 */

const CREDENTIAL_TYPE = 'anthropic_api_key';
const CREDENTIAL_NAME = 'Anthropic API Key';

type CredentialListItem = {
  id: string | number;
  credential_type: string;
  created_at: string;
};

type CredentialsListResponse = {
  credentials?: CredentialListItem[];
  error?: string;
};

type CredentialWriteResponse = {
  success?: boolean;
  error?: string;
};

type SaveStatus = 'success' | 'error' | null;

export function useAnthropicApiKeySettings() {
  const [isConfigured, setIsConfigured] = useState(false);
  const [configuredAt, setConfiguredAt] = useState<string | null>(null);
  const [existingCredentialId, setExistingCredentialId] = useState<string | number | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(null);
  const clearStatusTimerRef = useRef<number | null>(null);

  const scheduleStatusClear = useCallback((status: SaveStatus) => {
    setSaveStatus(status);
    if (clearStatusTimerRef.current !== null) {
      window.clearTimeout(clearStatusTimerRef.current);
    }
    clearStatusTimerRef.current = window.setTimeout(() => {
      setSaveStatus(null);
      clearStatusTimerRef.current = null;
    }, 3000);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await authenticatedFetch(`/api/settings/credentials?type=${CREDENTIAL_TYPE}`);
      const payload = await response.json() as CredentialsListResponse;
      const existing = payload.credentials?.[0] ?? null;
      setIsConfigured(Boolean(existing));
      setConfiguredAt(existing?.created_at ?? null);
      setExistingCredentialId(existing?.id ?? null);
    } catch (error) {
      console.error('Error loading Anthropic API key status:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const saveApiKey = useCallback(async () => {
    const trimmedKey = apiKeyInput.trim();
    if (!trimmedKey) {
      return;
    }

    try {
      setIsSaving(true);

      // Enforce "at most one key" client-side: the underlying store allows
      // several credentials of the same type, but this UI always presents a
      // single active key.
      if (existingCredentialId !== null) {
        await authenticatedFetch(`/api/settings/credentials/${existingCredentialId}`, { method: 'DELETE' });
      }

      const response = await authenticatedFetch('/api/settings/credentials', {
        method: 'POST',
        body: JSON.stringify({
          credentialName: CREDENTIAL_NAME,
          credentialType: CREDENTIAL_TYPE,
          credentialValue: trimmedKey,
        }),
      });

      const payload = await response.json() as CredentialWriteResponse;
      if (!response.ok || !payload.success) {
        console.error('Error saving Anthropic API key:', payload.error);
        scheduleStatusClear('error');
        return;
      }

      setApiKeyInput('');
      scheduleStatusClear('success');
      await loadStatus();
    } catch (error) {
      console.error('Error saving Anthropic API key:', error);
      scheduleStatusClear('error');
    } finally {
      setIsSaving(false);
    }
  }, [apiKeyInput, existingCredentialId, loadStatus, scheduleStatusClear]);

  const removeApiKey = useCallback(async () => {
    if (existingCredentialId === null) {
      return;
    }

    try {
      setIsSaving(true);
      await authenticatedFetch(`/api/settings/credentials/${existingCredentialId}`, { method: 'DELETE' });
      await loadStatus();
    } catch (error) {
      console.error('Error removing Anthropic API key:', error);
    } finally {
      setIsSaving(false);
    }
  }, [existingCredentialId, loadStatus]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => () => {
    if (clearStatusTimerRef.current !== null) {
      window.clearTimeout(clearStatusTimerRef.current);
    }
  }, []);

  return {
    isConfigured,
    configuredAt,
    apiKeyInput,
    setApiKeyInput,
    isLoading,
    isSaving,
    saveStatus,
    saveApiKey,
    removeApiKey,
  };
}

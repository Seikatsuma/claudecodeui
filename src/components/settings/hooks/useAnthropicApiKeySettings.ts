import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

/**
 * Manages this user's Anthropic API key "connections" on an OPEN_REGISTRATION
 * instance (see server/modules/websocket/services/chat-websocket.service.ts
 * and claude-runtime.provider.js, which read the active one via
 * credentialsDb.getActiveCredential() using this exact credential type).
 *
 * A user can hold up to two connections (hard-capped server-side too, see
 * settings.service.ts's createAnthropicApiKey), exactly one of which is
 * "active" at a time - that's the one the next chat turn's SDK call uses.
 * Switching which one is active never touches chat history, only which key
 * future turns resolve.
 *
 * Built on a small set of dedicated endpoints
 * (`/api/settings/anthropic-keys*`) layered on the generic per-user
 * credential store rather than a new table - see settings.service.ts for the
 * cap + exclusive-active-slot business rules.
 */

export const MAX_ANTHROPIC_API_KEYS = 2;

type AnthropicKeyItem = {
  id: string | number;
  credential_name: string;
  created_at: string;
  is_active: number | boolean;
  value_preview: string;
};

type AnthropicKeysListResponse = {
  keys?: AnthropicKeyItem[];
  error?: string;
};

type AnthropicKeyWriteResponse = {
  success?: boolean;
  error?: string;
};

type SaveStatus = 'success' | 'error' | null;

export function useAnthropicApiKeySettings() {
  const [keys, setKeys] = useState<AnthropicKeyItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  // Id of the connection whose activate/delete button is mid-request - only
  // that row shows a busy state rather than freezing the whole list.
  const [pendingId, setPendingId] = useState<string | number | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
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

  const loadKeys = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await authenticatedFetch('/api/settings/anthropic-keys');
      const payload = await response.json() as AnthropicKeysListResponse;
      setKeys(payload.keys || []);
    } catch (error) {
      console.error('Error loading Anthropic API keys:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const addKey = useCallback(async () => {
    const trimmedKey = apiKeyInput.trim();
    if (!trimmedKey || keys.length >= MAX_ANTHROPIC_API_KEYS) {
      return;
    }

    try {
      setIsSaving(true);
      setErrorMessage(null);

      const response = await authenticatedFetch('/api/settings/anthropic-keys', {
        method: 'POST',
        body: JSON.stringify({
          label: newKeyLabel.trim(),
          apiKey: trimmedKey,
        }),
      });

      const payload = await response.json() as AnthropicKeyWriteResponse;
      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error || null);
        scheduleStatusClear('error');
        return;
      }

      setApiKeyInput('');
      setNewKeyLabel('');
      setShowAddForm(false);
      scheduleStatusClear('success');
      await loadKeys();
    } catch (error) {
      console.error('Error saving Anthropic API key:', error);
      scheduleStatusClear('error');
    } finally {
      setIsSaving(false);
    }
  }, [apiKeyInput, keys.length, loadKeys, newKeyLabel, scheduleStatusClear]);

  const removeKey = useCallback(async (credentialId: string | number) => {
    try {
      setPendingId(credentialId);
      await authenticatedFetch(`/api/settings/anthropic-keys/${credentialId}`, { method: 'DELETE' });
      await loadKeys();
    } catch (error) {
      console.error('Error removing Anthropic API key:', error);
    } finally {
      setPendingId(null);
    }
  }, [loadKeys]);

  const activateKey = useCallback(async (credentialId: string | number) => {
    try {
      setPendingId(credentialId);
      await authenticatedFetch(`/api/settings/anthropic-keys/${credentialId}/activate`, { method: 'PATCH' });
      await loadKeys();
    } catch (error) {
      console.error('Error activating Anthropic API key:', error);
    } finally {
      setPendingId(null);
    }
  }, [loadKeys]);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  useEffect(() => () => {
    if (clearStatusTimerRef.current !== null) {
      window.clearTimeout(clearStatusTimerRef.current);
    }
  }, []);

  return {
    keys,
    isLoading,
    canAddMore: keys.length < MAX_ANTHROPIC_API_KEYS,
    showAddForm,
    setShowAddForm,
    newKeyLabel,
    setNewKeyLabel,
    apiKeyInput,
    setApiKeyInput,
    isSaving,
    pendingId,
    saveStatus,
    errorMessage,
    addKey,
    removeKey,
    activateKey,
  };
}

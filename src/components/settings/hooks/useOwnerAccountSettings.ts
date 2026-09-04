import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

type OwnerAccountInfo = {
  slot: number;
  email: string | null;
  available: boolean;
};

type OwnerAccountsResponse = {
  success: boolean;
  activeSlot: number | null;
  accounts: OwnerAccountInfo[];
};

type State = {
  isLoading: boolean;
  activeSlot: number | null;
  accounts: OwnerAccountInfo[];
  pendingSlot: number | null;
  errorMessage: string | null;
};

const INITIAL_STATE: State = {
  isLoading: true,
  activeSlot: null,
  accounts: [],
  pendingSlot: null,
  errorMessage: null,
};

/**
 * Manages the platform-owner-only "Your Claude Accounts" UI.
 *
 * Fetches from GET /api/user/owner-accounts (returns an empty accounts list
 * for non-owner users so the component that calls this hook can gate on
 * `accounts.length > 0`).  After a successful slot switch the page is
 * reloaded so the sidebar email badge reflects the new account immediately.
 */
export function useOwnerAccountSettings() {
  const [state, setState] = useState<State>(INITIAL_STATE);

  const fetchAccounts = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true, errorMessage: null }));
    try {
      const response = await authenticatedFetch('/api/user/owner-accounts');
      if (!response.ok) {
        setState((prev) => ({ ...prev, isLoading: false }));
        return;
      }
      const data = (await response.json()) as OwnerAccountsResponse;
      setState({
        isLoading: false,
        activeSlot: data.activeSlot,
        accounts: data.accounts ?? [],
        pendingSlot: null,
        errorMessage: null,
      });
    } catch {
      setState((prev) => ({ ...prev, isLoading: false }));
    }
  }, []);

  useEffect(() => {
    void fetchAccounts();
  }, [fetchAccounts]);

  const activateSlot = useCallback(async (slot: number) => {
    setState((prev) => ({ ...prev, pendingSlot: slot, errorMessage: null }));
    try {
      const response = await authenticatedFetch('/api/user/owner-accounts/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot }),
      });
      const data = (await response.json()) as OwnerAccountsResponse & { error?: string };
      if (!response.ok || !data.success) {
        setState((prev) => ({
          ...prev,
          pendingSlot: null,
          errorMessage: data.error ?? 'Could not switch account. Please try again.',
        }));
        return;
      }
      // Reload so the sidebar email badge and all per-request contexts refresh.
      window.location.reload();
    } catch {
      setState((prev) => ({
        ...prev,
        pendingSlot: null,
        errorMessage: 'Network error while switching account.',
      }));
    }
  }, []);

  return {
    isLoading: state.isLoading,
    activeSlot: state.activeSlot,
    accounts: state.accounts,
    pendingSlot: state.pendingSlot,
    errorMessage: state.errorMessage,
    activateSlot,
  };
}

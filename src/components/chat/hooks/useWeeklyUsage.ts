import { useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

export type WeeklyUsageOfficial = {
  percent: number;
  resetsAt: string | null;
  severity: string | null;
  fetchedAt: string;
};

export type WeeklyUsageEstimate = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  windowStart: string;
  windowEnd: string;
  computedAt: string;
};

export type WeeklyUsageSnapshot = {
  official: WeeklyUsageOfficial | null;
  estimate: WeeklyUsageEstimate | null;
};

// The backend's own token-estimate cache lives for 15 minutes and the
// official figure is itself a CLI-refreshed cache that rarely changes within
// a session - polling faster would just repeat the same numbers.
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Fetches the account-wide weekly usage snapshot backing the composer's
 * always-visible usage indicator (see `provider.routes.ts`'s
 * `GET /api/providers/usage/weekly`). Self-contained: polls on an interval
 * so the indicator stays live without any session/provider context from its
 * caller.
 */
export function useWeeklyUsage() {
  const [snapshot, setSnapshot] = useState<WeeklyUsageSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const fetchSnapshot = async () => {
      try {
        const response = await authenticatedFetch('/api/providers/usage/weekly');
        if (!response.ok) {
          return;
        }
        const payload = await response.json();
        if (mountedRef.current) {
          setSnapshot(payload.data ?? null);
        }
      } catch (error) {
        console.error('Failed to fetch weekly usage:', error);
      } finally {
        if (mountedRef.current) {
          setIsLoading(false);
        }
      }
    };

    fetchSnapshot();
    const intervalId = setInterval(fetchSnapshot, REFRESH_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      clearInterval(intervalId);
    };
  }, []);

  return { snapshot, isLoading };
}

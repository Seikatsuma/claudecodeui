import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../utils/api';

type BrowserUseSettingsApiPayload = {
  success?: boolean;
  data?: {
    settings?: {
      enabled?: boolean;
    };
  };
};

/**
 * Whether the "Browser" workspace tab should be offered. Lifted out of
 * MainContent so both the main content tab switcher (now living in the
 * sidebar) and the sidebar itself can gate the "browser" tab from a single
 * fetch instead of polling the settings endpoint twice.
 */
export function useBrowserUseEnabled(): boolean {
  const [browserUseEnabled, setBrowserUseEnabled] = useState(false);

  const loadBrowserUseSettings = useCallback(async () => {
    try {
      const response = await authenticatedFetch('/api/browser-use/settings');
      const data = (await response.json()) as BrowserUseSettingsApiPayload;
      setBrowserUseEnabled(Boolean(response.ok && data?.success !== false && data?.data?.settings?.enabled));
    } catch {
      setBrowserUseEnabled(false);
    }
  }, []);

  useEffect(() => {
    void loadBrowserUseSettings();
    window.addEventListener('browserUseSettingsChanged', loadBrowserUseSettings);
    return () => window.removeEventListener('browserUseSettingsChanged', loadBrowserUseSettings);
  }, [loadBrowserUseSettings]);

  return browserUseEnabled;
}

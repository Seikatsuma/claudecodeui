import { useState, useEffect } from 'react';
import { version } from '../../package.json';
import { ReleaseInfo } from '../shared/types';

export type InstallMode = 'git' | 'npm';

export const useVersionCheck = () => {
  // Always empty: the upstream release check that used to populate these was
  // removed (see the note further down), so the update banner never shows.
  const updateAvailable = false;
  const latestVersion: string | null = null;
  const releaseInfo: ReleaseInfo | null = null;
  const [installMode, setInstallMode] = useState<InstallMode>('git');
  const [runningVersion, setRunningVersion] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  // Multi-account labeling (optional, off by default): set on the server via the
  // ACCOUNT_LABEL / SWITCH_ACCOUNT_URL env vars when running several instances of
  // this app side by side, one per account. null means "not configured" - the
  // sidebar renders nothing for either in that case.
  const [accountLabel, setAccountLabel] = useState<string | null>(null);
  const [switchAccountUrl, setSwitchAccountUrl] = useState<string | null>(null);
  // Real Claude account email for this instance (read server-side from
  // CLAUDE_CONFIG_DIR/.claude.json's oauthAccount.emailAddress - see
  // server/index.ts). null when unreadable/unset, same as the two above.
  const [accountEmail, setAccountEmail] = useState<string | null>(null);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const response = await fetch('/health');
        const data = await response.json();
        if (data.installMode === 'npm' || data.installMode === 'git') {
          setInstallMode(data.installMode);
        }
        // `data.version` is the version the server process is actually running.
        // This module's `version` is baked into the frontend bundle at build
        // time, so it reflects the installed (on-disk) package. If they differ,
        // the package was updated but the server process was not restarted, and
        // DB-backed actions may silently fail until it is.
        if (typeof data.version === 'string' && data.version.length > 0) {
          setRunningVersion(data.version);
          setRestartRequired(data.version !== version);
        }
        if (typeof data.accountLabel === 'string' && data.accountLabel.length > 0) {
          setAccountLabel(data.accountLabel);
        }
        if (typeof data.switchAccountUrl === 'string' && data.switchAccountUrl.length > 0) {
          setSwitchAccountUrl(data.switchAccountUrl);
        }
        if (typeof data.accountEmail === 'string' && data.accountEmail.length > 0) {
          setAccountEmail(data.accountEmail);
        }
      } catch {
        // Default to git / no restart hint on error
      }
    };
    fetchHealth();
  }, []);

  // Upstream release-check deliberately removed. It fetched
  // api.github.com/repos/<owner>/<repo>/releases/latest from the user's own
  // browser every 5 minutes to show an "update available" banner for the
  // upstream project. This fork does not track upstream releases, so the
  // banner had nothing useful to say - and the call itself is a third-party
  // request that is frequently slow or unreachable on the networks this
  // instance is actually used from, with no timeout on the fetch. The
  // update-banner state below simply stays empty, so the banner never shows;
  // `owner`/`repo` are kept in the signature so callers need no change.


  return {
    updateAvailable,
    latestVersion,
    currentVersion: version,
    releaseInfo,
    installMode,
    runningVersion,
    restartRequired,
    accountLabel,
    switchAccountUrl,
    accountEmail,
  };
};

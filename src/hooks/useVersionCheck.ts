import { useState, useEffect } from 'react';
import { version } from '../../package.json';
import { ReleaseInfo } from '../shared/types';

/**
 * Compare two semantic version strings
 * Works only with numeric versions separated by dots (e.g. "1.2.3")
 * @param {string} v1 
 * @param {string} v2
 * @returns positive if v1 > v2, negative if v1 < v2, 0 if equal
 */
const compareVersions = (v1: string, v2: string) => {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 !== p2) return p1 - p2;
  }
  return 0;
};

export type InstallMode = 'git' | 'npm';

export const useVersionCheck = (owner: string, repo: string) => {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [releaseInfo, setReleaseInfo] = useState<ReleaseInfo | null>(null);
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

  useEffect(() => {
    const checkVersion = async () => {
      try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
        const data = await response.json();

        // Handle the case where there might not be any releases
        if (data.tag_name) {
          const latest = data.tag_name.replace(/^v/, '');
          setLatestVersion(latest);
          // Only show update if latest version is actually newer
          setUpdateAvailable(compareVersions(latest, version) > 0);

          // Store release information
          setReleaseInfo({
            title: data.name || data.tag_name,
            body: data.body || '',
            htmlUrl: data.html_url || `https://github.com/${owner}/${repo}/releases/latest`,
            publishedAt: data.published_at
          });
        } else {
          // No releases found, don't show update notification
          setUpdateAvailable(false);
          setLatestVersion(null);
          setReleaseInfo(null);
        }
      } catch (error) {
        console.error('Version check failed:', error);
        // On error, don't show update notification
        setUpdateAvailable(false);
        setLatestVersion(null);
        setReleaseInfo(null);
      }
    };

    checkVersion();
    const interval = setInterval(checkVersion, 5 * 60 * 1000); // Check every 5 minutes
    return () => clearInterval(interval);
  }, [owner, repo]);

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

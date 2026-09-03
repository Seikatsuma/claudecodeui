import { Settings, ArrowUpCircle, AlertTriangle, Users, ArrowLeftRight } from 'lucide-react';
import type { TFunction } from 'i18next';

import type { ReleaseInfo } from '../../../../shared/types';

type SidebarFooterProps = {
  updateAvailable: boolean;
  restartRequired: boolean;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  currentVersion: string;
  // Multi-account labeling (both optional, off by default - see server ACCOUNT_LABEL /
  // SWITCH_ACCOUNT_URL env vars). accountLabel null means the badge is hidden entirely;
  // switchAccountUrl null means the badge renders without the "Switch account" link.
  accountLabel: string | null;
  switchAccountUrl: string | null;
  // Real Claude account email for this instance (server-read from
  // CLAUDE_CONFIG_DIR/.claude.json). This is what actually tells two
  // same-labeled instances apart, since accountLabel is just an operator
  // string; null hides it and leaves accountLabel standing alone.
  accountEmail: string | null;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  t: TFunction;
};

export default function SidebarFooter({
  updateAvailable,
  restartRequired,
  releaseInfo,
  latestVersion,
  currentVersion,
  accountLabel,
  switchAccountUrl,
  accountEmail,
  onShowVersionModal,
  onShowSettings,
  t,
}: SidebarFooterProps) {
  return (
    <div className="flex-shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}>
      {/* Restart-required banner: the running server version differs from the
          installed/frontend version (updated but not restarted). */}
      {restartRequired && (
        <>
          <div className="nav-divider" />
          <div className="px-2 py-1.5 md:px-2 md:py-1.5">
            <div className="flex items-center gap-2.5 rounded-lg border border-amber-300/60 bg-amber-50/80 px-2.5 py-2 dark:border-amber-700/40 dark:bg-amber-900/15">
              <AlertTriangle className="h-4 w-4 flex-shrink-0 text-amber-500 dark:text-amber-400" />
              <span className="min-w-0 flex-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                {t('version.restartRequired')}
              </span>
            </div>
          </div>
        </>
      )}

      {/* Update banner */}
      {updateAvailable && (
        <>
          <div className="nav-divider" />
          {/* Desktop update */}
          <div className="hidden px-2 py-1.5 md:block">
            <button
              className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-blue-50/80 dark:hover:bg-blue-900/15"
              onClick={onShowVersionModal}
            >
              <div className="relative flex-shrink-0">
                <ArrowUpCircle className="h-4 w-4 text-blue-500 dark:text-blue-400" />
                <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
              </div>
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-normal text-blue-600 dark:text-blue-300">
                  {releaseInfo?.title || `v${latestVersion}`}
                </span>
                <span className="text-[10px] text-blue-500/70 dark:text-blue-400/60">
                  {t('version.updateAvailable')}
                </span>
              </div>
            </button>
          </div>

          {/* Mobile update */}
          <div className="px-3 py-2 md:hidden">
            <button
              className="flex h-11 w-full items-center gap-3 rounded-xl border border-blue-200/60 bg-blue-50/80 px-3.5 transition-all active:scale-[0.98] dark:border-blue-700/40 dark:bg-blue-900/15"
              onClick={onShowVersionModal}
            >
              <div className="relative flex-shrink-0">
                <ArrowUpCircle className="h-4 w-4 text-blue-500 dark:text-blue-400" />
                <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
              </div>
              <div className="min-w-0 flex-1 text-left">
                <span className="block truncate text-sm font-normal text-blue-600 dark:text-blue-300">
                  {releaseInfo?.title || `v${latestVersion}`}
                </span>
                <span className="text-xs text-blue-500/70 dark:text-blue-400/60">
                  {t('version.updateAvailable')}
                </span>
              </div>
            </button>
          </div>
        </>
      )}

      {/* Settings */}
      <div className="nav-divider" />

      {/* Desktop settings */}
      <div className="hidden px-2 py-1.5 md:block">
        <button
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          onClick={onShowSettings}
        >
          <Settings className="h-3.5 w-3.5" />
          <span className="text-sm">{t('actions.settings')}</span>
        </button>
      </div>

      {/* Desktop account indicator: only rendered when the server was started with
          ACCOUNT_LABEL set (multi-instance setup, one instance per account). */}
      {accountLabel && (
        <div className="hidden px-2 pb-1.5 md:block">
          <div className="flex items-center gap-2.5 rounded-lg border border-violet-300/60 bg-violet-50/80 px-2.5 py-2 dark:border-violet-700/40 dark:bg-violet-900/15">
            <Users className="h-4 w-4 flex-shrink-0 text-violet-500 dark:text-violet-400" />
            <div className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-violet-700 dark:text-violet-300">
                {accountLabel}
              </span>
              {/* The real account email - unlike accountLabel (an operator-chosen
                  string), this can't accidentally be identical across instances,
                  which is exactly what makes two accounts look "the same". */}
              {accountEmail && (
                <span className="block truncate text-[10px] text-violet-500/80 dark:text-violet-400/70" title={accountEmail}>
                  {accountEmail}
                </span>
              )}
            </div>
            {switchAccountUrl && (
              <a
                href={switchAccountUrl}
                className="flex flex-shrink-0 items-center gap-1 text-xs font-medium text-violet-600 hover:text-violet-800 dark:text-violet-300 dark:hover:text-violet-100"
              >
                <ArrowLeftRight className="h-3 w-3" />
                {t('actions.switchAccount')}
              </a>
            )}
          </div>
        </div>
      )}

      {/* Mobile settings */}
      <div className="px-3 pb-3 pt-3 md:hidden">
        <button
          className="flex h-10 w-full items-center gap-3 rounded-xl bg-muted/40 px-3.5 transition-all hover:bg-muted/60 active:scale-[0.98]"
          onClick={onShowSettings}
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-background/80">
            <Settings className="h-4 w-4 text-muted-foreground" />
          </div>
          <span className="text-sm font-normal text-foreground">{t('actions.settings')}</span>
        </button>
      </div>

      {/* Mobile account indicator: only rendered when the server was started with
          ACCOUNT_LABEL set (multi-instance setup, one instance per account). */}
      {accountLabel && (
        <div className="px-3 pb-3 md:hidden">
          <div className="flex h-10 w-full items-center gap-3 rounded-xl border border-violet-300/60 bg-violet-50/80 px-3.5 dark:border-violet-700/40 dark:bg-violet-900/15">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-background/80">
              <Users className="h-4 w-4 text-violet-500 dark:text-violet-400" />
            </div>
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-normal text-violet-700 dark:text-violet-300">
                {accountLabel}
              </span>
              {accountEmail && (
                <span className="block truncate text-[10px] text-violet-500/80 dark:text-violet-400/70" title={accountEmail}>
                  {accountEmail}
                </span>
              )}
            </div>
            {switchAccountUrl && (
              <a
                href={switchAccountUrl}
                className="flex flex-shrink-0 items-center gap-1 text-xs font-medium text-violet-600 dark:text-violet-300"
              >
                <ArrowLeftRight className="h-3.5 w-3.5" />
                {t('actions.switchAccount')}
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

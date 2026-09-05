import { ExternalLink, MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { CLOUDCLI_WORDMARK_FONT_FAMILY } from '../../../../../../shared/constants';
import { IS_PLATFORM } from '../../../../../../shared/utils';
import type { ReleaseInfo } from '../../../../../../shared/types';

const DISCORD_URL = 'https://discord.gg/buxwujPNRE';
const DOCS_URL = 'https://cloudcli.ai/docs/plugin-overview';
const CLOUDCLI_URL = 'https://cloudcli.ai';

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

type VersionInfoSectionProps = {
  currentVersion: string;
  updateAvailable: boolean;
  latestVersion: string | null;
  releaseInfo: ReleaseInfo | null;
};

export default function VersionInfoSection({
  currentVersion,
  updateAvailable,
  latestVersion,
  releaseInfo,
}: VersionInfoSectionProps) {
  const { t } = useTranslation('settings');
  const releasesUrl = releaseInfo?.htmlUrl;

  return (
    <div className="border-t border-border/50 pt-6">
      {/* About CloudCLI */}
      <div className="space-y-4">
        {/* Logo + name + version */}
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-primary/90 shadow-sm">
            <MessageSquare className="h-4.5 w-4.5 text-primary-foreground" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span
                className="text-sm font-semibold text-foreground"
                style={{ fontFamily: CLOUDCLI_WORDMARK_FONT_FAMILY }}
              >
                CloudCLI
              </span>
              <a
                href={releasesUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                v{currentVersion}
              </a>
              {updateAvailable && latestVersion && (
                <a
                  href={releasesUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-600 transition-colors hover:bg-green-500/20 dark:text-green-400"
                >
                  {t('apiKeys.version.updateAvailable', { version: latestVersion })}
                  <ExternalLink className="h-2.5 w-2.5" />
                </a>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Open-source AI coding assistant interface
            </p>
          </div>
        </div>

        {/* Links */}
        <div className="flex flex-wrap gap-3 text-xs">
          <a
            href={DISCORD_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <DiscordIcon className="h-3.5 w-3.5" />
            Discord
          </a>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
            Docs
          </a>
          <a
            href={CLOUDCLI_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
            cloudcli.ai
          </a>
        </div>

        {/* Hosted CTA (OSS mode only) */}
        {!IS_PLATFORM && (
          <div className="rounded-xl border border-primary/10 bg-primary/5 p-4">
            <h4 className="text-sm font-medium text-foreground">Try CloudCLI Hosted</h4>
            <p className="mt-1 text-xs text-muted-foreground">
              Team collaboration, shared MCP configs, settings sync across environments, and managed infrastructure.
            </p>
            <a
              href={CLOUDCLI_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:underline"
            >
              Learn more
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

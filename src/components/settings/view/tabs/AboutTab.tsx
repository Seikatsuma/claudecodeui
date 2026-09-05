import { Cloud, ExternalLink, LogOut, MessageSquare, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { CLOUDCLI_WORDMARK_FONT_FAMILY } from '../../../../shared/constants';
import { IS_PLATFORM } from '../../../../shared/utils';
import { useVersionCheck } from '../../../../hooks/useVersionCheck';
import { useAuth } from '../../../auth/context/AuthContext';
import PremiumFeatureCard from '../PremiumFeatureCard';

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

export default function AboutTab() {
  const { t } = useTranslation('settings');
  const { currentVersion } = useVersionCheck();
  const { user, logout } = useAuth();

  return (
    <div className="space-y-6">
      {/* Logo + name + version */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary/90 shadow-sm">
          <MessageSquare className="h-5 w-5 text-primary-foreground" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span
              className="text-base font-semibold text-foreground"
              style={{ fontFamily: CLOUDCLI_WORDMARK_FONT_FAMILY }}
            >
              CloudCLI
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              v{currentVersion}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Open-source AI coding assistant interface
          </p>
        </div>
      </div>

      {/* Session / account */}
      <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
        <h4 className="text-sm font-medium text-foreground">{t('about.sessionTitle', 'Session')}</h4>
        {user?.username && (
          <p className="mt-1 text-xs text-muted-foreground">
            {t('about.loggedInAs', { username: user.username, defaultValue: 'Signed in as {{username}}' })}
          </p>
        )}
        <button
          type="button"
          onClick={logout}
          className="mt-3 inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-500/5 px-3.5 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-500/10 dark:border-red-900/40 dark:text-red-400 dark:hover:bg-red-900/20"
        >
          <LogOut className="h-4 w-4" />
          {t('about.logout', 'Log Out')}
        </button>
      </div>

      {/* Links */}
      <div className="flex flex-wrap gap-4 text-sm">
        <a
          href={DISCORD_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <DiscordIcon className="h-4 w-4" />
          Discord
        </a>
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Docs
        </a>
        <a
          href={CLOUDCLI_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ExternalLink className="h-3.5 w-3.5" />
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

      {/* Premium feature placeholders (OSS mode only) */}
      {!IS_PLATFORM && (
        <div className="space-y-4 border-t border-border/50 pt-6">
          <h3 className="text-sm font-medium text-foreground">CloudCLI Pro Features</h3>
          <PremiumFeatureCard
            icon={<Cloud className="h-5 w-5" />}
            title="Sync Settings"
            description="Keep your preferences, MCP configs, and theme in sync across all your environments."
          />
          <PremiumFeatureCard
            icon={<Users className="h-5 w-5" />}
            title="Team Management"
            description="Multiple users, role-based access, and shared projects for your team."
          />
        </div>
      )}

      {/* License */}
      <div className="border-t border-border/50 pt-4">
        <p className="text-xs text-muted-foreground/60">
          Licensed under AGPL-3.0
        </p>
      </div>
    </div>
  );
}

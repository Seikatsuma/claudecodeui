import { useCallback, useState } from 'react';
import { Check, Copy, KeyRound, ShieldAlert } from 'lucide-react';

import { copyTextToClipboard } from '../../../utils/clipboard';
import { useAuth } from '../context/AuthContext';

import AuthScreenLayout from './AuthScreenLayout';

/**
 * One-time screen shown immediately after registerOpen() succeeds. This is
 * the ONLY moment the login link is pushed in front of the user unprompted -
 * afterwards it is available again in Settings, but never shown again
 * automatically, so it cannot become an ignorable nag on every visit.
 */
export default function LoginLinkRevealScreen() {
  const { pendingLoginLink, acknowledgeLoginLink } = useAuth();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!pendingLoginLink) {
      return;
    }
    const success = await copyTextToClipboard(pendingLoginLink);
    if (success) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  }, [pendingLoginLink]);

  if (!pendingLoginLink) {
    return null;
  }

  return (
    <AuthScreenLayout
      title="Save your personal link"
      description="This is the only way back into your account - save it now."
      footerText="You'll always be able to view (and regenerate) this link later, from Settings."
      logo={
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/80 shadow-lg shadow-primary/25 ring-1 ring-inset ring-white/20">
          <KeyRound className="h-8 w-8 text-primary-foreground" />
        </div>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-background/60 p-3">
          <p className="break-all font-mono text-sm text-foreground">{pendingLoginLink}</p>
        </div>

        <button
          type="button"
          onClick={handleCopy}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-muted/50 px-4 py-2.5 font-medium text-foreground transition-colors hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40 active:scale-[0.99]"
        >
          {copied ? (
            <>
              <Check className="h-4 w-4 text-primary" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-4 w-4" />
              Copy link
            </>
          )}
        </button>

        <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-amber-600 dark:text-amber-400">
          <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <p className="text-xs leading-relaxed">
            There is no password - whoever has this link can sign in as you. Keep it somewhere private, like a
            password manager.
          </p>
        </div>

        <button
          type="button"
          onClick={acknowledgeLoginLink}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-medium text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-200 hover:shadow-primary/30 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-card active:scale-[0.99]"
        >
          I've saved it, continue
        </button>
      </div>
    </AuthScreenLayout>
  );
}

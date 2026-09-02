import { useState } from 'react';
import { Check, Copy, KeyRound, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useLoginLinkSettings } from '../../../../hooks/useLoginLinkSettings';
import { Button } from '../../../../../../shared/view/ui';
import SettingsCard from '../../../SettingsCard';

/**
 * OPEN_REGISTRATION-only: lets a user see their personal login link again
 * (shown automatically only once, right after registration) and regenerate
 * it - the simple "I think it leaked" recovery path called out as optional
 * in the brief. Only rendered when useAuth().openRegistration is true.
 */
export default function LoginLinkSection() {
  const { t } = useTranslation('settings');
  const {
    loginLink,
    isLoading,
    isRegenerating,
    copied,
    regenerateError,
    copyLoginLink,
    regenerateLink,
  } = useLoginLinkSettings();
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <KeyRound className="h-5 w-5" />
        <h3 className="text-lg font-semibold">{t('apiKeys.loginLink.title', 'Your personal login link')}</h3>
      </div>

      <p className="mb-4 text-sm text-muted-foreground">
        {t(
          'apiKeys.loginLink.description',
          'There is no password - this link is how you sign back in. Anyone with it can access your account.',
        )}
      </p>

      <SettingsCard className="p-4">
        <div className="space-y-3">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t('apiKeys.loading', 'Loading...')}</p>
          ) : (
            <>
              <div className="rounded-lg border bg-background/60 p-3">
                <p className="break-all font-mono text-sm">{loginLink}</p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => void copyLoginLink()}>
                  {copied ? (
                    <>
                      <Check className="mr-1 h-4 w-4" />
                      {t('apiKeys.github.copied', 'Copied')}
                    </>
                  ) : (
                    <>
                      <Copy className="mr-1 h-4 w-4" />
                      {t('apiKeys.loginLink.copy', 'Copy')}
                    </>
                  )}
                </Button>

                {confirmingRegenerate ? (
                  <>
                    <span className="text-sm text-muted-foreground">
                      {t('apiKeys.loginLink.confirmRegenerate', 'The old link will stop working. Continue?')}
                    </span>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={isRegenerating}
                      onClick={() => {
                        setConfirmingRegenerate(false);
                        void regenerateLink();
                      }}
                    >
                      {t('apiKeys.loginLink.confirm', 'Yes, regenerate')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmingRegenerate(false)}>
                      {t('apiKeys.github.form.cancelButton', 'Cancel')}
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setConfirmingRegenerate(true)}>
                    <RefreshCw className="mr-1 h-4 w-4" />
                    {t('apiKeys.loginLink.regenerate', 'Regenerate link')}
                  </Button>
                )}
              </div>

              {regenerateError && <p className="text-sm text-destructive">{regenerateError}</p>}
            </>
          )}
        </div>
      </SettingsCard>
    </div>
  );
}

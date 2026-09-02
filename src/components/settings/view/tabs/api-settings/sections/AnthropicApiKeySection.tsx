import { Check, KeyRound, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAnthropicApiKeySettings } from '../../../../hooks/useAnthropicApiKeySettings';
import { Button, Input } from '../../../../../../shared/view/ui';
import SettingsCard from '../../../SettingsCard';

/**
 * OPEN_REGISTRATION-only: lets each web user attach their own Anthropic API
 * key so their chats run through their own account/billing instead of the
 * host's. Only rendered when useAuth().openRegistration is true (see
 * CredentialsSettingsTab.tsx) - on Account 1/2 this key is never read (they
 * authenticate the Claude CLI itself via `claude login`), so the field would
 * just be confusing clutter there.
 */
export default function AnthropicApiKeySection() {
  const { t } = useTranslation('settings');
  const {
    isConfigured,
    configuredAt,
    apiKeyInput,
    setApiKeyInput,
    isLoading,
    isSaving,
    saveStatus,
    saveApiKey,
    removeApiKey,
  } = useAnthropicApiKeySettings();

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <KeyRound className="h-5 w-5" />
        <h3 className="text-lg font-semibold">{t('apiKeys.anthropic.title', 'Anthropic API Key')}</h3>
      </div>

      <p className="mb-4 text-sm text-muted-foreground">
        {t(
          'apiKeys.anthropic.description',
          'Your chats run through your own Anthropic account and billing, not the host\'s. Required before you can start a Claude chat.',
        )}
      </p>

      <SettingsCard className="p-4">
        <div className="space-y-3">
          {isConfigured && (
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <div className="font-medium">{t('apiKeys.anthropic.configured', 'Key configured')}</div>
                {configuredAt && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t('apiKeys.github.added', 'Added')} {new Date(configuredAt).toLocaleDateString()}
                  </div>
                )}
              </div>
              <Button size="sm" variant="ghost" onClick={() => void removeApiKey()} disabled={isSaving}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          )}

          <div>
            <Input
              type="password"
              placeholder={
                isConfigured
                  ? t('apiKeys.anthropic.replacePlaceholder', 'Enter a new key to replace it (sk-ant-...)')
                  : 'sk-ant-...'
              }
              value={apiKeyInput}
              onChange={(event) => setApiKeyInput(event.target.value)}
              disabled={isLoading || isSaving}
              className="w-full"
            />
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={() => void saveApiKey()} disabled={isSaving || !apiKeyInput.trim()}>
              {isSaving ? t('apiKeys.anthropic.saving', 'Saving...') : t('apiKeys.anthropic.save', 'Save key')}
            </Button>

            {saveStatus === 'success' && (
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                <Check className="h-4 w-4" />
                {t('git.status.success', 'Saved')}
              </div>
            )}
            {saveStatus === 'error' && (
              <div className="text-sm text-destructive">
                {t('apiKeys.anthropic.error', 'Could not save this key. Please try again.')}
              </div>
            )}
          </div>

          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="block text-xs text-primary hover:underline"
          >
            {t('apiKeys.anthropic.howToCreate', 'Get an API key from console.anthropic.com')}
          </a>
        </div>
      </SettingsCard>
    </div>
  );
}

import { Check, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { MAX_ANTHROPIC_API_KEYS, useAnthropicApiKeySettings } from '../../../../hooks/useAnthropicApiKeySettings';
import { Badge, Button, Input } from '../../../../../../shared/view/ui';
import SettingsCard from '../../../SettingsCard';

/**
 * OPEN_REGISTRATION-only: lets each web user attach up to two Anthropic API
 * key "connections" and switch which one is active - the one their next chat
 * turn's SDK call uses. Only rendered when useAuth().openRegistration is true
 * (see CredentialsSettingsTab.tsx) - on Account 1/2 this key is never read
 * (they authenticate the Claude CLI itself via `claude login`), so the field
 * would just be confusing clutter there.
 */
export default function AnthropicApiKeySection() {
  const { t } = useTranslation('settings');
  const {
    keys,
    isLoading,
    canAddMore,
    showAddForm,
    setShowAddForm,
    newKeyLabel,
    setNewKeyLabel,
    apiKeyInput,
    setApiKeyInput,
    isSaving,
    pendingId,
    saveStatus,
    errorMessage,
    addKey,
    removeKey,
    activateKey,
  } = useAnthropicApiKeySettings();

  const isFirstKey = keys.length === 0;
  const showForm = isFirstKey || showAddForm;

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <KeyRound className="h-5 w-5" />
        <h3 className="text-lg font-semibold">{t('apiKeys.anthropic.title', 'Anthropic Accounts')}</h3>
      </div>

      <p className="mb-4 text-sm text-muted-foreground">
        {t(
          'apiKeys.anthropic.description',
          'Your chats run through your own Anthropic account and billing, not the host\'s. Connect up to two accounts and switch which one new messages use.',
        )}
      </p>

      <SettingsCard className="p-4">
        <div className="space-y-3">
          {keys.length > 0 && (
            <div className="space-y-2">
              {keys.map((key) => {
                const isActive = Boolean(key.is_active);
                const isBusy = pendingId === key.id;
                return (
                  <div key={key.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{key.credential_name}</span>
                        {isActive && (
                          <Badge className="shrink-0 gap-1 border-transparent bg-green-600 text-white dark:bg-green-500">
                            <Check className="h-3 w-3" />
                            {t('apiKeys.anthropic.active', 'Active')}
                          </Badge>
                        )}
                      </div>
                      <code className="text-xs text-muted-foreground">{key.value_preview}</code>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {t('apiKeys.github.added', 'Added')} {new Date(key.created_at).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {!isActive && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void activateKey(key.id)}
                          disabled={isBusy}
                        >
                          {t('apiKeys.anthropic.makeActive', 'Make active')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void removeKey(key.id)}
                        disabled={isBusy}
                        aria-label={t('apiKeys.anthropic.remove', 'Remove connection')}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {!isFirstKey && !showAddForm && canAddMore && (
            <Button size="sm" variant="outline" onClick={() => setShowAddForm(true)} disabled={isLoading}>
              <Plus className="mr-1 h-4 w-4" />
              {t('apiKeys.anthropic.addSecond', 'Add second account')}
            </Button>
          )}

          {showForm && canAddMore && (
            <div className="space-y-3 rounded-lg border bg-card p-3">
              <Input
                placeholder={t('apiKeys.anthropic.form.labelPlaceholder', 'Label (e.g. Personal, Work)')}
                value={newKeyLabel}
                onChange={(event) => setNewKeyLabel(event.target.value)}
                disabled={isLoading || isSaving}
                className="w-full"
              />

              <Input
                type="password"
                placeholder="sk-ant-..."
                value={apiKeyInput}
                onChange={(event) => setApiKeyInput(event.target.value)}
                disabled={isLoading || isSaving}
                className="w-full"
              />

              <div className="flex items-center gap-2">
                <Button onClick={() => void addKey()} disabled={isSaving || !apiKeyInput.trim()}>
                  {isSaving ? t('apiKeys.anthropic.saving', 'Saving...') : t('apiKeys.anthropic.save', 'Save key')}
                </Button>

                {!isFirstKey && (
                  <Button
                    variant="outline"
                    onClick={() => { setShowAddForm(false); setNewKeyLabel(''); setApiKeyInput(''); }}
                    disabled={isSaving}
                  >
                    {t('apiKeys.github.form.cancelButton', 'Cancel')}
                  </Button>
                )}

                {saveStatus === 'success' && (
                  <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                    <Check className="h-4 w-4" />
                    {t('git.status.success', 'Saved')}
                  </div>
                )}
                {saveStatus === 'error' && (
                  <div className="text-sm text-destructive">
                    {errorMessage || t('apiKeys.anthropic.error', 'Could not save this key. Please try again.')}
                  </div>
                )}
              </div>
            </div>
          )}

          {!canAddMore && (
            <p className="text-xs text-muted-foreground">
              {t(
                'apiKeys.anthropic.limitReached',
                `You've connected the maximum of ${MAX_ANTHROPIC_API_KEYS} accounts. Remove one to add another.`,
              )}
            </p>
          )}

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

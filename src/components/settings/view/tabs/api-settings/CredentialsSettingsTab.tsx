import { useTranslation } from 'react-i18next';

import { useAuth } from '../../../../auth';
import { useCredentialsSettings } from '../../../hooks/useCredentialsSettings';

import AnthropicApiKeySection from './sections/AnthropicApiKeySection';
import ApiKeysSection from './sections/ApiKeysSection';
import GithubCredentialsSection from './sections/GithubCredentialsSection';
import LoginLinkSection from './sections/LoginLinkSection';
import NewApiKeyAlert from './sections/NewApiKeyAlert';

export default function CredentialsSettingsTab() {
  const { t } = useTranslation('settings');
  const { openRegistration } = useAuth();
  const {
    apiKeys,
    githubCredentials,
    loading,
    showNewKeyForm,
    setShowNewKeyForm,
    newKeyName,
    setNewKeyName,
    showNewGithubForm,
    setShowNewGithubForm,
    newGithubName,
    setNewGithubName,
    newGithubToken,
    setNewGithubToken,
    newGithubDescription,
    setNewGithubDescription,
    showToken,
    copiedKey,
    newlyCreatedKey,
    createApiKey,
    deleteApiKey,
    toggleApiKey,
    createGithubCredential,
    deleteGithubCredential,
    toggleGithubCredential,
    copyToClipboard,
    dismissNewlyCreatedKey,
    cancelNewApiKeyForm,
    cancelNewGithubForm,
    toggleNewGithubTokenVisibility,
  } = useCredentialsSettings({
    confirmDeleteApiKeyText: t('apiKeys.confirmDelete'),
    confirmDeleteGithubCredentialText: t('apiKeys.github.confirmDelete'),
  });

  if (loading) {
    return <div className="text-muted-foreground">{t('apiKeys.loading')}</div>;
  }

  return (
    <div className="space-y-8">
      {newlyCreatedKey && (
        <NewApiKeyAlert
          apiKey={newlyCreatedKey}
          copiedKey={copiedKey}
          onCopy={copyToClipboard}
          onDismiss={dismissNewlyCreatedKey}
        />
      )}

      <ApiKeysSection
        apiKeys={apiKeys}
        showNewKeyForm={showNewKeyForm}
        newKeyName={newKeyName}
        onShowNewKeyFormChange={setShowNewKeyForm}
        onNewKeyNameChange={setNewKeyName}
        onCreateApiKey={createApiKey}
        onCancelCreateApiKey={cancelNewApiKeyForm}
        onToggleApiKey={toggleApiKey}
        onDeleteApiKey={deleteApiKey}
      />

      <GithubCredentialsSection
        githubCredentials={githubCredentials}
        showNewGithubForm={showNewGithubForm}
        showNewTokenPlainText={Boolean(showToken.new)}
        newGithubName={newGithubName}
        newGithubToken={newGithubToken}
        newGithubDescription={newGithubDescription}
        onShowNewGithubFormChange={setShowNewGithubForm}
        onNewGithubNameChange={setNewGithubName}
        onNewGithubTokenChange={setNewGithubToken}
        onNewGithubDescriptionChange={setNewGithubDescription}
        onToggleNewTokenVisibility={toggleNewGithubTokenVisibility}
        onCreateGithubCredential={createGithubCredential}
        onCancelCreateGithubCredential={cancelNewGithubForm}
        onToggleGithubCredential={toggleGithubCredential}
        onDeleteGithubCredential={deleteGithubCredential}
      />

      {/* Only meaningful on a shared, self-service instance: Account 1/2
          authenticate the Claude CLI itself (`claude login`) and never read
          this field, so it stays hidden there rather than sitting unused. */}
      {openRegistration && (
        <>
          <AnthropicApiKeySection />
          <LoginLinkSection />
        </>
      )}
    </div>
  );
}

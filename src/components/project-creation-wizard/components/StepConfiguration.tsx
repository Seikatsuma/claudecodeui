import { useTranslation } from 'react-i18next';
import { Input } from '../../../shared/view/ui';
import { shouldShowGithubAuthentication } from '../utils/pathUtils';
import type { GithubTokenCredential, TokenMode } from '../types';
import GithubAuthenticationCard from './GithubAuthenticationCard';
import WorkspacePathField from './WorkspacePathField';
import { isDesktopApp } from '../../../lib/desktopBridge';

type StepConfigurationProps = {
  workspacePath: string;
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
  availableTokens: GithubTokenCredential[];
  loadingTokens: boolean;
  tokenLoadError: string | null;
  isCreating: boolean;
  onWorkspacePathChange: (workspacePath: string) => void;
  onGithubUrlChange: (githubUrl: string) => void;
  onTokenModeChange: (tokenMode: TokenMode) => void;
  onSelectedGithubTokenChange: (tokenId: string) => void;
  onNewGithubTokenChange: (tokenValue: string) => void;
  onAdvanceToConfirm: () => void;
};

export default function StepConfiguration({
  workspacePath,
  githubUrl,
  tokenMode,
  selectedGithubToken,
  newGithubToken,
  availableTokens,
  loadingTokens,
  tokenLoadError,
  isCreating,
  onWorkspacePathChange,
  onGithubUrlChange,
  onTokenModeChange,
  onSelectedGithubTokenChange,
  onNewGithubTokenChange,
  onAdvanceToConfirm,
}: StepConfigurationProps) {
  const { t } = useTranslation();
  const showGithubAuth = shouldShowGithubAuthentication(githubUrl);
  const desktop = isDesktopApp();

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {desktop ? t('projectWizard.desktop.folderLabel') : t('projectWizard.step2.newPath')}
        </label>

        <WorkspacePathField
          value={workspacePath}
          disabled={isCreating}
          onChange={onWorkspacePathChange}
          onAdvanceToConfirm={onAdvanceToConfirm}
        />

        {desktop ? (
          <p className="mt-3 rounded-lg bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            {t('projectWizard.desktop.access')}
          </p>
        ) : (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('projectWizard.step2.newHelp')}
          </p>
        )}
      </div>

      {desktop ? (
        <details className="group rounded-lg border border-border/60 px-3 py-2" open={Boolean(githubUrl)}>
          <summary className="cursor-pointer select-none text-sm text-muted-foreground hover:text-foreground">
            {t('projectWizard.desktop.githubToggle')}
          </summary>
          <div className="mt-3">
      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('projectWizard.step2.githubUrl')}
        </label>
        <Input
          type="text"
          value={githubUrl}
          onChange={(event) => onGithubUrlChange(event.target.value)}
          placeholder="https://github.com/username/repository"
          className="w-full"
          disabled={isCreating}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('projectWizard.step2.githubHelp')}
        </p>
      </div>
          </div>
        </details>
      ) : (
      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('projectWizard.step2.githubUrl')}
        </label>
        <Input
          type="text"
          value={githubUrl}
          onChange={(event) => onGithubUrlChange(event.target.value)}
          placeholder="https://github.com/username/repository"
          className="w-full"
          disabled={isCreating}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('projectWizard.step2.githubHelp')}
        </p>
      </div>
      )}

      {showGithubAuth && (
        <GithubAuthenticationCard
          tokenMode={tokenMode}
          selectedGithubToken={selectedGithubToken}
          newGithubToken={newGithubToken}
          availableTokens={availableTokens}
          loadingTokens={loadingTokens}
          tokenLoadError={tokenLoadError}
          onTokenModeChange={onTokenModeChange}
          onSelectedGithubTokenChange={onSelectedGithubTokenChange}
          onNewGithubTokenChange={onNewGithubTokenChange}
        />
      )}
    </div>
  );
}

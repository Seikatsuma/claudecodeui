import { AppError } from '@/shared/utils.js';

type GitConfig = {
  git_name: string | null;
  git_email: string | null;
};

type UserDependencies = {
  users: {
    getGitConfig(userId: number): GitConfig | undefined;
    updateGitConfig(userId: number, gitName: string | null, gitEmail: string | null): void;
    completeOnboarding(userId: number): void;
    hasCompletedOnboarding(userId: number): boolean;
  };
  readSystemGitConfig(): Promise<GitConfig>;
  applyGlobalGitConfig(gitName: string, gitEmail: string): Promise<void>;
  logInfo(message: string): void;
  logError(message: string, error: unknown): void;
  /**
   * Gates readSystemGitConfig()/applyGlobalGitConfig() below. Both shell out
   * to `git config --global` - a SINGLE identity shared by the whole host
   * (and every other instance/account on it), not per-user. That is a nice
   * convenience on a single-account install (defaults a new setup to
   * whoever is already logged into the host's own git) but actively wrong
   * on OPEN_REGISTRATION: one web user's onboarding would silently read
   * (and, on save, overwrite) another user's - or Account 1/2's own -
   * machine-wide git identity. False (the default) preserves the exact
   * previous behavior.
   */
  openRegistration: boolean;
};

/** Creates user-profile workflows with explicit repository and Git adapters. */
export function createUserService(dependencies: UserDependencies) {
  return {
    async getGitConfig(userId: number) {
      let gitConfig = dependencies.users.getGitConfig(userId);
      if (!dependencies.openRegistration && (!gitConfig || (!gitConfig.git_name && !gitConfig.git_email))) {
        const systemConfig = await dependencies.readSystemGitConfig();
        if (systemConfig.git_name || systemConfig.git_email) {
          dependencies.users.updateGitConfig(
            userId,
            systemConfig.git_name,
            systemConfig.git_email,
          );
          gitConfig = systemConfig;
          dependencies.logInfo(`Auto-populated Git config for user ${userId}`);
        }
      }

      return {
        success: true,
        gitName: gitConfig?.git_name ?? null,
        gitEmail: gitConfig?.git_email ?? null,
      };
    },

    async updateGitConfig(userId: number, gitNameInput: unknown, gitEmailInput: unknown) {
      const gitName = typeof gitNameInput === 'string' ? gitNameInput.trim() : '';
      const gitEmail = typeof gitEmailInput === 'string' ? gitEmailInput.trim() : '';
      if (!gitName || !gitEmail) {
        throw new AppError('Git name and email are required', {
          code: 'GIT_CONFIG_REQUIRED',
          statusCode: 400,
        });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(gitEmail)) {
        throw new AppError('Invalid email format', {
          code: 'INVALID_GIT_EMAIL',
          statusCode: 400,
        });
      }

      dependencies.users.updateGitConfig(userId, gitName, gitEmail);
      if (!dependencies.openRegistration) {
        try {
          await dependencies.applyGlobalGitConfig(gitName, gitEmail);
        } catch (error) {
          // Persisted user settings remain authoritative even if the host Git
          // installation cannot be updated (matching the previous behavior).
          dependencies.logError('Failed to apply global Git config', error);
        }
      }
      return { success: true, gitName, gitEmail };
    },

    completeOnboarding(userId: number) {
      dependencies.users.completeOnboarding(userId);
      return { success: true, message: 'Onboarding completed successfully' };
    },

    getOnboardingStatus(userId: number) {
      return {
        success: true,
        hasCompletedOnboarding: dependencies.users.hasCompletedOnboarding(userId),
      };
    },
  };
}

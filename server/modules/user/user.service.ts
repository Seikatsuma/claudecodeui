import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { AppError, getClaudeConfigDir, getClaudeJsonPath, isPlatformOwnerWebUser } from '@/shared/utils.js';
import { getLiveLimits } from '@/modules/providers/index.js';
import { getWebUserClaudeConfigDir } from '@/shared/web-user-paths.js';

/** Как окна из потока называются в кэше CLI. */
const LIVE_WINDOW_BY_KIND: Record<string, string> = {
  session: 'five_hour',
  weekly_all: 'seven_day',
  weekly_scoped: 'seven_day_overage_included',
};

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
    getActiveOwnerAccountSlot(userId: number): number;
    setActiveOwnerAccountSlot(userId: number, slot: number): void;
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

    /**
     * Platform-owner-only: surfaces which real Anthropic account email is
     * behind this user's symlinked ~/.claude-webuser-<id> config dir (see
     * isPlatformOwnerWebUser). Reads only the non-secret `oauthAccount.
     * emailAddress` field from the CLI's own .claude.json - never touches
     * .credentials.json or any token/secret material. Returns null for
     * every non-owner user and whenever the field cannot be read, rather
     * than surfacing a read error.
     */
    /**
     * Полосы расхода подписки — те же три, что показывает панель Клода в
     * VS Code: пятичасовое окно, недельное и лимит конкретной модели.
     *
     * Читаются из ~/.claude.json (`cachedUsageUtilization`), который ведёт сам
     * CLI: там уже готовые проценты, время сброса и подпись модели. Своего
     * запроса к API мы не делаем сознательно — он расходует ту самую квоту,
     * которую показывает.
     *
     * Возвращается и возраст кэша: окно могло провернуться, и тогда старые
     * проценты — неправда. Решает клиент, что с этим показать; молча выдавать
     * протухшее число нельзя.
     */
    async getUsageLimits() {
      // CLI держит кэш расхода в ДОМАШНЕМ ~/.claude.json, а не в файле внутри
      // каталога аккаунта: там лежат только настройки. Поэтому смотрим оба —
      // сначала файл аккаунта, потом домашний, и берём тот, где кэш вообще
      // есть. Замер на сервере: в ~/.claude-webuser-1/.claude.json раздела
      // cachedUsageUtilization нет, в ~/.claude.json — есть.
      const candidates = [getClaudeJsonPath(), path.join(os.homedir(), '.claude.json')];
      const live = getLiveLimits(getClaudeConfigDir());
      const liveWindows = live?.windows ?? {};

      for (const candidate of candidates) {
      try {
        const raw = await readFile(candidate, 'utf-8');
        const parsed = JSON.parse(raw) as {
          cachedUsageUtilization?: {
            fetchedAtMs?: number;
            utilization?: {
              limits?: Array<{
                kind?: string;
                percent?: number;
                severity?: string;
                resets_at?: string;
                scope?: { model?: { display_name?: string | null } };
              }>;
            };
          };
        };

        const cached = parsed.cachedUsageUtilization;
        const rows = cached?.utilization?.limits ?? [];
        if (rows.length === 0) {
          continue;
        }
        const now = Date.now();
        // Отметка свежести должна относиться к тем числам, которые в итоге
        // показаны. Иначе выходит несуразица: значения только что пришли из
        // потока, а подпись говорит «данные не свежие», потому что файл CLI
        // переписывался час назад.
        let usedLive = false;

        const limits = rows
            .filter((row) => typeof row.percent === 'number')
            .map((row) => {
              const resetsAt = row.resets_at ?? null;
              const resetsAtMs = resetsAt ? Date.parse(resetsAt) : Number.NaN;
              // Живое значение из потока свежее файла: CLI переписывает файл
              // не при каждом ответе, а событие приходит всегда.
              const live = liveWindows[LIVE_WINDOW_BY_KIND[row.kind ?? ''] ?? ''];
              const liveResetsAtMs = live?.resetsAt ? live.resetsAt * 1000 : Number.NaN;
              const useLive = Boolean(live) && (!Number.isFinite(resetsAtMs) || liveResetsAtMs >= resetsAtMs);
              usedLive = usedLive || useLive;
              const percent = useLive && live
                ? Math.round(live.utilization * 100)
                : (row.percent as number);
              const effectiveResetsAt = useLive && Number.isFinite(liveResetsAtMs)
                ? new Date(liveResetsAtMs).toISOString()
                : resetsAt;
              const effectiveResetsAtMs = useLive && Number.isFinite(liveResetsAtMs)
                ? liveResetsAtMs
                : resetsAtMs;

              return {
                kind: row.kind ?? 'unknown',
                percent: Math.max(0, Math.min(100, Math.round(percent))),
                severity: row.severity ?? 'normal',
                resetsAt: effectiveResetsAt,
                modelName: row.scope?.model?.display_name ?? null,
                // Окно уже сбросилось: показывать его прежний процент нельзя.
                expired: Number.isFinite(effectiveResetsAtMs) ? effectiveResetsAtMs <= now : false,
              };
            });

        return {
          success: true,
          fetchedAtMs: usedLive && live
            ? Math.max(live.capturedAtMs, cached?.fetchedAtMs ?? 0)
            : (cached?.fetchedAtMs ?? null),
          limits,
        };
      } catch {
        // Файла нет или он битый — пробуем следующий кандидат.
      }
      }

      return { success: true, fetchedAtMs: null, limits: [] };
    },

    async getOwnerAccountEmail(userId: number) {
      if (!isPlatformOwnerWebUser(userId)) {
        return { success: true, email: null };
      }
      try {
        const raw = await readFile(getClaudeJsonPath(), 'utf-8');
        const parsed = JSON.parse(raw) as { oauthAccount?: { emailAddress?: string } };
        return { success: true, email: parsed.oauthAccount?.emailAddress ?? null };
      } catch {
        return { success: true, email: null };
      }
    },

    /**
     * Platform-owner-only: returns info on both account slots so the Settings
     * UI can render which is active and let the user switch. Non-owners always
     * get an empty accounts list (not an error) so the UI can gate the section
     * without a separate "am I owner?" check.
     */
    async getOwnerAccounts(userId: number) {
      if (!isPlatformOwnerWebUser(userId)) {
        return { success: true, activeSlot: null as number | null, accounts: [] as OwnerAccountInfo[] };
      }

      const activeSlot = dependencies.users.getActiveOwnerAccountSlot(userId);

      const readSlotInfo = async (slot: number): Promise<OwnerAccountInfo> => {
        try {
          const configDir = getWebUserClaudeConfigDir(userId, slot);
          const claudeJsonPath = path.join(configDir, '.claude.json');
          const raw = await readFile(claudeJsonPath, 'utf-8');
          const parsed = JSON.parse(raw) as { oauthAccount?: { emailAddress?: string } };
          return { slot, email: parsed.oauthAccount?.emailAddress ?? null, available: true };
        } catch {
          return { slot, email: null, available: false };
        }
      };

      const accounts = await Promise.all([readSlotInfo(1), readSlotInfo(2)]);
      return { success: true, activeSlot, accounts };
    },

    /**
     * Platform-owner-only: persists the chosen account slot (1 or 2) after
     * verifying the target slot is actually available and authenticated.
     * Returns the updated getOwnerAccounts shape on success.
     */
    async activateOwnerAccount(userId: number, slotInput: unknown) {
      if (!isPlatformOwnerWebUser(userId)) {
        throw new AppError('Not authorized', { code: 'NOT_OWNER', statusCode: 403 });
      }

      const slot = Number(slotInput);
      if (slot !== 1 && slot !== 2) {
        throw new AppError('Invalid slot: must be 1 or 2', { code: 'INVALID_SLOT', statusCode: 400 });
      }

      // Verify the target slot directory exists and is authenticated before switching.
      const configDir = getWebUserClaudeConfigDir(userId, slot);
      const claudeJsonPath = path.join(configDir, '.claude.json');
      let email: string | null = null;
      try {
        const raw = await readFile(claudeJsonPath, 'utf-8');
        const parsed = JSON.parse(raw) as { oauthAccount?: { emailAddress?: string } };
        email = parsed.oauthAccount?.emailAddress ?? null;
      } catch {
        throw new AppError(
          `Account slot ${slot} is not available or not authenticated`,
          { code: 'SLOT_UNAVAILABLE', statusCode: 400 },
        );
      }

      if (!email) {
        throw new AppError(
          `Account slot ${slot} has no authenticated email in .claude.json`,
          { code: 'SLOT_UNAVAILABLE', statusCode: 400 },
        );
      }

      dependencies.users.setActiveOwnerAccountSlot(userId, slot);

      // Return the same shape as getOwnerAccounts so the client can update in place.
      const activeSlot = slot;
      const readSlotInfo = async (s: number): Promise<OwnerAccountInfo> => {
        try {
          const dir = getWebUserClaudeConfigDir(userId, s);
          const raw = await readFile(path.join(dir, '.claude.json'), 'utf-8');
          const parsed = JSON.parse(raw) as { oauthAccount?: { emailAddress?: string } };
          return { slot: s, email: parsed.oauthAccount?.emailAddress ?? null, available: true };
        } catch {
          return { slot: s, email: null, available: false };
        }
      };
      const accounts = await Promise.all([readSlotInfo(1), readSlotInfo(2)]);
      return { success: true, activeSlot, accounts };
    },
  };
}

type OwnerAccountInfo = {
  slot: number;
  email: string | null;
  available: boolean;
};

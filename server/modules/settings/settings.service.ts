import { AppError } from '@/shared/utils.js';

type ApiKeyRow = Record<string, unknown> & { api_key: string };
type NotificationPreferences = Record<string, unknown> & {
  channels?: Record<string, unknown> & { webPush?: boolean };
};
type CredentialMeta = { id: number; credential_type: string; is_active: number };
type CredentialPreview = Record<string, unknown> & { id: number; is_active: number };

// Every user of an OPEN_REGISTRATION instance gets up to two Anthropic API
// key "connections" they can switch between for new chat turns (see
// AnthropicApiKeySection.tsx / useAnthropicApiKeySettings.ts). Both slots
// live as ordinary rows in the shared user_credentials table - this is not a
// separate table, just a hard cap plus an exclusive-active-slot invariant
// layered on top via the methods below (countByType/activateExclusive/
// listWithPreview). getActiveCredential() (chat-websocket.service.ts,
// request-runtime-context.middleware.ts) already reads whichever single row
// has is_active = 1, so enforcing "exactly one active of this type" here is
// the entire mechanism that makes switching actually change which key the
// next SDK call uses.
const ANTHROPIC_API_KEY_CREDENTIAL_TYPE = 'anthropic_api_key';
const ANTHROPIC_API_KEY_MAX_SLOTS = 2;
const ANTHROPIC_API_KEY_LABEL_MAX_LENGTH = 60;

type SettingsDependencies = {
  apiKeys: {
    list(userId: number): ApiKeyRow[];
    create(userId: number, keyName: string): unknown;
    remove(userId: number, keyId: number): boolean;
    toggle(userId: number, keyId: number, isActive: boolean): boolean;
  };
  credentials: {
    list(userId: number, credentialType: string | null): unknown[];
    create(
      userId: number,
      name: string,
      type: string,
      value: string,
      description: string | null,
      isActive?: boolean,
    ): unknown;
    remove(userId: number, credentialId: number): boolean;
    toggle(userId: number, credentialId: number, isActive: boolean): boolean;
    listWithPreview(userId: number, credentialType: string): CredentialPreview[];
    getMeta(userId: number, credentialId: number): CredentialMeta | null;
    countByType(userId: number, credentialType: string): number;
    activateExclusive(userId: number, credentialId: number, credentialType: string): boolean;
  };
  notifications: {
    getPreferences(userId: number): NotificationPreferences | undefined;
    updatePreferences(userId: number, preferences: NotificationPreferences): unknown;
    createEnabledEvent(): unknown;
    notifyUser(userId: number, event: unknown): void | Promise<void>;
  };
  pushSubscriptions: {
    save(userId: number, endpoint: string, p256dh: string, auth: string): void;
    remove(endpoint: string): void;
  };
  getVapidPublicKey(): string | null;
};

function requiredString(value: unknown, fieldName: string, code: string): string {
  const normalizedValue = typeof value === 'string' ? value.trim() : '';
  if (!normalizedValue) {
    throw new AppError(`${fieldName} is required`, { code, statusCode: 400 });
  }
  return normalizedValue;
}

function assertFound(found: boolean, resourceName: string, code: string): void {
  if (!found) {
    throw new AppError(`${resourceName} not found`, { code, statusCode: 404 });
  }
}

/** Creates settings workflows with repositories and notification effects injected. */
export function createSettingsService(dependencies: SettingsDependencies) {
  return {
    listApiKeys(userId: number) {
      const apiKeys = dependencies.apiKeys.list(userId).map((key) => ({
        ...key,
        api_key: `${key.api_key.substring(0, 10)}...`,
      }));
      return { apiKeys };
    },
    createApiKey(userId: number, keyNameInput: unknown) {
      const keyName = requiredString(keyNameInput, 'Key name', 'API_KEY_NAME_REQUIRED');
      return { success: true, apiKey: dependencies.apiKeys.create(userId, keyName) };
    },
    deleteApiKey(userId: number, keyId: number) {
      assertFound(dependencies.apiKeys.remove(userId, keyId), 'API key', 'API_KEY_NOT_FOUND');
      return { success: true };
    },
    toggleApiKey(userId: number, keyId: number, isActive: unknown) {
      if (typeof isActive !== 'boolean') {
        throw new AppError('isActive must be a boolean', {
          code: 'INVALID_ACTIVE_STATE',
          statusCode: 400,
        });
      }
      assertFound(
        dependencies.apiKeys.toggle(userId, keyId, isActive),
        'API key',
        'API_KEY_NOT_FOUND',
      );
      return { success: true };
    },
    listCredentials(userId: number, credentialType: string | null) {
      return { credentials: dependencies.credentials.list(userId, credentialType) };
    },
    createCredential(userId: number, input: Record<string, unknown>) {
      const credentialName = requiredString(
        input.credentialName,
        'Credential name',
        'CREDENTIAL_NAME_REQUIRED',
      );
      const credentialType = requiredString(
        input.credentialType,
        'Credential type',
        'CREDENTIAL_TYPE_REQUIRED',
      );
      const credentialValue = requiredString(
        input.credentialValue,
        'Credential value',
        'CREDENTIAL_VALUE_REQUIRED',
      );
      const description = typeof input.description === 'string'
        ? input.description.trim() || null
        : null;
      return {
        success: true,
        credential: dependencies.credentials.create(
          userId,
          credentialName,
          credentialType,
          credentialValue,
          description,
        ),
      };
    },
    deleteCredential(userId: number, credentialId: number) {
      assertFound(
        dependencies.credentials.remove(userId, credentialId),
        'Credential',
        'CREDENTIAL_NOT_FOUND',
      );
      return { success: true };
    },
    toggleCredential(userId: number, credentialId: number, isActive: unknown) {
      if (typeof isActive !== 'boolean') {
        throw new AppError('isActive must be a boolean', {
          code: 'INVALID_ACTIVE_STATE',
          statusCode: 400,
        });
      }
      assertFound(
        dependencies.credentials.toggle(userId, credentialId, isActive),
        'Credential',
        'CREDENTIAL_NOT_FOUND',
      );
      return { success: true };
    },
    /** Lists this user's up-to-two Anthropic API key connections, newest last. */
    listAnthropicApiKeys(userId: number) {
      return {
        keys: dependencies.credentials.listWithPreview(userId, ANTHROPIC_API_KEY_CREDENTIAL_TYPE),
      };
    },
    /**
     * Adds one Anthropic API key connection. Rejects once the user already
     * has two (the hard cap - see the module-level comment above). The first
     * connection a user adds becomes active immediately (there is nothing
     * else to displace); a second is stored inactive so the first keeps
     * being used for chats until the user explicitly switches.
     */
    createAnthropicApiKey(userId: number, input: Record<string, unknown>) {
      const apiKey = requiredString(input.apiKey, 'API key', 'ANTHROPIC_API_KEY_VALUE_REQUIRED');
      const rawLabel = typeof input.label === 'string' ? input.label.trim() : '';

      const existingCount = dependencies.credentials.countByType(
        userId,
        ANTHROPIC_API_KEY_CREDENTIAL_TYPE,
      );
      if (existingCount >= ANTHROPIC_API_KEY_MAX_SLOTS) {
        throw new AppError('You can connect at most 2 Anthropic accounts', {
          code: 'ANTHROPIC_API_KEY_LIMIT_REACHED',
          statusCode: 400,
        });
      }

      const label = (rawLabel || `Connection ${existingCount + 1}`)
        .slice(0, ANTHROPIC_API_KEY_LABEL_MAX_LENGTH);
      const isActive = existingCount === 0;

      const credential = dependencies.credentials.create(
        userId,
        label,
        ANTHROPIC_API_KEY_CREDENTIAL_TYPE,
        apiKey,
        null,
        isActive,
      );
      return { success: true, credential };
    },
    /** Removes one Anthropic API key connection, keeping the exclusive-active invariant. */
    deleteAnthropicApiKey(userId: number, credentialId: number) {
      const meta = dependencies.credentials.getMeta(userId, credentialId);
      assertFound(
        Boolean(meta) && meta!.credential_type === ANTHROPIC_API_KEY_CREDENTIAL_TYPE,
        'Anthropic API key',
        'ANTHROPIC_API_KEY_NOT_FOUND',
      );
      const wasActive = Boolean(meta!.is_active);

      dependencies.credentials.remove(userId, credentialId);

      // If the deleted connection was the active one and another connection
      // is still around, it must become active - a user with at least one
      // connection left should never end up with none active (that would
      // silently break their next chat turn with no key resolved at all).
      if (wasActive) {
        const remaining = dependencies.credentials.listWithPreview(
          userId,
          ANTHROPIC_API_KEY_CREDENTIAL_TYPE,
        );
        const stillInactive = remaining.find((row) => !row.is_active);
        if (stillInactive) {
          dependencies.credentials.activateExclusive(
            userId,
            stillInactive.id,
            ANTHROPIC_API_KEY_CREDENTIAL_TYPE,
          );
        }
      }
      return { success: true };
    },
    /**
     * Makes one Anthropic API key connection the active one for this user's
     * next chat turns, deactivating whichever connection was active before -
     * exactly one of the (at most two) connections is active at any time.
     */
    activateAnthropicApiKey(userId: number, credentialId: number) {
      const meta = dependencies.credentials.getMeta(userId, credentialId);
      assertFound(
        Boolean(meta) && meta!.credential_type === ANTHROPIC_API_KEY_CREDENTIAL_TYPE,
        'Anthropic API key',
        'ANTHROPIC_API_KEY_NOT_FOUND',
      );
      dependencies.credentials.activateExclusive(
        userId,
        credentialId,
        ANTHROPIC_API_KEY_CREDENTIAL_TYPE,
      );
      return { success: true };
    },
    getNotificationPreferences(userId: number) {
      return { success: true, preferences: dependencies.notifications.getPreferences(userId) };
    },
    updateNotificationPreferences(userId: number, preferences: NotificationPreferences) {
      return {
        success: true,
        preferences: dependencies.notifications.updatePreferences(userId, preferences),
      };
    },
    getVapidPublicKey() {
      return { publicKey: dependencies.getVapidPublicKey() };
    },
    subscribeToPush(userId: number, input: Record<string, unknown>) {
      const endpoint = requiredString(input.endpoint, 'Endpoint', 'PUSH_SUBSCRIPTION_REQUIRED');
      const keys = typeof input.keys === 'object' && input.keys !== null
        ? input.keys as Record<string, unknown>
        : {};
      const p256dh = requiredString(keys.p256dh, 'p256dh', 'PUSH_SUBSCRIPTION_REQUIRED');
      const auth = requiredString(keys.auth, 'auth', 'PUSH_SUBSCRIPTION_REQUIRED');
      dependencies.pushSubscriptions.save(userId, endpoint, p256dh, auth);

      const currentPreferences = dependencies.notifications.getPreferences(userId);
      if (!currentPreferences?.channels?.webPush) {
        dependencies.notifications.updatePreferences(userId, {
          ...currentPreferences,
          channels: { ...currentPreferences?.channels, webPush: true },
        });
      }
      const event = dependencies.notifications.createEnabledEvent();
      void dependencies.notifications.notifyUser(userId, event);
      return { success: true };
    },
    unsubscribeFromPush(userId: number, endpointInput: unknown) {
      const endpoint = requiredString(endpointInput, 'Endpoint', 'PUSH_ENDPOINT_REQUIRED');
      dependencies.pushSubscriptions.remove(endpoint);
      const currentPreferences = dependencies.notifications.getPreferences(userId);
      if (currentPreferences?.channels?.webPush) {
        dependencies.notifications.updatePreferences(userId, {
          ...currentPreferences,
          channels: { ...currentPreferences.channels, webPush: false },
        });
      }
      return { success: true };
    },
  };
}

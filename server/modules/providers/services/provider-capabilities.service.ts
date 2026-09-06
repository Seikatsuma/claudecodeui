import { getRequestRuntimeContext } from '@/shared/request-context.js';
import type { LLMProvider } from '@/shared/types.js';
import { OPEN_REGISTRATION, isPlatformOwnerWebUser } from '@/shared/utils.js';

/**
 * Static, backend-owned description of what one provider integration supports.
 *
 * The frontend renders its composer UI (permission mode picker, image upload,
 * abort button, ...) purely from this shape, which is what keeps the frontend
 * free of per-provider conditionals. New provider features should be exposed
 * here instead of branching on the provider id in React components.
 */
type ProviderCapabilities = {
  provider: LLMProvider;
  /** Permission modes the provider runtime understands, in cycle order. */
  permissionModes: string[];
  defaultPermissionMode: string;
  /** Whether image attachments can be included in a chat.send. */
  supportsImages: boolean;
  /** Whether general file attachments can be included in a chat.send. */
  supportsFiles: boolean;
  /** Whether an in-flight run can be cancelled via chat.abort. */
  supportsAbort: boolean;
  /** Whether interactive tool permission prompts can reach the UI. */
  supportsPermissionRequests: boolean;
  /** Whether the token-usage endpoint has data for this provider. */
  supportsTokenUsage: boolean;
  /** Whether the provider runtime can accept model-level reasoning effort. */
  supportsEffort: boolean;
};

/**
 * The capability matrix mirrors what each runtime actually implements today:
 * - permission modes match the option sets accepted by each CLI/SDK.
 * - only the Claude SDK integration surfaces interactive permission requests.
 * - Cursor has no token usage endpoint support (its store.db has no usage rows).
 */
const PROVIDER_CAPABILITIES: Record<LLMProvider, ProviderCapabilities> = {
  claude: {
    provider: 'claude',
    permissionModes: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: true,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
  cursor: {
    provider: 'cursor',
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: false,
    supportsEffort: false,
  },
  codex: {
    provider: 'codex',
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
  opencode: {
    provider: 'opencode',
    // Mapped by the runtime onto OpenCode's controls: `--agent plan` (plan),
    // `--auto` (bypassPermissions) and the OPENCODE_PERMISSION env var
    // (acceptEdits). See resolveOpenCodePermissionOptions in the OpenCode runtime adapter.
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
};

/**
 * Overrides the starting permission mode from DEFAULT_PERMISSION_MODE.
 *
 * The composer only falls back to this when the visitor has made no explicit
 * choice of their own (see useChatProviderState: a stored per-session or
 * per-provider pick always wins), so this sets the opening position, never
 * overrules a decision someone already made.
 *
 * On a multi-tenant (OPEN_REGISTRATION) instance it applies to the platform
 * owner ALONE. Everyone else keeps the cautious built-in default: permission
 * prompts are the only thing standing between an invited guest and arbitrary
 * commands on this machine, and handing that away by configuration - to
 * people the setting was never about - is not something the host would
 * expect from a preference they set for themselves.
 *
 * An unset or unrecognised value leaves the built-in default untouched, so a
 * typo degrades to safe rather than to something arbitrary.
 */
function resolveDefaultPermissionMode(capabilities: ProviderCapabilities): string {
  const configured = process.env.DEFAULT_PERMISSION_MODE?.trim();
  if (!configured || !capabilities.permissionModes.includes(configured)) {
    return capabilities.defaultPermissionMode;
  }

  if (!OPEN_REGISTRATION) {
    return configured;
  }

  const userId = getRequestRuntimeContext()?.userId;
  const numericUserId = userId === undefined || userId === null ? NaN : Number(userId);
  return Number.isFinite(numericUserId) && isPlatformOwnerWebUser(numericUserId)
    ? configured
    : capabilities.defaultPermissionMode;
}

function withResolvedDefault(capabilities: ProviderCapabilities): ProviderCapabilities {
  return { ...capabilities, defaultPermissionMode: resolveDefaultPermissionMode(capabilities) };
}

/**
 * Application service exposing the provider capability matrix.
 */
export const providerCapabilitiesService = {
  getProviderCapabilities(provider: LLMProvider): ProviderCapabilities {
    return withResolvedDefault(PROVIDER_CAPABILITIES[provider]);
  },

  listAllProviderCapabilities(): ProviderCapabilities[] {
    return Object.values(PROVIDER_CAPABILITIES).map(withResolvedDefault);
  },
};

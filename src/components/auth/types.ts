import type { ReactNode } from 'react';

export type AuthUser = {
  id?: number | string;
  username: string;
  [key: string]: unknown;
};

export type AuthActionResult = { success: true } | { success: false; error: string };

/**
 * The server's global error middleware (`server/index.ts`) always responds
 * with `{ success: false, error: { code, message, details } }` for every
 * failure - including a wrong password, a rate-limited login, or a plain
 * 500. `error` is never a bare string on the wire.
 */
export type ApiErrorDetail = {
  code?: string;
  message?: string;
};

export type AuthSessionPayload = {
  token?: string;
  user?: AuthUser;
  error?: string | ApiErrorDetail;
  message?: string;
  /** registerOpen() only: the persistent login-link token, for one-time display. */
  loginToken?: string;
};

export type AuthStatusPayload = {
  needsSetup?: boolean;
  /** True on a shared, self-service multi-tenant instance (OPEN_REGISTRATION=true). */
  openRegistration?: boolean;
};

export type LoginLinkPayload = ApiErrorPayload & {
  loginToken?: string | null;
};

export type AuthUserPayload = {
  user?: AuthUser;
};

/** One invite token as shown in Settings > Invites. */
export type InviteRecord = {
  token: string;
  label: string | null;
  createdAt: string;
  usedAt: string | null;
  usedByUsername: string | null;
};

export type InviteStatusPayload = ApiErrorPayload & {
  valid?: boolean;
  label?: string | null;
};

export type CreateInvitePayload = ApiErrorPayload & {
  success?: boolean;
  invite?: InviteRecord;
};

export type ListInvitesPayload = ApiErrorPayload & {
  invites?: InviteRecord[];
};

export type OnboardingStatusPayload = {
  hasCompletedOnboarding?: boolean;
};

export type ApiErrorPayload = {
  error?: string | ApiErrorDetail;
  message?: string;
};

export type AuthContextValue = {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  needsSetup: boolean;
  hasCompletedOnboarding: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<AuthActionResult>;
  register: (username: string, password: string) => Promise<AuthActionResult>;
  logout: () => void;
  refreshOnboardingStatus: () => Promise<void>;
  /** True on a shared, self-service multi-tenant instance (OPEN_REGISTRATION=true). */
  openRegistration: boolean;
  /** OPEN_REGISTRATION only: passwordless account creation, gated by a single-use invite token. */
  registerOpen: (username: string, inviteToken: string) => Promise<AuthActionResult>;
  /**
   * Set right after a successful registerOpen() to the full shareable login
   * link. ProtectedRoute shows the one-time "save your link" screen while
   * this is non-null; acknowledgeLoginLink() clears it.
   */
  pendingLoginLink: string | null;
  acknowledgeLoginLink: () => void;
  /** OPEN_REGISTRATION only: issues a new login-link token, invalidating the old one. */
  regenerateLoginLink: () => Promise<{ success: true; loginLink: string } | { success: false; error: string }>;
  /**
   * The invite token parsed from a `/invite/<token>` URL, or null when the
   * current path is not an invite link (e.g. the bare root address).
   */
  inviteToken: string | null;
  /** Validity of `inviteToken`, as reported by the server - 'idle' when there is no token to check. */
  inviteStatus: 'idle' | 'checking' | 'valid' | 'invalid';
  /** The inviter's optional note for this token (e.g. "for Ivanov") - informational only, not shown to the invitee today. */
  inviteLabel: string | null;
};

export type AuthProviderProps = {
  children: ReactNode;
};

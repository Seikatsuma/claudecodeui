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
  /** OPEN_REGISTRATION only: passwordless account creation. */
  registerOpen: (username: string) => Promise<AuthActionResult>;
  /**
   * Set right after a successful registerOpen() to the full shareable login
   * link. ProtectedRoute shows the one-time "save your link" screen while
   * this is non-null; acknowledgeLoginLink() clears it.
   */
  pendingLoginLink: string | null;
  acknowledgeLoginLink: () => void;
  /** OPEN_REGISTRATION only: issues a new login-link token, invalidating the old one. */
  regenerateLoginLink: () => Promise<{ success: true; loginLink: string } | { success: false; error: string }>;
};

export type AuthProviderProps = {
  children: ReactNode;
};

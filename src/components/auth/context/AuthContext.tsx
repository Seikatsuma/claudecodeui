import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { IS_PLATFORM } from '../../../shared/utils';
import {
  api,
  AUTH_SESSION_EXPIRED_EVENT,
  AUTH_TOKEN_REFRESHED_EVENT,
  getAuthTokenRefreshDelay,
  isValidRefreshedToken,
  storeAuthToken,
} from '../../../utils/api';
import { AUTH_ERROR_MESSAGES, AUTH_TOKEN_STORAGE_KEY } from '../constants';
import type {
  AuthContextValue,
  AuthProviderProps,
  AuthSessionPayload,
  AuthStatusPayload,
  AuthUser,
  AuthUserPayload,
  LoginLinkPayload,
  OnboardingStatusPayload,
} from '../types';
import { parseJsonSafely, resolveApiErrorMessage } from '../utils';

const AuthContext = createContext<AuthContextValue | null>(null);

// Matches the trailing `/enter/<token>` segment of the current path regardless
// of a reverse-proxy subpath basename, so the magic link works whether this
// instance is mounted at the domain root or under a prefix.
const LOGIN_LINK_PATH_PATTERN = /\/enter\/([^/]+)\/?$/;

const readStoredToken = (): string | null => localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);

/**
 * Builds the shareable `/enter/<token>` login link. Deliberately origin-only
 * (ignores any current in-app path like `/session/<id>`, which would produce
 * a broken nested link if used verbatim): an OPEN_REGISTRATION instance is
 * meant to be deployed root-mounted on its own port (see
 * deploy/claudecodeui-shared.service and the accompanying nginx config) so
 * the link a user is ever shown is always exactly `<origin>/enter/<token>`.
 */
const buildLoginLink = (loginToken: string): string => `${window.location.origin}/enter/${loginToken}`;

const persistToken = (token: string) => {
  storeAuthToken(token);
};

const clearStoredToken = () => {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [isLoading, setIsLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openRegistration, setOpenRegistration] = useState(false);
  const [pendingLoginLink, setPendingLoginLink] = useState<string | null>(null);

  const setSession = useCallback((nextUser: AuthUser, nextToken: string) => {
    setUser(nextUser);
    setToken(nextToken);
    persistToken(nextToken);
  }, []);

  const clearSession = useCallback(() => {
    setUser(null);
    setToken(null);
    clearStoredToken();
  }, []);

  const checkOnboardingStatus = useCallback(async () => {
    try {
      const response = await api.user.onboardingStatus();
      if (!response.ok) {
        return;
      }

      const payload = await parseJsonSafely<OnboardingStatusPayload>(response);
      setHasCompletedOnboarding(Boolean(payload?.hasCompletedOnboarding));
    } catch (caughtError) {
      console.error('Error checking onboarding status:', caughtError);
      // Fail open to avoid blocking access on transient onboarding status errors.
      setHasCompletedOnboarding(true);
    }
  }, []);

  const refreshOnboardingStatus = useCallback(async () => {
    await checkOnboardingStatus();
  }, [checkOnboardingStatus]);

  const refreshSession = useCallback(async () => {
    if (IS_PLATFORM || !token || !user) {
      return;
    }

    try {
      const response = await api.auth.refresh();
      if (!response.ok) {
        return;
      }

      const payload = await parseJsonSafely<AuthSessionPayload>(response);
      if (isValidRefreshedToken(payload?.token)) {
        setToken(payload.token);
        persistToken(payload.token);
      }
    } catch (caughtError) {
      // A transient network failure must not sign the user out. Focus/visibility
      // and the next scheduled refresh will retry while the token remains valid.
      console.warn('[Auth] Session refresh failed:', caughtError);
    }
  }, [token, user]);

  useEffect(() => {
    const handleTokenRefreshed = (event: Event) => {
      const nextToken = (event as CustomEvent<unknown>).detail;
      if (isValidRefreshedToken(nextToken)) {
        setToken(nextToken);
      }
    };
    const handleSessionExpired = () => {
      clearSession();
      setError(AUTH_ERROR_MESSAGES.sessionExpired);
    };

    window.addEventListener(AUTH_TOKEN_REFRESHED_EVENT, handleTokenRefreshed);
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => {
      window.removeEventListener(AUTH_TOKEN_REFRESHED_EVENT, handleTokenRefreshed);
      window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
    };
  }, [clearSession]);

  const checkAuthStatus = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      // A `/enter/<token>` visit is a magic-link login: exchange it for a
      // session before anything else, then strip it from the address bar so
      // it does not linger there (or get re-exchanged on a later reload)
      // past this one load. This runs even before the status check below -
      // ProtectedRoute renders this provider's children inside the auth gate
      // itself, so there is no router yet to declare this as a normal route.
      const loginLinkMatch = window.location.pathname.match(LOGIN_LINK_PATH_PATTERN);
      if (loginLinkMatch) {
        const loginToken = decodeURIComponent(loginLinkMatch[1]);
        const enterResponse = await api.auth.enter(loginToken);
        const enterPayload = await parseJsonSafely<AuthSessionPayload>(enterResponse);

        window.history.replaceState(null, '', window.location.pathname.replace(LOGIN_LINK_PATH_PATTERN, '/'));

        if (enterResponse.ok && enterPayload?.token && enterPayload.user) {
          setSession(enterPayload.user, enterPayload.token);
          setNeedsSetup(false);
          setOpenRegistration(true);
          await checkOnboardingStatus();
          return;
        }

        setError(AUTH_ERROR_MESSAGES.loginLinkInvalid);
        // Fall through to the normal status check below (e.g. to still show
        // the open-registration screen so the visitor can create an account).
      }

      const statusResponse = await api.auth.status();
      const statusPayload = await parseJsonSafely<AuthStatusPayload>(statusResponse);

      setOpenRegistration(Boolean(statusPayload?.openRegistration));

      if (statusPayload?.needsSetup) {
        setNeedsSetup(true);
        return;
      }

      setNeedsSetup(false);

      if (!token) {
        return;
      }

      const userResponse = await api.auth.user();
      if (!userResponse.ok) {
        clearSession();
        return;
      }

      const userPayload = await parseJsonSafely<AuthUserPayload>(userResponse);
      if (!userPayload?.user) {
        clearSession();
        return;
      }

      setUser(userPayload.user);
      await checkOnboardingStatus();
    } catch (caughtError) {
      console.error('[Auth] Auth status check failed:', caughtError);
      setError(AUTH_ERROR_MESSAGES.authStatusCheckFailed);
    } finally {
      setIsLoading(false);
    }
  }, [checkOnboardingStatus, clearSession, setSession, token]);

  useEffect(() => {
    if (IS_PLATFORM) {
      setUser({ username: 'platform-user' });
      setNeedsSetup(false);
      void checkOnboardingStatus().finally(() => {
        setIsLoading(false);
      });
      return;
    }

    void checkAuthStatus();
  }, [checkAuthStatus, checkOnboardingStatus]);

  useEffect(() => {
    if (IS_PLATFORM || !token || !user) {
      return undefined;
    }

    const refreshIfNeeded = () => {
      const refreshDelay = getAuthTokenRefreshDelay(token);
      if (refreshDelay !== null && refreshDelay <= 0) {
        void refreshSession();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshIfNeeded();
      }
    };

    const refreshDelay = getAuthTokenRefreshDelay(token);
    const refreshTimer = refreshDelay === null
      ? null
      : window.setTimeout(() => void refreshSession(), refreshDelay);

    window.addEventListener('focus', refreshIfNeeded);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      window.removeEventListener('focus', refreshIfNeeded);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshSession, token, user]);

  const login = useCallback<AuthContextValue['login']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.login(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.loginFailed);
          setError(message);
          return { success: false, error: message };
        }

        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        await checkOnboardingStatus();
        return { success: true };
      } catch (caughtError) {
        console.error('Login error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, setSession],
  );

  const register = useCallback<AuthContextValue['register']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.register(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.registrationFailed);
          setError(message);
          return { success: false, error: message };
        }

        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        await checkOnboardingStatus();
        return { success: true };
      } catch (caughtError) {
        console.error('Registration error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, setSession],
  );

  const registerOpen = useCallback<AuthContextValue['registerOpen']>(
    async (username) => {
      try {
        setError(null);
        const response = await api.auth.registerOpen(username);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.registrationFailed);
          setError(message);
          return { success: false, error: message };
        }

        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        if (payload.loginToken) {
          setPendingLoginLink(buildLoginLink(payload.loginToken));
        }
        await checkOnboardingStatus();
        return { success: true };
      } catch (caughtError) {
        console.error('Open registration error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [checkOnboardingStatus, setSession],
  );

  const acknowledgeLoginLink = useCallback(() => {
    setPendingLoginLink(null);
  }, []);

  const regenerateLoginLink = useCallback<AuthContextValue['regenerateLoginLink']>(async () => {
    try {
      const response = await api.auth.regenerateLoginLink();
      const payload = await parseJsonSafely<LoginLinkPayload>(response);

      if (!response.ok || !payload?.loginToken) {
        return { success: false, error: resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.networkError) };
      }

      return { success: true, loginLink: buildLoginLink(payload.loginToken) };
    } catch (caughtError) {
      console.error('Regenerate login link error:', caughtError);
      return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
    }
  }, []);

  const logout = useCallback(() => {
    // JWT logout is client-side: the server endpoint does not maintain a
    // revocation list, so clearing the session is the complete operation.
    clearSession();
  }, [clearSession]);

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      isLoading,
      needsSetup,
      hasCompletedOnboarding,
      error,
      login,
      register,
      logout,
      refreshOnboardingStatus,
      openRegistration,
      registerOpen,
      pendingLoginLink,
      acknowledgeLoginLink,
      regenerateLoginLink,
    }),
    [
      acknowledgeLoginLink,
      error,
      hasCompletedOnboarding,
      isLoading,
      login,
      logout,
      needsSetup,
      openRegistration,
      pendingLoginLink,
      refreshOnboardingStatus,
      register,
      registerOpen,
      regenerateLoginLink,
      token,
      user,
    ],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}

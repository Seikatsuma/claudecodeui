export const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

/**
 * The `/enter/<token>` magic-link token this browser last logged in with.
 *
 * Kept separately from the session token above because the two have very
 * different lifetimes: a session expires after a week, while a login link is
 * reusable and only stops working when its owner regenerates it. Remembering
 * it lets an expired session sign itself back in silently - which is what a
 * home-screen icon needs, since it opens the app at "/" (the manifest's
 * start_url), not at the link, and so has no token in the URL to log in with.
 * Cleared on an explicit logout, otherwise logging out would undo itself.
 */
export const LOGIN_LINK_TOKEN_STORAGE_KEY = 'login-link-token';

export const AUTH_ERROR_MESSAGES = {
  authStatusCheckFailed: 'Failed to check authentication status',
  loginFailed: 'Login failed',
  registrationFailed: 'Registration failed',
  networkError: 'Network error. Please try again.',
  sessionExpired: 'Your session expired. Please log in again.',
  loginLinkInvalid: 'This login link is invalid or no longer works. It may have been regenerated.',
  // Deliberately distinct from loginLinkInvalid/sessionExpired above - an
  // invite that does not exist or was already redeemed is a different
  // situation from a returning user's expired/rotated session.
  inviteInvalid: 'This invitation link is no longer valid.',
} as const;

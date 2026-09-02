export const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

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

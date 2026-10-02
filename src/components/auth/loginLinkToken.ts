const LOGIN_LINK_PATTERN = /^(?:https?:\/\/[^/\s]+)?\/enter\/([A-Za-z0-9_-]{8,})\/?$/;
const BARE_LOGIN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,}$/;

/**
 * Clipboard text must be an explicit `/enter/<token>` link. A bare token is
 * accepted only from the deliberate manual field, otherwise unrelated text
 * such as an API key could be copied into the browser URL and access logs.
 */
export function extractLoginLinkToken(value: string, allowBareToken = false): string | null {
  const trimmed = value.trim();
  const linkToken = trimmed.match(LOGIN_LINK_PATTERN)?.[1];
  if (linkToken) {
    return linkToken;
  }
  return allowBareToken && BARE_LOGIN_TOKEN_PATTERN.test(trimmed) ? trimmed : null;
}

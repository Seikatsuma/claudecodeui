import type { ApiErrorPayload } from './types';

export async function parseJsonSafely<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Extracts a human-readable message from an API error payload.
 *
 * The server's global error middleware always responds with
 * `error: { code, message, details }` (see `server/index.ts`), never a bare
 * string - so `payload.error` must be unwrapped one level before it can be
 * shown to the user. Rendering it unwrapped (as this used to do via
 * `payload.error ?? payload.message ?? fallback`) handed a plain object to
 * JSX and crashed the whole app with React error #31 on every failed login
 * (wrong password, rate limiting, etc.) instead of showing an error banner.
 */
export function resolveApiErrorMessage(payload: ApiErrorPayload | null, fallback: string): string {
  if (!payload) {
    return fallback;
  }

  if (typeof payload.error === 'string' && payload.error) {
    return payload.error;
  }

  if (payload.error && typeof payload.error === 'object' && typeof payload.error.message === 'string' && payload.error.message) {
    return payload.error.message;
  }

  if (typeof payload.message === 'string' && payload.message) {
    return payload.message;
  }

  return fallback;
}

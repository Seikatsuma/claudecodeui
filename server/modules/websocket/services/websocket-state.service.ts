import type { RealtimeClientConnection } from '@/shared/types.js';
import { isPlatformOwnerWebUser, OPEN_REGISTRATION } from '@/shared/utils.js';

/**
 * Numeric readyState for an open WebSocket connection.
 *
 * We keep this in module state so services that broadcast updates do not need
 * to import `ws` directly just to compare open/closed state.
 */
export const WS_OPEN_STATE = 1;

/**
 * Shared registry of active chat WebSocket connections.
 *
 * Project/session services publish realtime updates by iterating this set.
 */
export const connectedClients = new Set<RealtimeClientConnection>();

/**
 * Connection → authenticated web user id, recorded on chat connect.
 *
 * Broadcast paths use this to decide which realtime events a connection may
 * receive — Devin's credentials and session store are machine-global, so on
 * multi-tenant instances its sessions must not leak (sidebar entries, queue
 * contents, run state) into a guest's socket.
 */
export const clientUserIds = new WeakMap<RealtimeClientConnection, string | number | null>();

/**
 * Whether this connection may receive realtime events of `provider`.
 * Owner-only providers (devin) are filtered per connection; everyone else
 * gets everything. Outside OPEN_REGISTRATION there are no guests, so all
 * events go through.
 */
export function canReceiveProviderEvents(
  client: RealtimeClientConnection,
  provider: string | null | undefined,
): boolean {
  if (provider !== 'devin' || !OPEN_REGISTRATION) {
    return true;
  }
  const userId = clientUserIds.get(client);
  const numericUserId = userId === null || userId === undefined ? NaN : Number(userId);
  return Number.isFinite(numericUserId) && isPlatformOwnerWebUser(numericUserId);
}

/**
 * Broadcast one JSON payload to every connected client allowed to see
 * `provider` traffic. Replaces open-coded `connectedClients.forEach` at call
 * sites whose payload belongs to one session/provider.
 */
export function broadcastRealtimeEvent(payload: string, provider?: string | null): void {
  for (const client of connectedClients) {
    if (client.readyState === WS_OPEN_STATE && canReceiveProviderEvents(client, provider)) {
      client.send(payload);
    }
  }
}

import { IS_PLATFORM } from '../../../shared/utils';
import { getStoredAuthToken } from '../../../utils/api';
import type { ShellIncomingMessage, ShellOutgoingMessage } from '../types/types';
import { getDoorHost } from '../../../utils/doors';

export function getShellWebSocketUrl(): string | null {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

  if (IS_PLATFORM) {
    return `${protocol}//${getDoorHost()}/shell`;
  }

  const token = getStoredAuthToken();
  if (!token) {
    console.error('No authentication token found for Shell WebSocket connection');
    return null;
  }

  return `${protocol}//${getDoorHost()}/shell?token=${encodeURIComponent(token)}`;
}

export function parseShellMessage(payload: string): ShellIncomingMessage | null {
  try {
    return JSON.parse(payload) as ShellIncomingMessage;
  } catch {
    return null;
  }
}

export function sendSocketMessage(ws: WebSocket | null, message: ShellOutgoingMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

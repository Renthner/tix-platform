'use client';

import { emitRealtime, onConnectionChange } from '@/lib/realtime';

/** Heartbeat of shoppers on pages WITH a realtime socket (event page): ~15 s. */
export const SOCKET_BEAT_MS = 15_000;
/** Heartbeat of shop pages without a socket (cart, checkout): ~20 s, visible tabs only. */
export const HTTP_BEAT_MS = 20_000;

let socketPresence = 0;

/** True while a page reports presence through the socket (then the HTTP beacon stays quiet). */
export const socketPresenceActive = () => socketPresence > 0;

/**
 * Reports "this visitor is shopping event `eventId`" over the realtime socket: right away, after
 * every reconnect and every `SOCKET_BEAT_MS` while the tab is visible. Closing the socket
 * removes the visitor on the server. Returns the stop function.
 */
export function startSocketPresence(eventId: string): () => void {
  socketPresence += 1;
  const beat = () => {
    if (document.visibilityState === 'visible') emitRealtime('presence:beat', eventId);
  };
  const timer = setInterval(beat, SOCKET_BEAT_MS);
  const offConnection = onConnectionChange((connected) => connected && beat());
  document.addEventListener('visibilitychange', beat);
  beat();
  return () => {
    socketPresence -= 1;
    clearInterval(timer);
    offConnection();
    document.removeEventListener('visibilitychange', beat);
  };
}

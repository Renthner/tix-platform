'use client';

import { io, type Socket } from 'socket.io-client';

/**
 * One Socket.io connection per browser tab, shared by all components. Subscriptions are
 * re-sent after every reconnect; listeners can be added/removed independently.
 */

type Listener = (payload: unknown) => void;

interface RealtimeState {
  socket: Socket | null;
  connecting: Promise<Socket> | null;
  rooms: Map<string, number>;
  listeners: Map<string, Set<Listener>>;
  statusListeners: Set<(connected: boolean) => void>;
}

const state: RealtimeState = {
  socket: null,
  connecting: null,
  rooms: new Map(),
  listeners: new Map(),
  statusListeners: new Set(),
};

async function fetchToken(): Promise<{ token: string; url: string | null }> {
  const response = await fetch('/api/session/realtime-token', {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('realtime token unavailable');
  return (await response.json()) as { token: string; url: string | null };
}

function connect(): Promise<Socket> {
  if (state.socket) return Promise.resolve(state.socket);
  state.connecting ??= fetchToken().then(({ token, url }) => {
    const socket = io(url ?? undefined, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      withCredentials: true,
      // Fresh token on every (re)connect attempt.
      auth: (cb) => {
        fetchToken()
          .then((t) => cb({ token: t.token }))
          .catch(() => cb({ token }));
      },
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 10_000,
      randomizationFactor: 0.5,
    });
    socket.on('connect', () => {
      for (const room of state.rooms.keys()) {
        const [kind, eventId] = room.split(':');
        socket.emit(`${kind}:subscribe`, eventId);
      }
      for (const l of state.statusListeners) l(true);
    });
    socket.on('disconnect', () => {
      for (const l of state.statusListeners) l(false);
    });
    for (const name of ['seats:delta', 'queue:update', 'session:message']) {
      socket.on(name, (payload: unknown) => {
        for (const l of state.listeners.get(name) ?? []) l(payload);
      });
    }
    state.socket = socket;
    return socket;
  });
  return state.connecting;
}

/** Subscribes to `seats:<eventId>` or `queue:<eventId>`; returns an unsubscribe function. */
export function subscribeRoom(kind: 'seats' | 'queue', eventId: string): () => void {
  const room = `${kind}:${eventId}`;
  state.rooms.set(room, (state.rooms.get(room) ?? 0) + 1);
  void connect().then((socket) => {
    if (socket.connected) socket.emit(`${kind}:subscribe`, eventId);
  });
  return () => {
    const count = (state.rooms.get(room) ?? 1) - 1;
    if (count > 0) {
      state.rooms.set(room, count);
      return;
    }
    state.rooms.delete(room);
    if (![...state.rooms.keys()].some((r) => r.endsWith(`:${eventId}`)))
      state.socket?.emit('unsubscribe', eventId);
  };
}

export function onRealtime(
  event: 'seats:delta' | 'queue:update' | 'session:message',
  listener: Listener,
): () => void {
  const set = state.listeners.get(event) ?? new Set<Listener>();
  set.add(listener);
  state.listeners.set(event, set);
  void connect();
  return () => set.delete(listener);
}

export function onConnectionChange(listener: (connected: boolean) => void): () => void {
  state.statusListeners.add(listener);
  return () => state.statusListeners.delete(listener);
}

export function emitRealtime(event: 'shop:ping' | 'presence:beat', payload: string): void {
  if (state.socket?.connected) state.socket.emit(event, payload);
}

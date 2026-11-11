'use client';

import { io, type Socket } from 'socket.io-client';

/**
 * One Socket.io connection per browser tab, shared by all components. Subscriptions are
 * re-sent after every reconnect; listeners can be added/removed independently.
 *
 * Maintenance (backup restore): the gateway sends `maintenance:start` and closes the sockets (or
 * refuses the handshake with "maintenance"). The client then stops reconnecting, polls
 * `/api/maintenance` and reconnects once it is over. Every (re)connect after an interruption
 * fires the resync listeners: deltas were missed, so state must be refetched in full.
 */

type Listener = (payload: unknown) => void;

interface RealtimeState {
  socket: Socket | null;
  connecting: Promise<Socket> | null;
  rooms: Map<string, number>;
  listeners: Map<string, Set<Listener>>;
  statusListeners: Set<(connected: boolean) => void>;
  resyncListeners: Set<(info: ResyncInfo) => void>;
  maintenanceListeners: Set<(active: boolean) => void>;
  maintenance: boolean;
  maintenanceTimer: ReturnType<typeof setTimeout> | null;
  /** The connection was interrupted since the last successful (re)subscription. */
  needsResync: boolean;
  /** A maintenance interrupted the connection: the seat map itself may have changed (restore). */
  needsFullResync: boolean;
}

/** `full`: after maintenance (reload everything); otherwise availability is enough. */
export interface ResyncInfo {
  full: boolean;
}

const state: RealtimeState = {
  socket: null,
  connecting: null,
  rooms: new Map(),
  listeners: new Map(),
  statusListeners: new Set(),
  resyncListeners: new Set(),
  maintenanceListeners: new Set(),
  maintenance: false,
  maintenanceTimer: null,
  needsResync: false,
  needsFullResync: false,
};

const MAINTENANCE_POLL_MS = 4_000;
const MAINTENANCE_RECONNECT_SPREAD_MS = 15_000;

function setMaintenance(active: boolean): void {
  if (state.maintenance === active) return;
  state.maintenance = active;
  for (const l of state.maintenanceListeners) l(active);
}

async function maintenanceOver(): Promise<boolean> {
  try {
    const response = await fetch('/api/maintenance', { cache: 'no-store' });
    if (!response.ok) return false;
    return (await response.json()).active === false;
  } catch {
    return false;
  }
}

const hasConsumers = () =>
  state.rooms.size > 0 || state.maintenanceListeners.size > 0 || state.resyncListeners.size > 0;

/** Maintenance poll: random first offset and jitter, so thousands of clients do not poll in step. */
function scheduleMaintenancePoll(delay: number): void {
  if (state.maintenanceTimer) return;
  state.maintenanceTimer = setTimeout(() => {
    state.maintenanceTimer = null;
    // Nobody is listening any more (page left): stop; a new consumer restarts the poll.
    if (!hasConsumers()) return;
    void maintenanceOver().then((over) => {
      if (!state.maintenance) return;
      if (!over) {
        scheduleMaintenancePoll(MAINTENANCE_POLL_MS + Math.random() * 1_000);
        return;
      }
      setMaintenance(false);
      // Spread the reconnects of everybody who was connected over a window of 15 s.
      setTimeout(() => state.socket?.connect(), Math.random() * MAINTENANCE_RECONNECT_SPREAD_MS);
    });
  }, delay);
}

/** Gateway announced / refused with maintenance: wait until it is over, then reconnect. */
function enterMaintenance(): void {
  state.needsResync = true;
  state.needsFullResync = true;
  setMaintenance(true);
  state.socket?.disconnect();
  scheduleMaintenancePoll(Math.random() * MAINTENANCE_POLL_MS);
}

/** A consumer appeared while maintenance lasts and the poll had stopped. */
function resumeMaintenancePoll(): void {
  if (state.maintenance) scheduleMaintenancePoll(Math.random() * MAINTENANCE_POLL_MS);
}

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
      if (state.needsResync) {
        const info: ResyncInfo = { full: state.needsFullResync };
        state.needsResync = false;
        state.needsFullResync = false;
        for (const l of state.resyncListeners) l(info);
      }
    });
    socket.on('disconnect', (reason) => {
      state.needsResync = true;
      for (const l of state.statusListeners) l(false);
      // The server closed the socket (no automatic retry): reconnect unless it is maintenance.
      if (reason === 'io server disconnect' && !state.maintenance) {
        setTimeout(
          () => {
            if (!state.maintenance) socket.connect();
          },
          1_000 + Math.random() * 2_000,
        );
      }
    });
    socket.on('maintenance:start', enterMaintenance);
    socket.on('connect_error', (err) => {
      state.needsResync = true;
      if (err.message === 'maintenance') enterMaintenance();
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
  resumeMaintenancePoll();
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

/** Called after a reconnect: refetch the full seat state, deltas were missed meanwhile. */
export function onResync(listener: (info: ResyncInfo) => void): () => void {
  state.resyncListeners.add(listener);
  resumeMaintenancePoll();
  return () => state.resyncListeners.delete(listener);
}

export function onMaintenanceChange(listener: (active: boolean) => void): () => void {
  state.maintenanceListeners.add(listener);
  resumeMaintenancePoll();
  return () => state.maintenanceListeners.delete(listener);
}

export const isRealtimeMaintenance = (): boolean => state.maintenance;

export function emitRealtime(event: 'shop:ping' | 'presence:beat', payload: string): void {
  if (state.socket?.connected) state.socket.emit(event, payload);
}

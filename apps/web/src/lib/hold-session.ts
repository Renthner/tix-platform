/**
 * Stable lock-session id of one browser tab for the admin seat holds (box office, seat change).
 *
 * The id lives in `sessionStorage`: it survives client-side navigation, reloads and "restore
 * closed tab", but not a new tab. A *duplicated* tab copies sessionStorage, so two live tabs
 * would share one id (and one lock session). Tabs therefore announce themselves on a
 * BroadcastChannel: when another live tab with the same id answers within a short timeout, the
 * newcomer is a duplicate and takes a fresh id.
 */

const ANSWER_TIMEOUT_MS = 250;

interface Responder {
  id: string;
  nonce: string;
}

const responders = new Map<string, Responder>();
const channels = new Map<string, BroadcastChannel>();

function channelFor(scope: string): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  let channel = channels.get(scope);
  if (!channel) {
    channel = new BroadcastChannel(`tix.hold.${scope}`);
    channels.set(scope, channel);
  }
  return channel;
}

/** Resolves the tab's stable id for `scope` (e.g. "boxoffice", "seatchange:<orderId>"). */
export async function resolveHoldTabId(scope: string): Promise<string> {
  const storageKey = `tix.hold.${scope}`;
  const known = responders.get(scope);
  if (known) return known.id;

  const nonce = crypto.randomUUID();
  let id: string | null = null;
  try {
    id = sessionStorage.getItem(storageKey);
  } catch {
    // storage blocked: a per-load id (the old behaviour)
  }
  const found = channelFor(scope);
  if (id && found) {
    const channel = found;
    const candidate = id;
    const duplicate = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        channel.removeEventListener('message', onMessage);
        resolve(false);
      }, ANSWER_TIMEOUT_MS);
      function onMessage(event: MessageEvent) {
        const data = event.data as { type?: string; id?: string; nonce?: string } | null;
        if (data?.type === 'present' && data.id === candidate && data.nonce !== nonce) {
          clearTimeout(timer);
          channel.removeEventListener('message', onMessage);
          resolve(true);
        }
      }
      channel.addEventListener('message', onMessage);
      channel.postMessage({ type: 'hello', id: candidate, nonce });
    });
    if (duplicate) id = null;
  }
  if (!id) {
    id = crypto.randomUUID();
    try {
      sessionStorage.setItem(storageKey, id);
    } catch {
      // see above
    }
  }

  const responder: Responder = { id, nonce };
  responders.set(scope, responder);
  found?.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; id?: string; nonce?: string } | null;
    if (data?.type === 'hello' && data.id === responder.id && data.nonce !== responder.nonce) {
      found.postMessage({ type: 'present', id: responder.id, nonce: responder.nonce });
    }
  });
  return id;
}

const mountedScopes = new Set<string>();

/**
 * True when this JS document already had a page using `scope` (client-side navigation back to
 * it) – false on the first mount of a fresh document (first visit, reload, restored tab). On a
 * reload the old document's pagehide release may still be on its way, so the first mount must
 * not restore from the server: it releases explicitly and starts clean.
 */
export function remountedInDocument(scope: string): boolean {
  const again = mountedScopes.has(scope);
  mountedScopes.add(scope);
  return again;
}

/** Small JSON snapshot in sessionStorage (selection details the server does not hold). */
export function readHoldSnapshot<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(`tix.holdstate.${key}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeHoldSnapshot(key: string, value: unknown | null): void {
  try {
    if (value === null) sessionStorage.removeItem(`tix.holdstate.${key}`);
    else sessionStorage.setItem(`tix.holdstate.${key}`, JSON.stringify(value));
  } catch {
    // quota / blocked: the selection is simply not restored with its tariffs
  }
}

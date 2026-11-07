import 'server-only';
import { getMessages } from 'next-intl/server';
import type { MessageNamespace } from './namespaces';

/** Subset of messages for a client provider (keeps admin strings out of shop bundles). */
export async function pickMessages(namespaces: readonly MessageNamespace[]) {
  const all = await getMessages();
  const byNamespace = all as Record<string, unknown>;
  return Object.fromEntries(namespaces.map((ns) => [ns, byNamespace[ns]]));
}

import 'server-only';
import { getMessages } from 'next-intl/server';
import type { MessageNamespace } from './namespaces';

/** Subset of messages for a client provider (keeps admin strings out of shop bundles). */
export async function pickMessages(namespaces: readonly MessageNamespace[]) {
  const all = await getMessages();
  return Object.fromEntries(namespaces.map((ns) => [ns, all[ns]]));
}

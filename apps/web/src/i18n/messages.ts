import 'server-only';
import { getMessages } from 'next-intl/server';
import type { MessageNamespace } from './namespaces';

/** A whole namespace ("admin") or one sub-tree of it ("admin.nav"). */
export type MessageScope = MessageNamespace | `${MessageNamespace}.${string}`;

/**
 * Subset of messages for a client provider (keeps admin strings out of shop bundles).
 * Every namespace that a client component below the provider reads via `useTranslations` must be
 * listed here – `pnpm test` (scripts/check-i18n-usage.mjs) verifies this statically.
 */
export async function pickMessages(scopes: readonly MessageScope[]) {
  const all = (await getMessages()) as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const scope of scopes) {
    const [root, ...path] = scope.split('.');
    let value: unknown = all[root!];
    for (const segment of path) value = (value as Record<string, unknown> | undefined)?.[segment];
    if (value === undefined) continue;
    if (path.length === 0) {
      result[root!] = value;
      continue;
    }
    let target = (result[root!] ??= {}) as Record<string, unknown>;
    path.slice(0, -1).forEach((segment) => {
      target = (target[segment] ??= {}) as Record<string, unknown>;
    });
    target[path[path.length - 1]!] = value;
  }
  return result;
}

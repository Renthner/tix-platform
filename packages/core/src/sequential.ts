/**
 * Awaits lazily executed queries one after another. A transaction owns a single connection –
 * `Promise.all` over `tx` queries would issue concurrent `client.query()` calls, which
 * node-postgres deprecates (pg@9 rejects them). Drizzle query builders only run when awaited,
 * so passing them here keeps the order and the tuple typing of `Promise.all`.
 */
export async function sequential<const T extends readonly unknown[]>(
  queries: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const results: unknown[] = [];
  for (const query of queries) results.push(await query);
  return results as { -readonly [K in keyof T]: Awaited<T[K]> };
}

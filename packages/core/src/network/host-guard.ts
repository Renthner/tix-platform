import { lookup as lookupAsync } from 'node:dns/promises';
import { isIP } from 'node:net';
import { EndpointNotAllowedError, assertSafeEndpoint, parseIPv6 } from '../backup/endpoint-guard';

/**
 * SSRF guard for admin-configured mail hosts (SMTP, IMAP). Unlike the strict guard used for
 * HTTPS endpoints (`assertSafeEndpoint`), private LAN ranges stay allowed here – self-hosted
 * mail relays live there. Blocked are only targets that make no sense for a mail server and are
 * dangerous to reach from the stack: loopback, link-local / cloud metadata addresses and the
 * stack's own internal services (database, Redis, object storage, app containers).
 */

/**
 * Compose service names of this stack plus `localhost`. `host.docker.internal` is deliberately
 * not listed: a mail relay on the Docker host is a legitimate setup.
 */
export const INTERNAL_SERVICE_HOSTNAMES = [
  'localhost',
  'postgres',
  'redis',
  'minio',
  'web',
  'worker',
  'realtime',
  'proxy',
] as const;

/** Names that are blocked by name alone (they never resolve to anything useful for mail). */
const LOCAL_ONLY_NAMES = new Set(['localhost']);

function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function isBlockedV4(a: number, b: number, c: number, d: number): boolean {
  return (
    a === 0 || // "this" network / unspecified
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local incl. cloud metadata 169.254.169.254
    (a === 100 && b === 100 && c === 100 && d === 200) // Alibaba Cloud metadata
  );
}

/** Canonical text of an address (IPv4-mapped IPv6 collapses to dotted IPv4) for set comparison. */
export function canonicalAddress(address: string): string {
  const text = address.trim().toLowerCase();
  if (isIP(text) === 4) return text;
  const g = parseIPv6(text);
  if (!g) return text;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
  }
  return g.map((x) => x.toString(16)).join(':');
}

/**
 * True for loopback, unspecified, link-local and cloud-metadata addresses. IPv6 forms that embed
 * an IPv4 address (::ffff:a.b.c.d, 64:ff9b::/96, 2002::/16) are judged by the embedded address;
 * unparsable input counts as blocked.
 */
export function isBlockedMailAddress(address: string): boolean {
  const text = address.trim();
  if (isIP(text) === 4) {
    const [a, b, c, d] = text.split('.').map(Number) as [number, number, number, number];
    return isBlockedV4(a, b, c, d);
  }
  const g = parseIPv6(text);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => isBlockedV4(hi >> 8, hi & 0xff, lo >> 8, lo & 0xff);
  const firstFiveZero = g.slice(0, 5).every((x) => x === 0);
  if (firstFiveZero && g[5] === 0xffff) return embedded(g[6]!, g[7]!); // ::ffff:a.b.c.d
  if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return embedded(g[6]!, g[7]!); // NAT64
  }
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!); // 6to4
  return (
    (g[0]! & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (g[0] === 0xfd00 && g[1] === 0x0ec2 && g.slice(2, 7).every((x) => x === 0) && g[7] === 0x254) // AWS IPv6 metadata
  );
}

/** Classification of a host name or address literal without any DNS lookup. */
export function classifyMailHostName(host: string): 'INTERNAL_NAME' | 'BLOCKED_ADDRESS' | null {
  const h = normalizeHost(host);
  if (!h) return null;
  if (
    (INTERNAL_SERVICE_HOSTNAMES as readonly string[]).includes(h) ||
    LOCAL_ONLY_NAMES.has(h) ||
    h.endsWith('.localhost')
  ) {
    return 'INTERNAL_NAME';
  }
  if (isIP(h) !== 0 && isBlockedMailAddress(h)) return 'BLOCKED_ADDRESS';
  return null;
}

/**
 * FinTS bank servers (admin-configured URL, or the URL announced in the bank's parameter data):
 * HTTPS only and public addresses only – the strict rules of the S3 endpoint guard. A host that
 * does not resolve at all passes here; the connection attempt then fails on its own.
 */
export async function assertBankEndpointAllowed(url: string): Promise<void> {
  try {
    await assertSafeEndpoint(url, { allowInsecure: false, allowPrivate: false });
  } catch (err) {
    if (err instanceof EndpointNotAllowedError) throw err;
  }
}

export type HostResolver = (hostname: string) => Promise<string[]>;

const defaultResolver: HostResolver = async (hostname) =>
  (await lookupAsync(hostname, { all: true })).map((a) => a.address);

const INTERNAL_ADDRESS_TTL_MS = 60_000;

interface InternalAddressEntry {
  expires: number;
  pending: Promise<Set<string>> | null;
  value: Set<string> | null;
}

/** One cache entry per resolver, so injected test resolvers never see each other's results. */
const internalAddressCache = new WeakMap<HostResolver, InternalAddressEntry>();

async function resolveInternalAddresses(resolve: HostResolver): Promise<Set<string>> {
  const internal = new Set<string>();
  await Promise.all(
    INTERNAL_SERVICE_HOSTNAMES.filter((n) => !LOCAL_ONLY_NAMES.has(n)).map(async (name) => {
      try {
        for (const address of await resolve(name)) internal.add(canonicalAddress(address));
      } catch {
        // Not resolvable here (e.g. development without the compose network).
      }
    }),
  );
  return internal;
}

/**
 * Addresses of the stack's internal services, cached for ~60 s (a mail send would otherwise cost
 * one DNS lookup per service name). Concurrent callers share one in-flight resolution.
 */
async function internalServiceAddresses(resolve: HostResolver): Promise<Set<string>> {
  let entry = internalAddressCache.get(resolve);
  if (!entry) {
    entry = { expires: 0, pending: null, value: null };
    internalAddressCache.set(resolve, entry);
  }
  if (entry.value && Date.now() < entry.expires) return entry.value;
  if (entry.pending) return entry.pending;
  const current = entry;
  const pending = resolveInternalAddresses(resolve)
    .then((value) => {
      current.value = value;
      current.expires = Date.now() + INTERNAL_ADDRESS_TTL_MS;
      return value;
    })
    .finally(() => {
      current.pending = null;
    });
  current.pending = pending;
  return pending;
}

/** Test hook: forgets cached service addresses of the default resolver. */
export function resetMailHostGuardCache(): void {
  internalAddressCache.delete(defaultResolver);
}

/**
 * Throws `EndpointNotAllowedError` when `host` must not be used as SMTP / IMAP server: it is an
 * internal service name, a blocked address literal, or it resolves to a blocked address or to the
 * address of one of the stack's internal services. Unresolvable hosts pass (the connection
 * attempt fails on its own). Call right before connecting to narrow the DNS-rebinding window.
 */
export async function assertMailHostAllowed(
  host: string,
  resolve: HostResolver = defaultResolver,
): Promise<void> {
  const h = normalizeHost(host);
  const byName = classifyMailHostName(h);
  if (byName) {
    throw new EndpointNotAllowedError(
      byName === 'INTERNAL_NAME'
        ? 'This host name belongs to an internal service'
        : 'This address is not allowed (loopback, link-local or metadata)',
    );
  }
  if (isIP(h) !== 0) return;
  let addresses: string[];
  try {
    addresses = await resolve(h);
  } catch {
    return;
  }
  if (addresses.some(isBlockedMailAddress)) {
    throw new EndpointNotAllowedError(
      'The host resolves to a loopback, link-local or metadata address',
    );
  }
  const internal = await internalServiceAddresses(resolve);
  if (addresses.some((a) => internal.has(canonicalAddress(a)))) {
    throw new EndpointNotAllowedError('The host resolves to an internal service of this stack');
  }
}

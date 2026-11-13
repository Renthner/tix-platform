import { lookup as dnsLookup, type LookupOptions } from 'node:dns';
import { lookup as lookupAsync } from 'node:dns/promises';
import { isIP } from 'node:net';

export class EndpointNotAllowedError extends Error {
  override name = 'EndpointNotAllowedError';
}

function isNonPublicV4(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    a >= 224
  );
}

/** Eight 16-bit groups of an IPv6 address (handles "::" and an embedded dotted IPv4). */
export function parseIPv6(address: string): number[] | null {
  let text = address.toLowerCase().split('%')[0]!;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [, a, b, c, d] = dotted.map(Number) as [number, number, number, number, number];
    text =
      text.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

/**
 * True for loopback, private, link-local (cloud metadata), CGNAT and other non-public addresses.
 * IPv6 forms that embed an IPv4 address (::ffff:7f00:1, ::7f00:1, 64:ff9b::, 2002:) are judged by
 * the embedded address; unparsable input counts as non-public.
 */
export function isNonPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return isNonPublicV4(a, b);
  }
  const g = parseIPv6(address);
  if (!g) return true;
  const v4 = (hi: number, lo: number) => {
    void lo;
    return isNonPublicV4(hi >> 8, hi & 0xff);
  };
  const firstFiveZero = g.slice(0, 5).every((x) => x === 0);
  if (firstFiveZero && g[5] === 0xffff) return v4(g[6]!, g[7]!); // ::ffff:a.b.c.d
  if (firstFiveZero && g[5] === 0) return true; // ::/96 (unspecified, loopback, v4-compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return v4(g[6]!, g[7]!); // 64:ff9b::/96 NAT64
  }
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!); // 6to4
  return (
    (g[0]! & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (g[0]! & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (g[0]! & 0xff00) === 0xff00 // multicast
  );
}

/**
 * Agent `lookup` that refuses to connect to non-public addresses (DNS rebinding protection: the
 * address that is checked is the address that is used).
 */
export function guardedLookup(allowPrivate: boolean) {
  return (
    hostname: string,
    options: unknown,
    callback: (err: Error | null, address?: unknown, family?: number) => void,
  ) => {
    const opts = (typeof options === 'object' && options ? options : {}) as LookupOptions;
    dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses as { address: string; family: number }[];
      if (!allowPrivate && list.some((a) => isNonPublicAddress(a.address))) {
        return callback(
          new EndpointNotAllowedError('The endpoint resolves to a non-public address'),
        );
      }
      if (opts.all) return callback(null, list);
      const first = list[0]!;
      return callback(null, first.address, first.family);
    });
  };
}

/**
 * The external target is an admin-configured URL the server connects to: unless explicitly
 * allowed it must be https and must not resolve to a non-public address (SSRF protection).
 */
export async function assertSafeEndpoint(
  endpoint: string,
  options: { allowInsecure: boolean; allowPrivate: boolean },
): Promise<void> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new EndpointNotAllowedError('Invalid endpoint URL');
  }
  if (url.protocol !== 'https:' && !(options.allowInsecure && url.protocol === 'http:')) {
    throw new EndpointNotAllowedError('Only https endpoints are allowed');
  }
  if (options.allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : (await lookupAsync(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isNonPublicAddress)) {
    throw new EndpointNotAllowedError('The endpoint resolves to a non-public address');
  }
}

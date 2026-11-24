import { isIP } from 'node:net';

/**
 * Rate-limit subject for a client address. An IPv6 client usually controls a whole /64 (or more),
 * so keying limits by the full address lets an attacker rotate addresses for free: IPv6 is
 * reduced to its /64 prefix. IPv4 and IPv4-mapped IPv6 (`::ffff:a.b.c.d`) stay as the IPv4
 * address. Anything that is not an IP address is returned unchanged.
 */
export function rateLimitIpSubject(ip: string): string {
  const raw = ip.trim().replace(/^\[|\]$/g, '');
  const zoneless = raw.split('%')[0]!;
  const version = isIP(zoneless);
  if (version === 4) return zoneless;
  if (version !== 6) return ip;
  const lower = zoneless.toLowerCase();
  const mapped = /^(?:0{0,4}:){2,5}ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!;
  let groups: string[];
  const dbl = lower.indexOf('::');
  if (dbl >= 0) {
    const head = lower.slice(0, dbl).split(':').filter(Boolean);
    const tail = lower
      .slice(dbl + 2)
      .split(':')
      .filter(Boolean);
    groups = [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  } else {
    groups = lower.split(':');
  }
  if (groups.length !== 8 || groups.some((g) => g.includes('.'))) return lower;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

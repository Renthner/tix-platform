import { describe, expect, it } from 'vitest';
import { rateLimitIpSubject } from '../src/network/ip-subject';

describe('rateLimitIpSubject', () => {
  it('keeps IPv4 and unwraps IPv4-mapped IPv6', () => {
    expect(rateLimitIpSubject('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitIpSubject('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitIpSubject('0.0.0.0')).toBe('0.0.0.0');
  });

  it('reduces IPv6 to the /64 prefix (compressed or not)', () => {
    const a = rateLimitIpSubject('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    expect(a).toBe('2001:db8:1:2::/64');
    expect(rateLimitIpSubject('2001:0db8:0001:0002::1')).toBe(a);
    expect(rateLimitIpSubject('2001:DB8:1:2:ffff:ffff:ffff:ffff')).toBe(a);
    expect(rateLimitIpSubject('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitIpSubject('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitIpSubject('2001:db8:1:3::1')).not.toBe(a);
    expect(rateLimitIpSubject('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('leaves non-addresses alone', () => {
    expect(rateLimitIpSubject('unknown')).toBe('unknown');
  });
});

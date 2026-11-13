import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EndpointNotAllowedError } from '../src/backup/endpoint-guard';
import {
  assertBankEndpointAllowed,
  assertMailHostAllowed,
  canonicalAddress,
  classifyMailHostName,
  isBlockedMailAddress,
} from '../src/network/host-guard';

describe('mail host guard (SMTP / IMAP)', () => {
  it('blocks loopback, unspecified, link-local and metadata addresses', () => {
    for (const a of [
      '127.0.0.1',
      '127.8.9.10',
      '0.0.0.0',
      '169.254.169.254',
      '169.254.0.1',
      '100.100.100.200',
      '::1',
      '::',
      'fe80::1',
      'febf::1',
      'fd00:ec2::254',
      '::ffff:127.0.0.1',
      '::ffff:a9fe:a9fe',
      '64:ff9b::7f00:1',
      'not-an-address:::',
    ]) {
      expect(isBlockedMailAddress(a), a).toBe(true);
    }
  });

  it('allows private LAN ranges and public addresses (self-hosted relays)', () => {
    for (const a of [
      '10.0.0.5',
      '172.16.4.2',
      '192.168.1.20',
      '100.64.0.1',
      '93.184.216.34',
      '2001:db8::1',
      'fd12:3456::1',
      '::ffff:192.168.1.1',
    ]) {
      expect(isBlockedMailAddress(a), a).toBe(false);
    }
  });

  it('classifies internal service names and literals without DNS', () => {
    for (const h of [
      'postgres',
      'Redis',
      'minio.',
      'web',
      'worker',
      'realtime',
      'proxy',
      'localhost',
    ]) {
      expect(classifyMailHostName(h), h).toBe('INTERNAL_NAME');
    }
    expect(classifyMailHostName('app.localhost')).toBe('INTERNAL_NAME');
    expect(classifyMailHostName('[::1]')).toBe('BLOCKED_ADDRESS');
    expect(classifyMailHostName('169.254.169.254')).toBe('BLOCKED_ADDRESS');
    expect(classifyMailHostName('smtp.example.org')).toBeNull();
    expect(classifyMailHostName('192.168.0.10')).toBeNull();
    // A mail relay on the Docker host is a legitimate setup.
    expect(classifyMailHostName('host.docker.internal')).toBeNull();
    expect(classifyMailHostName('gateway.docker.internal')).toBeNull();
  });

  it('canonicalises mapped IPv6 addresses for comparison', () => {
    expect(canonicalAddress('::ffff:10.0.0.4')).toBe('10.0.0.4');
    expect(canonicalAddress('10.0.0.4')).toBe('10.0.0.4');
  });

  it('rejects hosts resolving to blocked addresses or to the stack’s own services', async () => {
    const dns: Record<string, string[]> = {
      'mail.example.org': ['93.184.216.34'],
      'relay.lan.example': ['192.168.1.20'],
      'rebind.example.org': ['127.0.0.1'],
      'meta.example.org': ['93.184.216.34', '169.254.169.254'],
      'alias.example.org': ['172.20.0.3'],
      postgres: ['172.20.0.3'],
      redis: ['172.20.0.4'],
    };
    const resolve = async (host: string) => {
      const found = dns[host];
      if (!found) throw new Error('ENOTFOUND');
      return found;
    };
    await expect(assertMailHostAllowed('mail.example.org', resolve)).resolves.toBeUndefined();
    await expect(assertMailHostAllowed('relay.lan.example', resolve)).resolves.toBeUndefined();
    await expect(assertMailHostAllowed('unresolvable.example', resolve)).resolves.toBeUndefined();
    await expect(assertMailHostAllowed('192.168.1.20', resolve)).resolves.toBeUndefined();
    for (const host of [
      'rebind.example.org',
      'meta.example.org',
      'alias.example.org',
      'postgres',
      '127.0.0.1',
      '169.254.169.254',
    ]) {
      await expect(assertMailHostAllowed(host, resolve), host).rejects.toBeInstanceOf(
        EndpointNotAllowedError,
      );
    }
  });
});

describe('mail host guard – service address cache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves the service names once per minute and shares in-flight lookups', async () => {
    const calls: string[] = [];
    const resolve = vi.fn(async (host: string) => {
      calls.push(host);
      await Promise.resolve();
      if (host === 'postgres') return ['172.20.0.3'];
      if (host === 'alias.example.org') return ['172.20.0.3'];
      if (host === 'mail.example.org') return ['93.184.216.34'];
      throw new Error('ENOTFOUND');
    });
    // Concurrent callers share one resolution of the service names.
    const results = await Promise.allSettled([
      assertMailHostAllowed('mail.example.org', resolve),
      assertMailHostAllowed('mail.example.org', resolve),
      assertMailHostAllowed('alias.example.org', resolve),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    expect(calls.filter((c) => c === 'postgres')).toHaveLength(1);

    await assertMailHostAllowed('mail.example.org', resolve);
    expect(calls.filter((c) => c === 'postgres')).toHaveLength(1);

    vi.advanceTimersByTime(61_000);
    await assertMailHostAllowed('mail.example.org', resolve);
    expect(calls.filter((c) => c === 'postgres')).toHaveLength(2);
  });
});

describe('bank endpoint guard (FinTS)', () => {
  it('requires https and public addresses', async () => {
    await expect(assertBankEndpointAllowed('http://bank.example.org/fints')).rejects.toBeInstanceOf(
      EndpointNotAllowedError,
    );
    for (const url of [
      'https://127.0.0.1/fints',
      'https://10.0.0.5/fints',
      'https://192.168.1.1/fints',
      'https://169.254.169.254/latest',
      'https://[::1]/fints',
    ]) {
      await expect(assertBankEndpointAllowed(url), url).rejects.toBeInstanceOf(
        EndpointNotAllowedError,
      );
    }
    await expect(assertBankEndpointAllowed('https://93.184.216.34/fints')).resolves.toBeUndefined();
    // Unresolvable hosts pass; the connection attempt fails by itself.
    await expect(
      assertBankEndpointAllowed('https://fints.does-not-exist.invalid/fints'),
    ).resolves.toBeUndefined();
  });
});

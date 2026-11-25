import { imapConfigSchema } from '@tix/shared';
import { describe, expect, it } from 'vitest';
import {
  classifyMail,
  isTrustedMailAuth,
  parseAuthenticationResults,
  parseAuthenticationResultsHeader,
  senderAllowed,
} from '../src/banking/adapters/imap-policy';

const allow = ['@bank.example'];
const base = { maxBytes: 1000, from: 'noreply@bank.example', subject: 'Umsatz', allowlist: allow };

describe('IMAP policy', () => {
  it('requires a non-empty allow-list (schema and matcher fail closed)', () => {
    const cfg = { adapter: 'IMAP', host: 'imap.example', username: 'u' };
    expect(imapConfigSchema.safeParse({ ...cfg, senderAllowlist: [] }).success).toBe(false);
    expect(imapConfigSchema.safeParse(cfg).success).toBe(false);
    expect(imapConfigSchema.safeParse({ ...cfg, senderAllowlist: ['@bank.example'] }).success).toBe(
      true,
    );
    expect(senderAllowed('a@bank.example', [])).toBe(false);
    expect(senderAllowed('a@evilbank.example', allow)).toBe(false);
  });

  it('classifies skipped mails so they can be flagged', () => {
    expect(classifyMail({ ...base, size: 10 })).toBeNull();
    expect(classifyMail({ ...base, size: 5000 })).toBe('OVERSIZE');
    expect(classifyMail({ ...base, size: 10, from: 'x@other.example' })).toBe('SENDER');
    expect(classifyMail({ ...base, size: 10, from: null })).toBe('SENDER');
    expect(classifyMail({ ...base, size: 10, subjectFilter: 'kontoauszug' })).toBe('SUBJECT');
    expect(classifyMail({ ...base, size: 10, subjectFilter: 'umsatz' })).toBeNull();
    expect(classifyMail({ ...base, size: 10, allowlist: [] })).toBe('SENDER');
  });

  it('parses Authentication-Results', () => {
    const r = parseAuthenticationResults(
      'mx.example.org; dkim=pass (good signature) header.d=Bank.Example header.s=sel; spf=fail smtp.mailfrom=x@y.example',
    );
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({
      method: 'dkim',
      result: 'pass',
      props: { 'header.d': 'bank.example' },
    });
    expect(r[1]).toMatchObject({ method: 'spf', result: 'fail' });
    expect(parseAuthenticationResults('mx.example.org; none')).toEqual([]);
  });

  it('parses quoted strings, escapes and nested comments (RFC 8601)', () => {
    const p = parseAuthenticationResultsHeader(
      'MX.Example.org 1 (c (nested \\) ok)); dkim=pass reason="a; b" header.d="bank.example" (x; y); spf=pass smtp.mailfrom="a\\"b@x.example"',
    );
    expect(p.authservId).toBe('mx.example.org');
    expect(p.results).toHaveLength(2);
    expect(p.results[0]).toMatchObject({ method: 'dkim', props: { 'header.d': 'bank.example' } });
    // unterminated comment / quote: the segment is dropped
    expect(
      parseAuthenticationResultsHeader('mx; dkim=pass header.d=bank.example (oops').results,
    ).toEqual([]);
    expect(
      parseAuthenticationResultsHeader('mx; dkim=pass header.d="bank.example').results,
    ).toEqual([]);
    expect(
      parseAuthenticationResultsHeader('mx; dkim=pass header.d="bank.example; spf=pass').results,
    ).toEqual([]);
  });

  describe('trust', () => {
    const t = (
      header: string | string[] | undefined,
      from = 'noreply@bank.example',
      trustedAuthservId: string | null | undefined = 'mx',
      list: string[] = allow,
    ) =>
      isTrustedMailAuth({
        authenticationResults: header,
        from,
        allowlist: list,
        trustedAuthservId,
      });

    it('is fail closed without trustedAuthservId', () => {
      expect(
        isTrustedMailAuth({
          authenticationResults: 'mx; dkim=pass header.d=bank.example',
          from: 'noreply@bank.example',
          allowlist: allow,
        }),
      ).toBe(false);
      expect(t('mx; dkim=pass header.d=bank.example', undefined, '')).toBe(false);
      expect(t('mx; dkim=pass header.d=bank.example', undefined, null)).toBe(false);
    });

    it('trusts dkim=pass with aligned header.d, or dmarc=pass with aligned header.from', () => {
      expect(t('mx; dkim=pass header.d=bank.example')).toBe(true);
      expect(t('MX; dmarc=pass header.from=bank.example')).toBe(true);
      expect(t('mx; dmarc=pass header.from=attacker.example')).toBe(false);
      expect(t('mx; dkim=pass header.d=attacker.example')).toBe(false);
      expect(t('mx; dkim=fail header.d=bank.example; dmarc=fail header.from=bank.example')).toBe(
        false,
      );
      expect(t('mx; dkim=none')).toBe(false);
      expect(t(undefined)).toBe(false);
      expect(t('mx; dkim=pass header.d=bank.example', 'x@other.example')).toBe(false);
    });

    it('does not trust SPF alone', () => {
      expect(t('mx; spf=pass smtp.mailfrom=noreply@bank.example')).toBe(false);
    });

    it('only the topmost header of the trusted authserv-id counts', () => {
      expect(t(['evil; dkim=pass header.d=bank.example'])).toBe(false);
      expect(
        t(['other; dkim=pass header.d=bank.example', 'mx; dkim=fail header.d=bank.example']),
      ).toBe(false);
      expect(
        t(['other; dkim=fail header.d=bank.example', 'mx; dkim=pass header.d=bank.example']),
      ).toBe(true);
      expect(
        t(['mx; dkim=fail header.d=bank.example', 'mx; dkim=pass header.d=bank.example']),
      ).toBe(false);
      // look-alike ids do not match
      expect(t('mx.evil; dkim=pass header.d=bank.example')).toBe(false);
      expect(t('evil.mx; dkim=pass header.d=bank.example')).toBe(false);
    });

    it('aligns on the organisational level in both directions without public suffixes', () => {
      const sub = ['@mail.bank.example'];
      // d= is parent of the from domain
      expect(t('mx; dkim=pass header.d=bank.example', 'a@mail.bank.example', 'mx', sub)).toBe(true);
      // d= is child of the from domain
      expect(t('mx; dkim=pass header.d=mail.bank.example')).toBe(true);
      // public suffixes never align
      const uk = ['@shop.co.uk'];
      expect(t('mx; dkim=pass header.d=co.uk', 'a@shop.co.uk', 'mx', uk)).toBe(false);
      expect(t('mx; dkim=pass header.d=com', 'a@bank.com', 'mx', ['@bank.com'])).toBe(false);
      expect(t('mx; dkim=pass header.d=other.co.uk', 'a@shop.co.uk', 'mx', uk)).toBe(false);
      expect(t('mx; dkim=pass header.d=shop.co.uk', 'a@shop.co.uk', 'mx', uk)).toBe(true);
    });

    it('rejects odd domain values', () => {
      expect(t('mx; dkim=pass header.d="bank.example evil"')).toBe(false);
      expect(t('mx; dkim=pass header.d=bank.example/../x')).toBe(false);
    });
  });
});

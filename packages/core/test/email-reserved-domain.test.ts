import { describe, expect, it } from 'vitest';
import { RESERVED_DOMAIN_SKIP_REASON, isReservedRecipient } from '../src';

describe('isReservedRecipient', () => {
  it('matches the RFC 2606 example domains and their subdomains', () => {
    for (const address of [
      'a@example.com',
      'a@example.org',
      'a@example.net',
      'a@shop.example.com',
      'A@EXAMPLE.ORG',
      'a@example.org.',
      ' a@sub.example.net ',
    ]) {
      expect(isReservedRecipient(address), address).toBe(true);
    }
  });

  it('matches the reserved TLDs .example, .test, .invalid and .localhost', () => {
    for (const address of [
      'a@bank.example',
      'a@shop.test',
      'a@example.invalid',
      'a@foo.localhost',
      'a@localhost',
    ]) {
      expect(isReservedRecipient(address), address).toBe(true);
    }
  });

  it('does not match look-alikes or real domains', () => {
    for (const address of [
      'a@example.com.evil.de',
      'a@notexample.com',
      'a@example.co',
      'a@test.de',
      'a@invalid.org',
      'a@localhost.de',
      'example.com@real-shop.de',
      'no-address',
    ]) {
      expect(isReservedRecipient(address), address).toBe(false);
    }
  });

  it('marks the skip reason with a stable prefix', () => {
    expect(RESERVED_DOMAIN_SKIP_REASON).toMatch(/^skipped: /);
  });
});

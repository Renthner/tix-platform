/**
 * Recipients on domains reserved for documentation and testing (RFC 2606 / RFC 6761) can never
 * receive mail: handing them to the SMTP server only produces bounces. Generated demo orders use
 * such addresses, so the outbox marks these messages SKIPPED instead of sending them.
 */

/** Second-level domains reserved by RFC 2606 (the domain itself and every subdomain). */
const RESERVED_DOMAINS = ['example.com', 'example.org', 'example.net'] as const;
/** Top-level domains reserved by RFC 2606 / RFC 6761. */
const RESERVED_TLDS = ['example', 'test', 'invalid', 'localhost'] as const;

/** `lastError` prefix of messages that were deliberately not sent (status SKIPPED). */
export const EMAIL_SKIPPED_PREFIX = 'skipped:';
export const RESERVED_DOMAIN_SKIP_REASON = `${EMAIL_SKIPPED_PREFIX} the recipient domain is reserved for examples/testing (RFC 2606/6761) and cannot receive e-mail`;

/** Domain part of an address (after the last `@`), lower-cased, without a trailing dot. */
function domainOf(address: string): string | null {
  const at = address.trim().lastIndexOf('@');
  if (at < 0) return null;
  const domain = address
    .trim()
    .slice(at + 1)
    .replace(/>+$/, '')
    .toLowerCase()
    .replace(/\.$/, '');
  return domain || null;
}

/** True when the recipient's domain is reserved and can never receive e-mail. */
export function isReservedRecipient(address: string): boolean {
  const domain = domainOf(address);
  if (!domain) return false;
  if (RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  return (RESERVED_TLDS as readonly string[]).includes(tld);
}

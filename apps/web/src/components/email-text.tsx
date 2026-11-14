import { emailTextHtml, mailtoLinkHtml } from '@tix/shared';
import type { ElementType } from 'react';

/**
 * Text that may contain e-mail addresses (e.g. a translated sentence with the customer's address).
 * Behind Cloudflare the "Email Address Obfuscation" feature rewrites every address in the HTML
 * and injects a script our CSP blocks ("[email protected]"); the opt-out comments around each
 * address keep it intact. The text is escaped here, so only the markers are markup.
 */
export function EmailText({
  text,
  as: Tag = 'span',
  className,
}: {
  text: string;
  as?: ElementType;
  className?: string;
}) {
  return <Tag className={className} dangerouslySetInnerHTML={{ __html: emailTextHtml(text) }} />;
}

/** `mailto:` link that survives Cloudflare's e-mail obfuscation. */
export function MailtoLink({
  email,
  label,
  className,
}: {
  email: string;
  label?: string;
  className?: string;
}) {
  return (
    <span
      className="contents"
      dangerouslySetInnerHTML={{ __html: mailtoLinkHtml(email, label, className) }}
    />
  );
}

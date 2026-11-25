import { escapeHtml, trustedHtml, type TrustedHtml } from './template';

/**
 * Free text written by an admin (ORDER_MESSAGE / EVENT_MESSAGE) → safe e-mail HTML: everything is
 * escaped, blank lines separate paragraphs, single line breaks become `<br>`. The plain-text
 * alternative is the text itself. Stored as a plain string in the outbox and converted when the
 * message is rendered (the stored variables are JSON, so they cannot carry trusted HTML).
 */
export function messageBodyVariable(text: string): TrustedHtml {
  const normalised = text.replace(/\r\n?/g, '\n').trim();
  const html = normalised
    .split(/\n{2,}/)
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.55">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`,
    )
    .join('\n');
  return trustedHtml(html, normalised);
}

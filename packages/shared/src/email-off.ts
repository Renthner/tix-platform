/**
 * Cloudflare "Email Address Obfuscation" rewrites every e-mail address in the HTML into a
 * `/cdn-cgi/l/email-protection` link plus an injected script (which our CSP blocks), so visitors
 * would see "[email protected]". Content between the opt-out comments is left alone. Applied at
 * render time (after sanitising: the sanitizer strips comments, so they never reach storage).
 */
export const EMAIL_OFF_OPEN = '<!--email_off-->';
export const EMAIL_OFF_CLOSE = '<!--/email_off-->';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const TOKEN = /(<!--[\s\S]*?-->|<[^>]*>)/;
const OPEN_MAILTO_A = /^<a\b[^>]*\bhref\s*=\s*["']?\s*mailto:/i;

const wrap = (html: string) => `${EMAIL_OFF_OPEN}${html}${EMAIL_OFF_CLOSE}`;

/**
 * Wraps every `mailto:` link and every plain e-mail address in the text of sanitised HTML.
 * Idempotent: regions that already sit between the markers are left as they are.
 */
export function protectEmailsInHtml(html: string): string {
  if (!html || !html.includes('@')) return html;
  const parts = html.split(TOKEN);
  let out = '';
  let off = 0; // inside <!--email_off--> … <!--/email_off-->
  let anchorDepth = 0; // inside a mailto link we opened the marker for
  let skip = 0; // inside <script>/<style>/<a> that already got wrapped
  for (const part of parts) {
    if (part === '') continue;
    if (part.startsWith('<!--')) {
      if (part === EMAIL_OFF_OPEN) off += 1;
      else if (part === EMAIL_OFF_CLOSE) off = Math.max(0, off - 1);
      out += part;
    } else if (part.startsWith('<')) {
      if (off === 0 && anchorDepth === 0 && OPEN_MAILTO_A.test(part)) {
        out += EMAIL_OFF_OPEN + part;
        anchorDepth = 1;
      } else if (anchorDepth > 0 && /^<a\b/i.test(part)) {
        anchorDepth += 1;
        out += part;
      } else if (anchorDepth > 0 && /^<\/a\s*>/i.test(part)) {
        out += part;
        anchorDepth -= 1;
        if (anchorDepth === 0) out += EMAIL_OFF_CLOSE;
      } else {
        if (/^<(script|style)\b/i.test(part)) skip += 1;
        else if (/^<\/(script|style)\s*>/i.test(part)) skip = Math.max(0, skip - 1);
        out += part;
      }
    } else if (off > 0 || anchorDepth > 0 || skip > 0) {
      out += part;
    } else {
      out += part.replace(EMAIL, (match) => wrap(match));
    }
  }
  // An unclosed mailto link: close the region so the page markup stays balanced.
  if (anchorDepth > 0) out += EMAIL_OFF_CLOSE;
  return out;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Plain text (escaped) with every e-mail address protected; for `dangerouslySetInnerHTML`. */
export function emailTextHtml(text: string): string {
  return protectEmailsInHtml(escapeHtml(text));
}

/** `<a href="mailto:…">` for an address (or a custom label), escaped and protected. */
export function mailtoLinkHtml(email: string, label?: string, className?: string): string {
  const cls = className ? ` class="${escapeHtml(className)}"` : '';
  return wrap(
    `<a href="mailto:${escapeHtml(encodeURIComponent(email).replace(/%40/g, '@'))}"${cls}>${escapeHtml(label ?? email)}</a>`,
  );
}

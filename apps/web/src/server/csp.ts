/**
 * Content-Security-Policy for HTML responses (built per request in `proxy.ts`).
 *
 * Nonce + 'strict-dynamic': Next.js reads the nonce from the request's CSP header and stamps
 * its own scripts with it. `style-src 'unsafe-inline'` stays because Konva, TipTap and React
 * inline `style` attributes need it. `upgrade-insecure-requests` is only sent when the app
 * itself is served over https, so plain-http installs keep working.
 */
export function newNonce(): string {
  return btoa(crypto.randomUUID());
}

export function buildCsp(nonce: string, env: Record<string, string | undefined>): string {
  const dev = env.NODE_ENV === 'development';
  const connect = ["'self'"];
  // The realtime gateway may live on another origin (REALTIME_PUBLIC_URL); sockets use ws(s).
  if (env.REALTIME_PUBLIC_URL) {
    try {
      const u = new URL(env.REALTIME_PUBLIC_URL);
      connect.push(u.origin, `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`);
    } catch {
      // invalid URL: env validation reports it elsewhere
    }
  }
  if (dev) connect.push('ws:', 'http://localhost:*');
  const https = (env.APP_URL ?? '').startsWith('https://');
  const directives = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    // https: lets the e-mail template preview show remotely hosted images; images cannot run code.
    `img-src 'self' data: blob: https:`,
    `font-src 'self' data:`,
    `connect-src ${connect.join(' ')}`,
    `frame-src 'self' blob:`,
    `media-src 'self'`,
    // Chrome renders the ticket designer's blob: PDF preview (iframe, designer.tsx) through its PDF
    // plugin, which object-src 'none' blocks; foreign plugins stay blocked.
    `object-src 'self' blob:`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ];
  if (https) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

'use client';

import { useEffect } from 'react';

/** Colours live in CSS so the page follows the OS light/dark preference (no theme cookie here). */
const GLOBAL_ERROR_CSS = `.ge{color:#18181b;background:#fff}.ge-muted{color:#52525b}.ge-btn{background:#18181b;color:#fff}
@media (prefers-color-scheme:dark){.ge{color:#fafafa;background:#18181b}.ge-muted{color:#a1a1aa}.ge-btn{background:#fafafa;color:#18181b}}`;

/**
 * Last resort when the root layout itself fails: no intl provider, no CSS → static bilingual text
 * with inline styles.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Global error', error.digest ?? 'no-digest');
  }, [error.digest]);
  return (
    <html lang="en">
      <head>
        <style>{GLOBAL_ERROR_CSS}</style>
      </head>
      <body
        className="ge"
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <main style={{ maxWidth: 420, padding: 24, textAlign: 'center' }}>
          <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>
            Something went wrong / Etwas ist schiefgelaufen
          </h1>
          <p className="ge-muted" style={{ margin: '0 0 16px' }}>
            An unexpected error occurred. Please try again.
            <br />
            Es ist ein unerwarteter Fehler aufgetreten. Bitte versuche es erneut.
          </p>
          {error.digest && (
            <p className="ge-muted" style={{ fontFamily: 'monospace', fontSize: 12 }}>
              {error.digest}
            </p>
          )}
          <button
            className="ge-btn"
            type="button"
            onClick={() => reset()}
            style={{
              padding: '8px 16px',
              borderRadius: 6,
              border: 0,
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            Try again / Erneut versuchen
          </button>
        </main>
      </body>
    </html>
  );
}

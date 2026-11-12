'use client';

import { useEffect } from 'react';

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
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          color: '#18181b',
          background: '#ffffff',
        }}
      >
        <main style={{ maxWidth: 420, padding: 24, textAlign: 'center' }}>
          <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>
            Something went wrong / Etwas ist schiefgelaufen
          </h1>
          <p style={{ margin: '0 0 16px', color: '#52525b' }}>
            An unexpected error occurred. Please try again.
            <br />
            Es ist ein unerwarteter Fehler aufgetreten. Bitte versuche es erneut.
          </p>
          {error.digest && (
            <p style={{ fontFamily: 'monospace', fontSize: 12, color: '#71717a' }}>
              {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              padding: '8px 16px',
              borderRadius: 6,
              border: 0,
              background: '#18181b',
              color: '#ffffff',
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

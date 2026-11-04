import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

// Shop name, favicon and brand colours are loaded from the `general`/`branding` settings
// once the storefront is built (Phase 2); this is the neutral application shell.
export const metadata: Metadata = {
  title: { default: 'Tickets', template: '%s · Tickets' },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de" suppressHydrationWarning>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}

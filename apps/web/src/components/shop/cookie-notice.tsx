'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { COOKIE_NOTICE_COOKIE, COOKIE_NOTICE_MAX_AGE_SECONDS } from '@/lib/cookie-inventory';

/**
 * Information bar about the strictly necessary cookies (no consent). It sits in the page flow
 * above the footer, so it never covers the seating chart or checkout buttons. Dismissal is stored
 * in a (likewise necessary) one-year cookie that the server reads to not render the bar again.
 */
export function CookieNotice({
  text,
  moreLabel,
  dismissLabel,
}: {
  text: string;
  moreLabel: string;
  dismissLabel: string;
}) {
  const [visible, setVisible] = useState(true);
  if (!visible) return null;

  const dismiss = () => {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${COOKIE_NOTICE_COOKIE}=1; Max-Age=${COOKIE_NOTICE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
    setVisible(false);
  };

  return (
    <aside
      role="region"
      aria-label={moreLabel}
      data-testid="cookie-notice"
      className="border-t bg-muted/60 text-sm"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:gap-x-6">
        <p className="min-w-0 flex-1 basis-64 text-xs leading-relaxed [overflow-wrap:anywhere] sm:text-sm">
          {text}{' '}
          <Link href="/cookies" className="underline underline-offset-2">
            {moreLabel}
          </Link>
        </p>
        <Button type="button" size="sm" onClick={dismiss} className="max-sm:w-full">
          {dismissLabel}
        </Button>
      </div>
    </aside>
  );
}

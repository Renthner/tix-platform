'use client';

import { useEffect } from 'react';

/**
 * Remembers the super admin's explicit "test orders" filter choice (preference cookie, read by the
 * order list and its CSV export). Renders nothing.
 */
export function RememberTestsFilter({ name, value }: { name: string; value: string | null }) {
  useEffect(() => {
    if (!value) return;
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax`;
  }, [name, value]);
  return null;
}

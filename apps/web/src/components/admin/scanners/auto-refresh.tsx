'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Re-renders the surrounding server component periodically (live check-in statistics). */
export function AutoRefresh({ seconds = 10 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, seconds * 1000);
    return () => clearInterval(timer);
  }, [router, seconds]);
  return null;
}

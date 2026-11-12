'use client';

import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';

export default function LocaleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('common.errorPages.error');
  useEffect(() => {
    // Only the digest (it matches the server log); the message may contain internal details.
    console.error('Page error', error.digest ?? 'no-digest');
  }, [error.digest]);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="text-muted-foreground">{t('text')}</p>
      {error.digest && (
        <p className="font-mono text-xs text-muted-foreground">
          {t('reference', { digest: error.digest })}
        </p>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={() => reset()}>{t('retry')}</Button>
        <Button asChild variant="outline">
          <Link href="/">{t('home')}</Link>
        </Button>
      </div>
    </main>
  );
}

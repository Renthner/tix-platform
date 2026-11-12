'use client';

import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';

/** Keeps the admin layout (navigation) around the failed page. */
export default function AdminPanelError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('common.errorPages.error');
  useEffect(() => {
    console.error('Admin page error', error.digest ?? 'no-digest');
  }, [error.digest]);
  return (
    <div
      className="mx-auto flex max-w-md flex-col items-center gap-4 p-10 text-center"
      role="alert"
    >
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('text')}</p>
      {error.digest && (
        <p className="font-mono text-xs text-muted-foreground">
          {t('reference', { digest: error.digest })}
        </p>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={() => reset()}>{t('retry')}</Button>
        <Button asChild variant="outline">
          <Link href="/admin">{t('adminHome')}</Link>
        </Button>
      </div>
    </div>
  );
}

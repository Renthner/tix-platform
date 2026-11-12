import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';

/** Keeps the admin layout (navigation) around a missing admin page. */
export default async function AdminPanelNotFound() {
  const t = await getTranslations('common.errorPages.notFound');
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 p-10 text-center">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('text')}</p>
      <Button asChild>
        <Link href="/admin">{t('adminHome')}</Link>
      </Button>
    </div>
  );
}

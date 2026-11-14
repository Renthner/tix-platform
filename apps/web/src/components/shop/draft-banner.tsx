import { FlaskConical } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Alert, AlertDescription } from '@/components/ui/alert';

/**
 * Shown to super-admins on the page, cart and checkout of a DRAFT event: nobody else can see
 * the event, and everything bought there is a test order.
 */
export async function DraftBanner() {
  const t = await getTranslations('shop.layout');
  return (
    <Alert
      role="status"
      data-testid="draft-banner"
      className="border-warning-border bg-warning-soft text-warning"
    >
      <FlaskConical className="size-4" />
      <AlertDescription className="text-warning">{t('draftBanner')}</AlertDescription>
    </Alert>
  );
}

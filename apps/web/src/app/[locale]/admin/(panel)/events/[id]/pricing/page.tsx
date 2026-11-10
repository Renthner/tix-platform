import { getTranslations } from 'next-intl/server';
import { EventTranslationPane } from '@/components/admin/event-translation-pane';
import { getEditLocale } from '@/server/admin/edit-locale';
import { notFound } from 'next/navigation';
import { PricingManager } from '@/components/admin/pricing-manager';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import {
  deleteCategoryAction,
  deleteTicketTypeAction,
  saveCategoryAction,
  saveMatrixAction,
  saveTicketTypeAction,
} from '@/server/admin/pricing';
import { getEventWithVenue, getPricing } from '@/server/admin/queries';

export async function generateMetadata() {
  const t = await getTranslations('admin.events.tabs');
  return { title: t('pricing') };
}

export default async function EventPricingPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER']);
  const { id } = await params;
  const row = await getEventWithVenue(id);
  if (!row) notFound();
  const { event } = row;
  const editLocale = await getEditLocale();
  if (editLocale) {
    return <EventTranslationPane eventId={event.id} scope="pricing" editLocale={editLocale} />;
  }
  const { categories, types, matrix } = await getPricing(event.id);

  return (
    <PricingManager
      currency={event.currency}
      createCategory={saveCategoryAction.bind(null, event.id, null)}
      createTicketType={saveTicketTypeAction.bind(null, event.id, null)}
      saveMatrix={saveMatrixAction.bind(null, event.id)}
      categories={categories.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        color: c.color,
        basePrice: c.basePrice,
        maxTicketsPerOrder: c.maxTicketsPerOrder,
        sortOrder: c.sortOrder,
        isActive: c.isActive,
        save: saveCategoryAction.bind(null, event.id, c.id),
        remove: deleteCategoryAction.bind(null, event.id, c.id),
      }))}
      ticketTypes={types.map((tt) => ({
        id: tt.id,
        name: tt.name,
        description: tt.description,
        discountKind: tt.discountKind,
        discountValue: tt.discountValue,
        requiresProofAtEntry: tt.requiresProofAtEntry,
        scannerWarning: tt.scannerWarning,
        requiredSeatFeature: tt.requiredSeatFeature,
        maxPerOrder: tt.maxPerOrder,
        channels: tt.channels,
        isDefault: tt.isDefault,
        isActive: tt.isActive,
        sortOrder: tt.sortOrder,
        save: saveTicketTypeAction.bind(null, event.id, tt.id),
        remove: deleteTicketTypeAction.bind(null, event.id, tt.id),
      }))}
      matrix={matrix}
    />
  );
}

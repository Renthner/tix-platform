import type { TestOrderSummary } from '@tix/core';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { EventStatusForm } from '@/components/admin/event-forms';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { setEventStatusAction } from '@/server/admin/events';
import { publishChecklist, type EventRow } from '@/server/admin/queries';

/**
 * "Status & publishing" card with the publish checklist (event overview and the status page).
 * `footer` adds content below the form (e.g. a link to the status page).
 */
export async function EventPublishCard({
  event,
  testOrders,
  canDeleteTestOrders,
  footer,
}: {
  event: EventRow;
  testOrders: TestOrderSummary;
  canDeleteTestOrders: boolean;
  footer?: ReactNode;
}) {
  const [t, checklist] = await Promise.all([
    getTranslations('admin.events.publish'),
    publishChecklist(event),
  ]);
  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <EventStatusForm
          action={setEventStatusAction.bind(null, event.id)}
          status={event.status}
          checklist={checklist}
          testOrders={testOrders}
          canDeleteTestOrders={canDeleteTestOrders}
        />
        {footer}
      </CardContent>
    </Card>
  );
}

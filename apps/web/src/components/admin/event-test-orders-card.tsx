'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { ActionState } from '@/lib/action-state';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmAction } from './confirm-action';

/** Test orders of a draft event (super-admin test purchases) with the bulk delete action. */
export function EventTestOrdersCard({
  action,
  orders,
  seats,
  withMoney,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  orders: number;
  seats: number;
  withMoney: number;
}) {
  const t = useTranslations('admin.events.testOrders');
  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle>{t('cardTitle')}</CardTitle>
        <CardDescription>{t('cardDescription', { orders, seats, withMoney })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <ConfirmAction
          action={action}
          title={t('deleteAllTitle')}
          description={t('deleteAllDescription', { orders, seats })}
          confirmLabel={t('deleteAllConfirm')}
        >
          {t('deleteAll')}
        </ConfirmAction>
        <Link href="/admin/orders?tests=only" className="text-sm underline underline-offset-4">
          {t('showOrders')}
        </Link>
      </CardContent>
    </Card>
  );
}

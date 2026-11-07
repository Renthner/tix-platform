'use client';

import type { OrderStatus } from '@tix/shared';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';

const VARIANT: Record<OrderStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  PENDING: 'outline',
  AWAITING_PAYMENT: 'secondary',
  PAID: 'default',
  CANCELLED: 'destructive',
  EXPIRED: 'outline',
  REFUNDED: 'secondary',
  PARTIALLY_REFUNDED: 'secondary',
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const t = useTranslations('orders.status');
  return <Badge variant={VARIANT[status]}>{t(status)}</Badge>;
}

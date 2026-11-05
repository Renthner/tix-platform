'use client';

import type { EventStatus } from '@tix/shared';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';

type SaleState =
  'NOT_PUBLISHED' | 'CANCELLED' | 'NOT_STARTED' | 'PRESALE' | 'ON_SALE' | 'PAUSED' | 'ENDED';

const STATUS_VARIANT: Record<EventStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  DRAFT: 'outline',
  PUBLISHED: 'default',
  POSTPONED: 'secondary',
  CANCELLED: 'destructive',
  ARCHIVED: 'secondary',
};

const SALE_VARIANT: Record<SaleState, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  NOT_PUBLISHED: 'outline',
  CANCELLED: 'destructive',
  NOT_STARTED: 'secondary',
  PRESALE: 'secondary',
  ON_SALE: 'default',
  PAUSED: 'destructive',
  ENDED: 'outline',
};

export function EventStatusBadge({ status }: { status: EventStatus }) {
  const t = useTranslations('admin.eventStatus');
  return <Badge variant={STATUS_VARIANT[status]}>{t(status)}</Badge>;
}

export function SaleStateBadge({ state }: { state: SaleState }) {
  const t = useTranslations('admin.saleState');
  return <Badge variant={SALE_VARIANT[state]}>{t(state)}</Badge>;
}

export function ActiveBadge({ active }: { active: boolean }) {
  const t = useTranslations('admin.common');
  return (
    <Badge variant={active ? 'secondary' : 'outline'}>{active ? t('active') : t('inactive')}</Badge>
  );
}

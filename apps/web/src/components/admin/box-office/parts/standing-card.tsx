'use client';

import type { PublicSeatMap } from '@tix/shared';
import { Minus, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useMoney } from '@/lib/format';
import { allowedTariffs } from './helpers';
import type { Inventory } from './types';

export function StandingCard({
  map,
  standing,
  gaPicks,
  inv,
  setGa,
  title,
}: {
  map: PublicSeatMap;
  standing: PublicSeatMap['sections'];
  gaPicks: Record<string, Record<string, number>>;
  inv: Inventory;
  setGa: (sectionId: string, tariffId: string, quantity: number) => Promise<void>;
  /** Card title (default: "Standing areas"). */
  title?: string;
}) {
  const t = useTranslations('orders.boxOffice');
  const money = useMoney();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title ?? t('standing')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {standing.map((section) => {
          const picks = gaPicks[section.id] ?? {};
          const remaining = inv.ga[section.id] ?? 0;
          const allowed = allowedTariffs(map, section.priceCategoryId!, null);
          return (
            <div key={section.id} className="space-y-1.5">
              <div className="text-sm">
                {section.name}{' '}
                <span className="text-xs text-muted-foreground">
                  {t('remaining', { count: remaining })}
                </span>
              </div>
              {allowed.map((tariff) => {
                const quantity = picks[tariff.id] ?? 0;
                return (
                  <div key={tariff.id} className="flex items-center justify-between gap-2 text-sm">
                    <span>
                      {tariff.name} ·{' '}
                      {money(tariff.prices[section.priceCategoryId!] ?? 0, map.currency)}
                    </span>
                    <span className="flex items-center gap-2">
                      <Button
                        size="icon"
                        variant="outline"
                        aria-label={`${t('decrease')}: ${section.name} · ${tariff.name}`}
                        disabled={quantity <= 0}
                        onClick={() => void setGa(section.id, tariff.id, quantity - 1)}
                      >
                        <Minus />
                      </Button>
                      <span className="w-6 text-center tabular-nums">{quantity}</span>
                      <Button
                        size="icon"
                        variant="outline"
                        aria-label={`${t('increase')}: ${section.name} · ${tariff.name}`}
                        disabled={remaining <= 0}
                        onClick={() => void setGa(section.id, tariff.id, quantity + 1)}
                      >
                        <Plus />
                      </Button>
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

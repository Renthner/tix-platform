'use client';

import type { PublicSeat, PublicSeatMap } from '@tix/shared';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCountdown, useMoney } from '@/lib/format';
import type { useFieldErrors } from '@/lib/field-errors';
import { allowedTariffs } from './helpers';
import type { Payment, Permissions, Pick } from './types';

export interface MapLookups {
  sections: Map<string, PublicSeatMap['sections'][number]>;
  rows: Map<string, PublicSeatMap['rows'][number]>;
  categories: Map<string, PublicSeatMap['categories'][number]>;
  seats: Map<string, PublicSeat>;
  tariffs: Map<string, PublicSeatMap['ticketTypes'][number]>;
}

export function SelectionCard({
  map,
  lookups,
  sortedSeats,
  seatPicks,
  seatText,
  permissions,
  payment,
  lineCount,
  holdExpiresAt,
  clock,
  hasOverride,
  reason,
  setReason,
  fe,
  removeSeat,
  updatePick,
}: {
  map: PublicSeatMap;
  lookups: MapLookups;
  sortedSeats: PublicSeat[];
  seatPicks: Map<string, Pick>;
  seatText: (seat: PublicSeat) => string;
  permissions: Permissions;
  payment: Payment;
  lineCount: number;
  holdExpiresAt: number | null;
  clock: number;
  hasOverride: boolean;
  reason: string;
  setReason: (value: string) => void;
  fe: ReturnType<typeof useFieldErrors>;
  removeSeat: (seatId: string) => void;
  updatePick: (seatId: string, patch: Partial<Pick>) => void;
}) {
  const t = useTranslations('orders.boxOffice');
  const money = useMoney();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          {t('selection')}
          {holdExpiresAt && (
            <span className="text-xs font-normal text-muted-foreground tabular-nums">
              {t('hold.countdown', {
                time: formatCountdown(Math.max(0, holdExpiresAt - clock)),
              })}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {lineCount === 0 && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
        <ul className="space-y-3 text-sm">
          {sortedSeats.map((seat) => {
            const pick = seatPicks.get(seat.i)!;
            const allowed = seat.c ? allowedTariffs(map, seat.c, seat.f) : [];
            const price = seat.c ? (lookups.tariffs.get(pick.tariffId)?.prices[seat.c] ?? 0) : 0;
            return (
              <li key={seat.i} className="space-y-1.5 rounded-md border p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <span
                      className="inline-block size-2.5 rounded-full"
                      style={{
                        background: lookups.categories.get(seat.c ?? '')?.color,
                      }}
                    />
                    {seatText(seat)}
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t('remove')}
                    onClick={() => removeSeat(seat.i)}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Select
                    value={pick.tariffId}
                    onValueChange={(v) => updatePick(seat.i, { tariffId: v })}
                  >
                    <SelectTrigger className="flex-1" aria-label={t('tariff')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {allowed.map((tariff) => (
                        <SelectItem key={tariff.id} value={tariff.id}>
                          {tariff.name} · {money(tariff.prices[seat.c!] ?? 0, map.currency)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {permissions.priceOverride && payment !== 'COMPLIMENTARY' && (
                    <Input
                      className="w-24"
                      inputMode="decimal"
                      value={pick.override}
                      placeholder={(price / 100).toFixed(2)}
                      aria-label={t('priceOverride')}
                      title={t('priceOverrideHint')}
                      onChange={(e) => updatePick(seat.i, { override: e.target.value })}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {hasOverride && (
          <div className="space-y-1.5">
            <Label htmlFor="bo-reason">{t('overrideReason')}</Label>
            <Input
              id="bo-reason"
              aria-invalid={fe.invalid('bo-reason')}
              value={reason}
              maxLength={500}
              onChange={(e) => {
                setReason(e.target.value);
                fe.clear('bo-reason');
              }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

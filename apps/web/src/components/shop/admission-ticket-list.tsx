'use client';

import type { PublicSeatMap, PublicSection } from '@tix/shared';
import { Minus, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Below this many remaining spots a contingent shows "only X left". */
const FEW_LEFT = 10;

/**
 * Ticket list of an admission-only event (no seating plan): one row per contingent with its price
 * (range over the offered tariffs), the remaining availability and a quantity stepper. Spots are
 * held through the same general-admission path as standing areas on a plan; tariffs are chosen
 * per ticket in the cart.
 */
export function AdmissionTicketList({
  map,
  remaining,
  mine,
  busy,
  maxPerRow,
  priceLabel,
  onChange,
}: {
  map: PublicSeatMap;
  /** Free spots per contingent (holds of other carts subtracted). */
  remaining: Record<string, number>;
  /** Spots of this cart per contingent. */
  mine: Record<string, number>;
  busy: boolean;
  /** Upper bound of one contingent's quantity (order limit / request limit). */
  maxPerRow: number;
  /** Price (range) of a price category, empty when it has no online tariff. */
  priceLabel: (categoryId: string) => string;
  onChange: (sectionId: string, quantity: number) => void;
}) {
  const t = useTranslations('shop.selection.admission');
  const categories = new Map(map.categories.map((c) => [c.id, c]));
  const rows = map.sections.filter(
    (s): s is PublicSection & { priceCategoryId: string } =>
      s.type === 'STANDING' &&
      !!s.priceCategoryId &&
      categories.has(s.priceCategoryId) &&
      priceLabel(s.priceCategoryId) !== '',
  );

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border bg-card p-5 text-sm text-muted-foreground">{t('none')}</p>
    );
  }

  return (
    <section aria-labelledby="admission-tickets-title" className="rounded-lg border bg-card">
      <h2 id="admission-tickets-title" className="border-b px-4 py-3 text-base font-semibold">
        {t('title')}
      </h2>
      <ul className="divide-y" data-testid="admission-ticket-list">
        {rows.map((section) => {
          const category = categories.get(section.priceCategoryId)!;
          const left = remaining[section.id] ?? 0;
          const held = mine[section.id] ?? 0;
          const max = Math.min(maxPerRow, left + held);
          const soldOut = left <= 0 && held === 0;
          const quantityId = `admission-qty-${section.id}`;
          return (
            <li
              key={section.id}
              data-testid="admission-row"
              data-section={section.id}
              className={cn(
                'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3',
                soldOut && 'text-muted-foreground',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="inline-block size-2.5 shrink-0 rounded-full"
                    style={{ background: category.color }}
                    aria-hidden
                  />
                  <span className="font-medium">{section.name}</span>
                  {soldOut ? (
                    <Badge variant="secondary">{t('soldOut')}</Badge>
                  ) : left > 0 && left <= FEW_LEFT ? (
                    <Badge variant="outline" className="border-warning-border text-warning">
                      {t('fewLeft', { count: left })}
                    </Badge>
                  ) : null}
                </div>
                <div className="text-sm text-muted-foreground tabular-nums">
                  {priceLabel(category.id)}
                  {category.name !== section.name && ` · ${category.name}`}
                </div>
              </div>
              <div
                className="flex items-center gap-2"
                role="group"
                aria-label={t('quantityFor', { name: section.name })}
              >
                <Button
                  size="icon"
                  variant="outline"
                  aria-label={t('decrease', { name: section.name })}
                  aria-controls={quantityId}
                  disabled={busy || held <= 0}
                  onClick={() => onChange(section.id, held - 1)}
                >
                  <Minus />
                </Button>
                {/* No aria-label: it would replace the live content; screen readers get the
                    visually hidden sentence, sighted users the number. */}
                <output
                  id={quantityId}
                  aria-live="polite"
                  className="w-8 text-center font-medium tabular-nums"
                >
                  <span aria-hidden="true" data-testid="admission-quantity">
                    {held}
                  </span>
                  <span className="sr-only">
                    {t('quantity', { name: section.name, count: held })}
                  </span>
                </output>
                <Button
                  size="icon"
                  variant="outline"
                  aria-label={t('increase', { name: section.name })}
                  aria-controls={quantityId}
                  disabled={busy || held >= max}
                  onClick={() => onChange(section.id, held + 1)}
                >
                  <Plus />
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

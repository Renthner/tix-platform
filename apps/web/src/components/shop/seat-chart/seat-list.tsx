'use client';

import { SEAT_FLAG, type PublicSeat, type PublicSeatMap } from '@tix/shared';
import { useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import type { SeatAvailability, SeatStatus } from './seat-chart';

interface ListSeat {
  seat: PublicSeat;
  selected: boolean;
}

/**
 * Accessible alternative to the plan: sections → rows → the seats that can be selected, as plain
 * buttons. Shares the selection state (and the server calls) with the plan; works for keyboard,
 * screen readers and small screens.
 */
export function SeatList({
  map,
  status,
  statusVersion,
  seatLabel,
  onToggle,
  onSectionClick,
  gaRemaining,
  standingEnabled,
}: {
  map: PublicSeatMap;
  status: (seatId: string) => SeatStatus;
  /** Changes whenever a seat status changes (the list re-renders with it). */
  statusVersion: number;
  seatLabel: (seat: PublicSeat, availability: SeatAvailability) => string;
  onToggle: (seat: PublicSeat) => void;
  onSectionClick: (sectionId: string) => void;
  gaRemaining: Record<string, number>;
  standingEnabled: boolean;
}) {
  const t = useTranslations('shop.selection');
  const tList = useTranslations('shop.selection.list');
  const categoryId = useId();
  const specialId = useId();
  const [category, setCategory] = useState('');
  const [onlySpecial, setOnlySpecial] = useState(false);

  const groups = useMemo(() => {
    const rowById = new Map(map.rows.map((r) => [r.id, r]));
    const result: {
      id: string;
      name: string;
      count: number;
      rows: { id: string; label: string | null; seats: ListSeat[] }[];
    }[] = [];
    for (const section of map.sections) {
      const byRow = new Map<string, ListSeat[]>();
      let count = 0;
      for (const seat of map.seats) {
        if (seat.s !== section.id || !seat.c) continue;
        if (category && seat.c !== category) continue;
        if (onlySpecial && (seat.f & (SEAT_FLAG.WHEELCHAIR | SEAT_FLAG.COMPANION)) === 0) continue;
        const state = status(seat.i);
        const blocked = (seat.f & SEAT_FLAG.BLOCKED) !== 0;
        const selected = state === 'mine' || state === 'pending';
        if (!selected && (state !== 'free' || blocked)) continue;
        const key = seat.r ?? '';
        const list = byRow.get(key) ?? [];
        list.push({ seat, selected });
        byRow.set(key, list);
        count += 1;
      }
      if (count === 0) continue;
      const rows = [...byRow.entries()]
        .map(([id, seats]) => ({
          id,
          label: id ? (rowById.get(id)?.label ?? null) : null,
          sortOrder: id ? (rowById.get(id)?.sortOrder ?? 0) : 0,
          seats: seats.sort((a, b) => (a.seat.p ?? 0) - (b.seat.p ?? 0)),
        }))
        .sort((a, b) => a.sortOrder - b.sortOrder);
      result.push({ id: section.id, name: section.name, count, rows });
    }
    return result;
    // `status` changes identity with statusVersion
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, category, onlySpecial, status, statusVersion]);

  const standing = standingEnabled
    ? map.sections.filter(
        (s) =>
          s.type === 'STANDING' &&
          s.priceCategoryId &&
          (!category || s.priceCategoryId === category) &&
          !onlySpecial,
      )
    : [];

  return (
    <section aria-label={tList('title')} className="space-y-4 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <label htmlFor={categoryId} className="block text-sm font-medium">
            {tList('filterCategory')}
          </label>
          <select
            id={categoryId}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="block h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">{tList('allCategories')}</option>
            {map.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {map.seats.some((s) => (s.f & (SEAT_FLAG.WHEELCHAIR | SEAT_FLAG.COMPANION)) !== 0) && (
          <div className="flex items-center gap-2 pb-2">
            <input
              id={specialId}
              type="checkbox"
              checked={onlySpecial}
              onChange={(e) => setOnlySpecial(e.target.checked)}
              className="size-4"
            />
            <label htmlFor={specialId} className="text-sm">
              {tList('onlySpecial')}
            </label>
          </div>
        )}
      </div>

      {standing.length > 0 && (
        <ul className="space-y-2">
          {standing.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className="rounded-md border px-3 py-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onSectionClick(s.id)}
              >
                {tList('standing', {
                  name: s.name,
                  remaining: t('standing.remaining', { count: gaRemaining[s.id] ?? 0 }),
                })}
              </button>
            </li>
          ))}
        </ul>
      )}

      {groups.length === 0 && standing.length === 0 && (
        <p className="text-sm text-muted-foreground">{tList('noSeats')}</p>
      )}

      <div className="space-y-2">
        {groups.map((group) => (
          <details
            key={group.id}
            open={groups.length === 1}
            className="rounded-md border p-3"
            data-testid="seat-list-section"
          >
            <summary className="cursor-pointer text-sm font-semibold">
              {group.name} · {tList('seatsAvailable', { count: group.count })}
            </summary>
            <div className="mt-3 space-y-3">
              {group.rows.map((row) => (
                <div
                  key={row.id}
                  role="group"
                  aria-label={row.label ? tList('rowGroup', { label: row.label }) : group.name}
                  className="flex flex-wrap items-center gap-2"
                >
                  {row.label && (
                    <span
                      className="w-16 shrink-0 text-sm text-muted-foreground"
                      aria-hidden="true"
                    >
                      {t('row', { label: row.label })}
                    </span>
                  )}
                  {row.seats.map(({ seat, selected }) => (
                    <button
                      key={seat.i}
                      type="button"
                      data-seat-list={seat.i}
                      aria-pressed={selected}
                      aria-label={seatLabel(seat, selected ? 'selected' : 'available')}
                      onClick={() => onToggle(seat)}
                      className="min-h-9 min-w-9 rounded-md border px-2 text-sm tabular-nums focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-primary aria-pressed:text-primary-foreground"
                    >
                      {seat.l}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

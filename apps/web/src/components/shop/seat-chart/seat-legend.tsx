'use client';

import { SEAT_FLAG, seatPlanLabel, type PublicSeat, type PublicSeatMap } from '@tix/shared';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { SeatMark, type SeatColors, type SeatStatus } from './seat-chart';

export type SeatSwatchKind =
  | 'free'
  | 'inOtherCart'
  | 'sold'
  | 'blocked'
  | 'selected'
  | 'wheelchair'
  | 'companion'
  | 'changeCurrent'
  | 'changeReplaced'
  | 'changeNew';

const FALLBACK_CATEGORY = '__legend__';

/**
 * Legend swatch that renders a seat with the very same drawing code as the chart (`SeatMark`):
 * symbol / shape, colours, selection ring / fill, cross on sold / blocked, wheelchair markers.
 * The SVG symbols are defined by the chart's own `<defs>` (same document), so the chart must be
 * on the page.
 */
export function SeatSwatch({
  map,
  colors,
  kind,
  categoryId,
  size = 20,
  sellBlocked,
}: {
  map: PublicSeatMap;
  colors: SeatColors;
  kind: SeatSwatchKind;
  /** Same meaning as on the chart (box office). */
  sellBlocked?: boolean;
  /** Category whose colour a `free` / `selected` / special seat takes (default: the first). */
  categoryId?: string;
  size?: number;
}) {
  const radius = map.settings.seatRadius ?? 8;
  const cat = categoryId ?? map.categories[0]?.id ?? FALLBACK_CATEGORY;
  const seat: PublicSeat = {
    i: 'legend',
    s: '',
    r: null,
    t: null,
    l: '1',
    p: null,
    x: 0,
    y: 0,
    o: 0,
    c: cat,
    k: null,
    f:
      kind === 'blocked'
        ? SEAT_FLAG.BLOCKED
        : kind === 'wheelchair'
          ? SEAT_FLAG.WHEELCHAIR
          : kind === 'companion'
            ? SEAT_FLAG.COMPANION
            : 0,
    m: null,
  };
  const status = (): SeatStatus =>
    kind === 'inOtherCart'
      ? 'locked'
      : kind === 'sold'
        ? 'taken'
        : kind === 'selected'
          ? 'mine'
          : kind === 'changeCurrent' || kind === 'changeReplaced' || kind === 'changeNew'
            ? kind
            : 'free';
  const specialLabels = useMemo(
    () => ({
      wheelchairLabel: map.settings.wheelchairLabel,
      companionLabel: map.settings.companionLabel,
    }),
    [map.settings.wheelchairLabel, map.settings.companionLabel],
  );
  const symbolIds = useMemo(() => new Set(map.symbols.map((s) => s.id)), [map.symbols]);
  const categoryColors = useMemo(
    () => new Map(map.categories.map((c) => [c.id, c.color])),
    [map.categories],
  );
  const defaultSymbolId =
    map.settings.defaultSeatSymbolId && symbolIds.has(map.settings.defaultSeatSymbolId)
      ? map.settings.defaultSeatSymbolId
      : null;
  const extent = radius * 1.5;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`${-extent} ${-extent} ${extent * 2} ${extent * 2}`}
      aria-hidden
      className="shrink-0"
    >
      <SeatMark
        seat={seat}
        radius={radius}
        showNumbers={false}
        showMarkers
        specialLabels={specialLabels}
        defaultSymbolId={defaultSymbolId}
        symbolIds={symbolIds}
        colorOf={(id) => (id ? (categoryColors.get(id) ?? '#a1a1aa') : '#a1a1aa')}
        colors={colors}
        status={status}
        sellBlocked={sellBlocked}
      />
    </svg>
  );
}

/** Swatch of a standing area – drawn like the chart's section fill (category colour, 35 %). */
export function StandingSwatch({ color, size = 20 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden className="shrink-0">
      <rect
        x="1.5"
        y="3.5"
        width="17"
        height="13"
        rx="2"
        fill={color}
        fillOpacity={0.35}
        stroke={color}
        strokeOpacity={0.6}
        strokeWidth={1.5}
      />
    </svg>
  );
}

/**
 * State legend of a seating chart: only the states that can occur are listed, each drawn like
 * in the chart (follows the admin `seatDisplay` settings through `colors`).
 */
export function SeatStateLegend({
  map,
  colors,
  sellBlocked = false,
  className,
}: {
  map: PublicSeatMap;
  colors: SeatColors;
  /** Box office: blocked seats are drawn but selectable. */
  sellBlocked?: boolean;
  className?: string;
}) {
  const t = useTranslations('shop.selection.legend');
  const hasSeats = map.seats.length > 0;
  const hasBlocked = map.seats.some((s) => (s.f & SEAT_FLAG.BLOCKED) !== 0 || !s.c);
  const marked = (flag: number, isWheelchair: boolean) =>
    map.seats.some((s) => (s.f & flag) !== 0) &&
    seatPlanLabel(
      { label: '1', isWheelchairSpace: isWheelchair, isCompanionSeat: !isWheelchair },
      map.settings,
    )?.kind === 'MARKER';
  const sameAsSold = !sellBlocked && colors.blockedColor === colors.soldColor;
  if (!hasSeats) return null;
  const entries: { key: string; kind: SeatSwatchKind; label: string }[] = [
    { key: 'inOtherCart', kind: 'inOtherCart', label: t('inOtherCart') },
    { key: 'sold', kind: 'sold', label: t('unavailable') },
    ...(hasBlocked && !sameAsSold
      ? [{ key: 'blocked', kind: 'blocked' as const, label: t('blocked') }]
      : []),
    { key: 'selected', kind: 'selected', label: t('selected') },
    ...(marked(SEAT_FLAG.WHEELCHAIR, true)
      ? [{ key: 'wheelchair', kind: 'wheelchair' as const, label: t('wheelchair') }]
      : []),
    ...(marked(SEAT_FLAG.COMPANION, false)
      ? [{ key: 'companion', kind: 'companion' as const, label: t('companion') }]
      : []),
  ];
  return (
    <>
      {entries.map((e) => (
        <span
          key={e.key}
          className={className ?? 'flex items-center gap-1.5 text-muted-foreground'}
        >
          <SeatSwatch map={map} colors={colors} kind={e.kind} sellBlocked={sellBlocked} />
          {e.label}
        </span>
      ))}
    </>
  );
}

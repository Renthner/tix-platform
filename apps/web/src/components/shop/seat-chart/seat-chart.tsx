'use client';

import {
  SEAT_FLAG,
  contrastText,
  seatPlanLabel,
  type PublicSeat,
  type PublicSeatMap,
  type SeatMapSettingsInput,
  type SeatSelectionStyle,
} from '@tix/shared';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { memo, useCallback, useMemo, useRef, type PointerEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  ElementLayer,
  EntranceLayer,
  RowLabelLayer,
  SectionLayer,
  SymbolDefs,
  contentBounds,
  symbolRef,
} from './shapes';
import { usePanZoom } from './use-pan-zoom';

export type SeatStatus =
  | 'free'
  | 'mine'
  | 'locked'
  | 'taken'
  | 'pending'
  /** Seat change editor (admin): order seat kept / being replaced / chosen alternative. */
  | 'changeCurrent'
  | 'changeReplaced'
  | 'changeNew';

/** Colours of non-free seat states (admin setting `seatDisplay`). */
export interface SeatColors {
  inOtherCartColor: string;
  soldColor: string;
  blockedColor: string;
  markUnavailableWithCross: boolean;
  selectionColor: string;
  /** RING = ring around the seat, FILL = seat filled with the selection colour, BOTH. */
  selectionStyle: SeatSelectionStyle;
  /** Seat change editor only (admin); the shop does not pass or use these. */
  seatChangeCurrentColor?: string;
  seatChangeReplacedColor?: string;
  seatChangeNewColor?: string;
}

export interface SeatChartProps {
  map: PublicSeatMap;
  colors: SeatColors;
  status: (seatId: string) => SeatStatus;
  /** Bumped whenever any seat status changes (memo key for the seat layer). */
  statusVersion: number;
  gaRemaining: Record<string, number>;
  gaMine: Record<string, number>;
  highlighted: ReadonlySet<string>;
  interactive: boolean;
  onSeatClick: (seat: PublicSeat) => void;
  onSectionClick: (sectionId: string) => void;
  seatTitle: (seat: PublicSeat) => string;
  /** Box office: blocked seats (with a category) can be selected; they keep their cross mark. */
  sellBlocked?: boolean;
}

const ORPHAN_COLOR = '#dc2626';

/**
 * Seat numbers appear only when zoomed in very closely: a seat must be at least this many
 * pixels in radius on screen (≈ 24 px seat) – independent of the plan's size.
 */
const SEAT_NUMBER_MIN_RADIUS_PX = 12;
/** Type markers of wheelchair / companion seats (♿, +, short text) appear earlier. */
const SEAT_MARKER_MIN_RADIUS_PX = 7;

/**
 * One seat exactly as drawn in the chart. Also used for the legend swatches so that legend and
 * plan can never drift apart.
 */
export function SeatMark({
  seat,
  radius,
  showNumbers,
  showMarkers,
  specialLabels,
  defaultSymbolId,
  symbolIds,
  colorOf,
  colors,
  status,
  isHighlighted = false,
  title,
  sellBlocked,
}: {
  seat: PublicSeat;
  radius: number;
  showNumbers: boolean;
  showMarkers: boolean;
  specialLabels: Pick<SeatMapSettingsInput, 'wheelchairLabel' | 'companionLabel'>;
  defaultSymbolId: string | null;
  symbolIds: ReadonlySet<string>;
  colorOf: (categoryId: string | null) => string;
  colors: SeatColors;
  status: (seatId: string) => SeatStatus;
  isHighlighted?: boolean;
  title?: string;
  sellBlocked?: boolean;
}) {
  const cross = (x: number, y: number) =>
    `M${x - radius * 0.5},${y - radius * 0.5}L${x + radius * 0.5},${y + radius * 0.5}M${x + radius * 0.5},${y - radius * 0.5}L${x - radius * 0.5},${y + radius * 0.5}`;
  const blockedFlag = (seat.f & SEAT_FLAG.BLOCKED) !== 0;
  const blocked = (blockedFlag && !(sellBlocked && seat.c)) || !seat.c;
  const s = blocked ? 'taken' : status(seat.i);
  const free = s === 'free';
  const mine = s === 'mine' || s === 'pending';
  const changeColor =
    s === 'changeCurrent'
      ? (colors.seatChangeCurrentColor ?? '#2563EB')
      : s === 'changeReplaced'
        ? (colors.seatChangeReplacedColor ?? '#DC2626')
        : s === 'changeNew'
          ? (colors.seatChangeNewColor ?? '#16A34A')
          : undefined;
  const fillSelected = mine && colors.selectionStyle !== 'RING';
  const ringSelected = (mine && colors.selectionStyle !== 'FILL') || !!changeColor;
  const ringColor = changeColor ?? colors.selectionColor;
  const fill = changeColor
    ? changeColor
    : blocked
      ? colors.blockedColor
      : s === 'taken'
        ? colors.soldColor
        : s === 'locked'
          ? colors.inOtherCartColor
          : fillSelected
            ? colors.selectionColor
            : colorOf(seat.c);
  const showCross =
    !changeColor && colors.markUnavailableWithCross && (blocked || blockedFlag || s === 'taken');
  // Seat number, or the configured marker of wheelchair / companion seats.
  const planLabel = showCross
    ? null
    : seatPlanLabel(
        {
          label: seat.l,
          isWheelchairSpace: (seat.f & SEAT_FLAG.WHEELCHAIR) !== 0,
          isCompanionSeat: (seat.f & SEAT_FLAG.COMPANION) !== 0,
        },
        specialLabels,
      );
  const planText =
    planLabel && (planLabel.kind === 'MARKER' ? showMarkers : showNumbers) ? planLabel.text : null;
  const symbolId = seat.m && symbolIds.has(seat.m) ? seat.m : defaultSymbolId;
  const clickable = free || mine || !!changeColor;
  return (
    <g
      key={seat.i}
      data-seat={clickable ? seat.i : undefined}
      className={clickable ? 'cursor-pointer' : undefined}
    >
      {title && <title>{title}</title>}
      {symbolId ? (
        <>
          <use
            href={symbolRef(symbolId)}
            x={seat.x - radius}
            y={seat.y - radius}
            width={radius * 2}
            height={radius * 2}
            color={fill}
            opacity={s === 'pending' ? 0.6 : 1}
            transform={seat.o ? `rotate(${seat.o} ${seat.x} ${seat.y})` : undefined}
          />
          {/* invisible hit area so the whole seat box is clickable */}
          <circle cx={seat.x} cy={seat.y} r={radius} fill="transparent" />
          {(ringSelected || isHighlighted) && (
            <circle
              cx={seat.x}
              cy={seat.y}
              r={radius * 1.15}
              fill="none"
              stroke={isHighlighted ? ORPHAN_COLOR : ringColor}
              strokeWidth={radius * 0.25}
            />
          )}
        </>
      ) : (
        <>
          <circle
            cx={seat.x}
            cy={seat.y}
            r={radius}
            fill={fill}
            fillOpacity={s === 'pending' ? 0.6 : 1}
            stroke={isHighlighted ? ORPHAN_COLOR : ringSelected ? ringColor : 'none'}
            strokeWidth={isHighlighted ? radius * 0.45 : ringSelected ? radius * 0.35 : 0}
          />
          {mine && !planText && <circle cx={seat.x} cy={seat.y} r={radius * 0.35} fill="#ffffff" />}
        </>
      )}
      {showCross && <path d={cross(seat.x, seat.y)} stroke="#71717a" strokeWidth={radius * 0.2} />}
      {planText && (
        <text
          x={seat.x}
          y={seat.y}
          textAnchor="middle"
          dominantBaseline="central"
          // On seat symbols: dark digits with a white halo (readable on any symbol);
          // on plain circles: black or white, whichever contrasts with the fill.
          fontSize={radius * (symbolId ? 0.85 : 0.9) * (planText.length > 2 ? 0.72 : 1)}
          fontWeight={symbolId ? 700 : 600}
          fill={symbolId ? '#111827' : contrastText(fill)}
          stroke={symbolId ? '#ffffff' : 'none'}
          strokeWidth={symbolId ? radius * 0.22 : 0}
          strokeLinejoin="round"
          paintOrder="stroke"
          className="pointer-events-none select-none"
        >
          {planText}
        </text>
      )}
    </g>
  );
}

const SeatLayer = memo(function SeatLayer({
  seats,
  radius,
  showNumbers,
  showMarkers,
  specialLabels,
  defaultSymbolId,
  symbolIds,
  colorOf,
  colors,
  status,
  highlighted,
  seatTitle,
  sellBlocked,
}: {
  seats: PublicSeat[];
  radius: number;
  showNumbers: boolean;
  showMarkers: boolean;
  specialLabels: Pick<SeatMapSettingsInput, 'wheelchairLabel' | 'companionLabel'>;
  defaultSymbolId: string | null;
  symbolIds: ReadonlySet<string>;
  colorOf: (categoryId: string | null) => string;
  colors: SeatColors;
  status: (seatId: string) => SeatStatus;
  statusVersion: number;
  highlighted: ReadonlySet<string>;
  seatTitle: (seat: PublicSeat) => string;
  sellBlocked?: boolean;
}) {
  return (
    <g>
      {seats.map((seat) => (
        <SeatMark
          key={seat.i}
          seat={seat}
          radius={radius}
          showNumbers={showNumbers}
          showMarkers={showMarkers}
          specialLabels={specialLabels}
          defaultSymbolId={defaultSymbolId}
          symbolIds={symbolIds}
          colorOf={colorOf}
          colors={colors}
          status={status}
          isHighlighted={highlighted.has(seat.i)}
          title={seatTitle(seat)}
          sellBlocked={sellBlocked}
        />
      ))}
    </g>
  );
});

/** Interactive SVG seating chart with smooth wheel / drag / pinch navigation. */
export function SeatChart(props: SeatChartProps) {
  const t = useTranslations('shop.chart');
  const { map } = props;
  const radius = map.settings.seatRadius ?? 8;
  const svgRef = useRef<SVGSVGElement | null>(null);

  const bounds = useMemo(() => contentBounds(map, 0.04), [map]);
  const specialLabels = useMemo(
    () => ({
      wheelchairLabel: map.settings.wheelchairLabel,
      companionLabel: map.settings.companionLabel,
    }),
    [map.settings.wheelchairLabel, map.settings.companionLabel],
  );
  const pan = usePanZoom(svgRef, { bounds });

  const categoryColors = useMemo(
    () => new Map(map.categories.map((c) => [c.id, c.color])),
    [map.categories],
  );
  const colorOf = useCallback(
    (id: string | null) => (id ? (categoryColors.get(id) ?? '#a1a1aa') : '#a1a1aa'),
    [categoryColors],
  );
  const symbolIds = useMemo(() => new Set(map.symbols.map((s) => s.id)), [map.symbols]);
  const defaultSymbolId =
    map.settings.defaultSeatSymbolId && symbolIds.has(map.settings.defaultSeatSymbolId)
      ? map.settings.defaultSeatSymbolId
      : null;
  const seatsByRow = useMemo(() => {
    const byRow = new Map<string, PublicSeat[]>();
    for (const seat of map.seats) {
      if (!seat.r) continue;
      const list = byRow.get(seat.r) ?? [];
      list.push(seat);
      byRow.set(seat.r, list);
    }
    for (const list of byRow.values()) list.sort((a, b) => (a.p ?? 0) - (b.p ?? 0));
    return byRow;
  }, [map.seats]);
  const seatById = useMemo(() => new Map(map.seats.map((s) => [s.i, s])), [map.seats]);
  const elementsBelow = useMemo(
    () => map.elements.filter((e) => e.type !== 'TEXT'),
    [map.elements],
  );
  const textElements = useMemo(() => map.elements.filter((e) => e.type === 'TEXT'), [map.elements]);

  const onPointerUp = (e: PointerEvent) => {
    pan.handlers.onPointerUp(e);
    // Ignore the click that ends a pan / pinch gesture.
    if (!props.interactive || pan.wasDrag()) return;
    // Use the element pressed at pointerdown – robust against pointer capture.
    const pressed = pan.pressedTarget() ?? (e.target as Element);
    const target = pressed.closest?.('[data-seat],[data-section]') ?? null;
    const seatId = target?.getAttribute('data-seat');
    if (seatId) {
      const seat = seatById.get(seatId);
      if (seat) props.onSeatClick(seat);
      return;
    }
    const sectionId = target?.getAttribute('data-section');
    if (sectionId) props.onSectionClick(sectionId);
  };

  return (
    <div className="relative h-[65vh] min-h-[360px] w-full overflow-hidden rounded-lg border bg-paper">
      <div className="absolute right-3 top-3 z-10 flex flex-col gap-1">
        <Button size="icon" variant="secondary" aria-label={t('zoomIn')} onClick={pan.zoomIn}>
          <Plus />
        </Button>
        <Button size="icon" variant="secondary" aria-label={t('zoomOut')} onClick={pan.zoomOut}>
          <Minus />
        </Button>
        <Button size="icon" variant="secondary" aria-label={t('reset')} onClick={pan.reset}>
          <Maximize2 />
        </Button>
      </div>
      <svg
        ref={svgRef}
        viewBox={pan.viewBox}
        preserveAspectRatio="xMidYMid meet"
        className="h-full w-full cursor-grab touch-none select-none text-paper-foreground active:cursor-grabbing"
        role="img"
        aria-label={t('ariaLabel')}
        onPointerDown={pan.handlers.onPointerDown}
        onPointerMove={pan.handlers.onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={pan.handlers.onPointerCancel}
      >
        <SymbolDefs symbols={map.symbols} />
        <SectionLayer
          sections={map.sections}
          categoryColor={colorOf}
          gaRemaining={props.gaRemaining}
          gaMine={props.gaMine}
          remainingLabel={(count) => t('remaining', { count })}
        />
        <ElementLayer elements={elementsBelow} />
        <EntranceLayer entrances={map.entrances} radius={radius} />
        <RowLabelLayer rows={map.rows} seatsByRow={seatsByRow} radius={radius} />
        <SeatLayer
          seats={map.seats}
          radius={radius}
          showNumbers={
            (map.settings.showSeatNumbers ?? true) &&
            radius * pan.pixelsPerUnit >= SEAT_NUMBER_MIN_RADIUS_PX
          }
          showMarkers={radius * pan.pixelsPerUnit >= SEAT_MARKER_MIN_RADIUS_PX}
          specialLabels={specialLabels}
          defaultSymbolId={defaultSymbolId}
          symbolIds={symbolIds}
          colorOf={colorOf}
          colors={props.colors}
          status={props.status}
          statusVersion={props.statusVersion}
          highlighted={props.highlighted}
          seatTitle={props.seatTitle}
          sellBlocked={props.sellBlocked}
        />
        <ElementLayer elements={textElements} />
      </svg>
    </div>
  );
}

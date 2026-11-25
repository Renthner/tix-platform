'use client';

import {
  SEAT_FLAG,
  contrastText,
  createSeatNavigator,
  seatPlanLabel,
  type PublicSeat,
  type PublicSection,
  type SeatNavKey,
  type PublicSeatMap,
  type SeatMapSettingsInput,
  type SeatSelectionStyle,
} from '@tix/shared';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  type KeyboardEvent,
  type FocusEvent,
  type PointerEvent,
} from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  ElementLayer,
  EntranceLayer,
  RowLabelLayer,
  STANDING_NAV_PREFIX,
  SectionLayer,
  StandingNavLayer,
  SymbolDefs,
  contentBounds,
  standingNavPoint,
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
  /**
   * Accessible name of a seat from its availability. Passing it makes the chart a keyboard widget
   * (roving tabindex over the seats, arrow keys, Enter / Space); without it the chart stays a
   * plain image (admin editors).
   */
  seatLabel?: (seat: PublicSeat, availability: SeatAvailability) => string;
  /** Keyboard instructions (read by screen readers when the chart gets focus). */
  keyboardHelp?: string;
  /** Accessible name of a standing section (keyboard control that opens its quantity panel). */
  standingLabel?: (section: PublicSection) => string;
  /** Enter / Space on a seat that cannot be selected (sold, in another cart, blocked). */
  onUnavailableSeat?: (seat: PublicSeat) => void;
  /** The focused seat changed (null = focus left the chart). */
  onFocusSeat?: (seatId: string | null) => void;
  /** A seat (of any state) was tapped with a finger: the shop shows its details (no hover on touch). */
  onSeatInfo?: (seat: PublicSeat) => void;
  /** Escape pressed inside the chart. */
  onEscape?: () => void;
}

/** 44 px touch targets on phones. */
const ZOOM_BUTTON_CLASS = 'max-sm:size-11';

/** What a screen reader user needs to know about a seat. */
export type SeatAvailability = 'available' | 'selected' | 'unavailable';

const KEY_MAP: Record<string, SeatNavKey> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'home',
  End: 'end',
  // Ctrl+Home / Ctrl+End are mapped to 'first' / 'last' in the key handler.
  PageUp: 'pageUp',
  PageDown: 'pageDown',
};

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
  label,
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
  /** Accessible name builder: makes the seat a focusable, named button (keyboard widget). */
  label?: (seat: PublicSeat, availability: SeatAvailability) => string;
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
  const availability: SeatAvailability = mine ? 'selected' : free ? 'available' : 'unavailable';
  // Seats without a price category are not for sale and not part of the keyboard navigation.
  const a11y = label && seat.c;
  return (
    <g
      key={seat.i}
      data-seat={clickable ? seat.i : undefined}
      data-seat-nav={a11y ? seat.i : undefined}
      className={clickable ? 'cursor-pointer' : undefined}
      {...(a11y
        ? {
            role: 'button',
            tabIndex: -1,
            'aria-label': label(seat, availability),
            'aria-pressed': mine,
            'aria-disabled': !clickable,
          }
        : {})}
    >
      {title && <title>{title}</title>}
      {a11y && (
        // Keyboard focus ring (shown by CSS on :focus-visible): white halo + dark ring, readable on
        // the light sheet and on every seat colour.
        <>
          <circle cx={seat.x} cy={seat.y} r={radius * 1.55} className="tix-seat-focus-halo" />
          <circle cx={seat.x} cy={seat.y} r={radius * 1.55} className="tix-seat-focus-ring" />
        </>
      )}
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
  seatLabel,
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
  seatLabel?: SeatChartProps['seatLabel'];
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
          label={seatLabel}
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
    if (e.pointerType === 'touch' && props.onSeatInfo) {
      const infoId = pressed.closest?.('[data-seat-nav]')?.getAttribute('data-seat-nav');
      const infoSeat = infoId ? seatById.get(infoId) : undefined;
      if (infoSeat) props.onSeatInfo(infoSeat);
    }
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

  // ── Keyboard widget ──────────────────────────────────────────────────────
  // Roving tabindex managed on the DOM (re-rendering thousands of seats per arrow key would be
  // slow): exactly one seat has tabindex 0 – the last focused one, initially the first available.
  const accessible = !!props.seatLabel;
  const helpId = useId();
  // Standing sections take part as one keyboard node each (placed at the section centre).
  const standingNodes = useMemo(
    () =>
      props.standingLabel
        ? map.sections
            .filter((s) => s.type === 'STANDING' && s.priceCategoryId && standingNavPoint(s))
            .map((s) => ({ section: s, point: standingNavPoint(s)! }))
        : [],
    [map.sections, props.standingLabel],
  );
  const navigator = useMemo(
    () =>
      createSeatNavigator(
        [
          ...map.seats.filter((s) => s.c),
          ...standingNodes.map(({ section, point }) => ({
            i: `${STANDING_NAV_PREFIX}${section.id}`,
            s: section.id,
            r: null,
            p: null,
            x: point.x,
            y: point.y,
          })),
        ],
        map.sections.map((s) => s.id),
      ),
    [map.seats, map.sections, standingNodes],
  );
  const tabStop = useRef<string | null>(null);
  const seatEl = useCallback(
    (id: string) =>
      svgRef.current?.querySelector<SVGGElement>(`[data-seat-nav="${id.replace(/"/g, '')}"]`) ??
      null,
    [],
  );
  const setTabStop = useCallback(
    (id: string) => {
      const svg = svgRef.current;
      if (!svg) return;
      for (const el of svg.querySelectorAll('[data-seat-nav][tabindex="0"]')) {
        if (el.getAttribute('data-seat-nav') !== id) el.setAttribute('tabindex', '-1');
      }
      seatEl(id)?.setAttribute('tabindex', '0');
      tabStop.current = id;
    },
    [seatEl],
  );
  /** Plan position of a keyboard node (seat or standing section). */
  const nodePoint = useCallback(
    (id: string): { x: number; y: number } | null => {
      const seat = seatById.get(id);
      if (seat) return seat;
      return (
        standingNodes.find((n) => `${STANDING_NAV_PREFIX}${n.section.id}` === id)?.point ?? null
      );
    },
    [seatById, standingNodes],
  );
  const focusSeat = useCallback(
    (id: string) => {
      const point = nodePoint(id);
      const el = seatEl(id);
      if (!point || !el) return;
      setTabStop(id);
      el.focus({ preventScroll: true });
      pan.ensureVisible(point.x, point.y, radius * 4);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pan.ensureVisible, radius, nodePoint, seatEl, setTabStop],
  );
  // Keep a valid tab stop after the plan or the seat states changed.
  const { statusVersion } = props;
  useEffect(() => {
    if (!accessible) return;
    const svg = svgRef.current;
    if (!svg) return;
    const current = tabStop.current;
    if (current && seatEl(current)) {
      seatEl(current)?.setAttribute('tabindex', '0');
      return;
    }
    const first =
      svg.querySelector('[data-seat-nav][data-seat]') ?? svg.querySelector('[data-seat-nav]');
    const id = first?.getAttribute('data-seat-nav');
    if (id) setTabStop(id);
  }, [accessible, map, statusVersion, seatEl, setTabStop]);

  const { onFocusSeat, onEscape, onUnavailableSeat, onSeatClick, onSectionClick, interactive } =
    props;
  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!accessible || e.altKey || e.metaKey) return;
    // Ctrl only combines with Home / End (first / last seat of the plan); other chords stay native.
    if (e.ctrlKey && e.key !== 'Home' && e.key !== 'End') return;
    const el = (e.target as Element).closest?.('[data-seat-nav]');
    const id = el?.getAttribute('data-seat-nav');
    if (!el || !id) return;
    const navKey = e.ctrlKey ? (e.key === 'Home' ? 'first' : 'last') : KEY_MAP[e.key];
    if (navKey) {
      e.preventDefault();
      const next = navigator.move(id, navKey);
      if (next) focusSeat(next);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (id.startsWith(STANDING_NAV_PREFIX)) {
        if (interactive) onSectionClick(id.slice(STANDING_NAV_PREFIX.length));
        return;
      }
      const seat = seatById.get(id);
      if (!seat || !interactive) return;
      if (el.hasAttribute('data-seat')) onSeatClick(seat);
      else onUnavailableSeat?.(seat);
    } else if (e.key === 'Escape') {
      onEscape?.();
    } else if (e.key === '+' || e.key === '=') {
      pan.zoomIn();
    } else if (e.key === '-') {
      pan.zoomOut();
    }
  };
  const onFocus = (e: FocusEvent<SVGSVGElement>) => {
    if (!accessible) return;
    const el = (e.target as Element).closest?.('[data-seat-nav]');
    const id = el?.getAttribute('data-seat-nav');
    if (!el || !id) return;
    setTabStop(id);
    // Tab entry / Shift+Tab into a seat that is off screen: bring it into view.
    if (el.matches(':focus-visible')) {
      const point = nodePoint(id);
      if (point) pan.ensureVisible(point.x, point.y, radius * 4);
    }
    onFocusSeat?.(id);
  };
  const onBlur = (e: FocusEvent<SVGSVGElement>) => {
    if (!accessible) return;
    if (!svgRef.current?.contains(e.relatedTarget as Node | null)) onFocusSeat?.(null);
  };

  return (
    <div className="relative h-[65vh] min-h-[360px] w-full overflow-hidden rounded-lg border bg-paper">
      {accessible && props.keyboardHelp && (
        <p id={helpId} className="sr-only">
          {props.keyboardHelp}
        </p>
      )}
      <div className="absolute right-3 top-3 z-10 flex flex-col gap-1">
        <Button
          size="icon"
          variant="secondary"
          className={ZOOM_BUTTON_CLASS}
          aria-label={t('zoomIn')}
          onClick={pan.zoomIn}
        >
          <Plus />
        </Button>
        <Button
          size="icon"
          variant="secondary"
          className={ZOOM_BUTTON_CLASS}
          aria-label={t('zoomOut')}
          onClick={pan.zoomOut}
        >
          <Minus />
        </Button>
        <Button
          size="icon"
          variant="secondary"
          className={ZOOM_BUTTON_CLASS}
          aria-label={t('reset')}
          onClick={pan.reset}
        >
          <Maximize2 />
        </Button>
      </div>
      <svg
        ref={svgRef}
        viewBox={pan.viewBox}
        preserveAspectRatio="xMidYMid meet"
        className={cn(
          'h-full w-full cursor-grab select-none text-paper-foreground active:cursor-grabbing',
          // Fitted plan: one finger scrolls the page; zoomed in: one finger pans the plan.
          pan.zoom > 1.02 ? 'touch-none' : 'touch-pan-y',
        )}
        role={accessible ? 'group' : 'img'}
        aria-label={t('ariaLabel')}
        aria-describedby={accessible && props.keyboardHelp ? helpId : undefined}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        onPointerDown={pan.handlers.onPointerDown}
        onPointerMove={pan.handlers.onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={pan.handlers.onPointerCancel}
      >
        <SymbolDefs symbols={map.symbols} />
        {/* Decorative: the seats carry their section / row / category in their own names. */}
        <g aria-hidden="true">
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
        </g>
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
          seatLabel={props.seatLabel}
        />
        {standingNodes.length > 0 && props.standingLabel && (
          <StandingNavLayer
            sections={standingNodes.map((n) => n.section)}
            label={props.standingLabel}
          />
        )}
        <g aria-hidden="true">
          <ElementLayer elements={textElements} />
        </g>
      </svg>
    </div>
  );
}

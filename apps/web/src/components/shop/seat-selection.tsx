'use client';

import {
  MAX_SEATS_PER_REQUEST,
  SEAT_FLAG,
  computeWaitlistCategoryStates,
  publicPriceRanges,
  type BestAvailableArrangement,
  type EventAvailability,
  type PublicSeat,
  type PublicSection,
  type PublicSeatMap,
  type SeatDeltaMessage,
} from '@tix/shared';
import { List, Loader2, Map as MapIcon, Minus, Plus, Sparkles, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useRouter } from '@/i18n/navigation';
import { apiFetch, errorCode, errorMessage } from '@/lib/api';
import { useMoney } from '@/lib/format';
import { publishWaitlistStates, useWaitlistWatched } from '@/lib/waitlist-live';
import { startSocketPresence } from '@/lib/presence';
import { MaintenanceNotice } from '@/components/shop/maintenance-notice';
import {
  emitRealtime,
  isRoomJoined,
  onRealtime,
  onResync,
  onRoomJoinChange,
  subscribeRoom,
} from '@/lib/realtime';
import { useCart } from './cart-context';
import {
  SeatChart,
  type SeatAvailability,
  type SeatColors,
  type SeatStatus,
} from './seat-chart/seat-chart';
import { SeatList } from './seat-chart/seat-list';
import { SeatStateLegend, SeatSwatch, StandingSwatch } from './seat-chart/seat-legend';

/** Upper bound of standing spots per request (matches the API). */
const GA_MAX_PER_REQUEST = 100;

export interface ShopConfig {
  manualSeatSelectionEnabled: boolean;
  bestAvailableEnabled: boolean;
  /** Null = unlimited. */
  maxTicketsPerOrder: number | null;
  orphanSeatRuleEnabled: boolean;
  /** Companion seats only together with their wheelchair space. */
  companionRequiresWheelchair: boolean;
}

interface Inventory {
  taken: Set<string>;
  locked: Set<string>;
  mine: Set<string>;
  pending: Set<string>;
  ga: Record<string, number>;
  /** Sellable standing spots per area (holds not subtracted); feeds the waiting-list block. */
  gaOpen: Record<string, number>;
  gaMine: Record<string, number>;
  version: number;
}

const emptyInventory = (): Inventory => ({
  taken: new Set(),
  locked: new Set(),
  mine: new Set(),
  pending: new Set(),
  ga: {},
  gaOpen: {},
  gaMine: {},
  version: 0,
});

const PING_INTERVAL_MS = 30_000;

export function SeatSelection({
  eventId,
  config,
  colors,
  onPassLost,
}: {
  eventId: string;
  config: ShopConfig;
  /** Seat state colours from the `seatDisplay` setting. */
  colors: SeatColors;
  /** Called when the shop pass expired → the parent re-runs the waiting-room gate. */
  onPassLost: () => void;
}) {
  const locale = useLocale();
  const t = useTranslations('shop.selection');
  const tChart = useTranslations('shop.chart');
  const tErr = useTranslations('common.errors');
  const money = useMoney();
  const router = useRouter();
  const { refresh: refreshCart } = useCart();

  const [map, setMap] = useState<PublicSeatMap | null>(null);
  const [inv, setInv] = useState<Inventory>(emptyInventory);
  const [statusVersion, setStatusVersion] = useState(0);
  const [highlighted, setHighlighted] = useState<ReadonlySet<string>>(new Set());
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'plan' | 'list'>('plan');
  const viewToggleRef = useRef<HTMLButtonElement | null>(null);
  // Screen reader announcements (polite live region); the counter makes repeated texts re-announce.
  const [announcement, setAnnouncement] = useState({ text: '', n: 0 });
  const announce = useCallback(
    (text: string) => setAnnouncement((prev) => ({ text, n: prev.n + 1 })),
    [],
  );
  /** Seat in focus on the plan and whether it is currently unavailable (realtime announcements). */
  const watchedSeat = useRef<{ id: string; unavailable: boolean } | null>(null);
  const invRef = useRef(inv);
  invRef.current = inv;

  const showError = useCallback(
    (err: unknown) => {
      const code = errorCode(err);
      toast.error(errorMessage(tErr, err));
    },
    [tErr],
  );

  const update = useCallback((fn: (draft: Inventory) => void) => {
    setInv((prev) => {
      const next: Inventory = {
        ...prev,
        taken: new Set(prev.taken),
        locked: new Set(prev.locked),
        mine: new Set(prev.mine),
        pending: new Set(prev.pending),
        ga: { ...prev.ga },
        gaOpen: { ...prev.gaOpen },
        gaMine: { ...prev.gaMine },
      };
      fn(next);
      return next;
    });
    setStatusVersion((v) => v + 1);
  }, []);

  const applyAvailability = useCallback((availability: EventAvailability) => {
    setInv({
      taken: new Set(availability.taken),
      locked: new Set(availability.locked),
      mine: new Set(availability.mine),
      pending: new Set(),
      ga: availability.ga,
      gaOpen: availability.gaOpen ?? {},
      gaMine: availability.gaMine,
      version: availability.version,
    });
    setStatusVersion((v) => v + 1);
  }, []);

  const loadAll = useCallback(async () => {
    const [nextMap, availability] = await Promise.all([
      apiFetch<PublicSeatMap>(`/api/events/${eventId}/seatmap?locale=${locale}`),
      apiFetch<EventAvailability>(`/api/events/${eventId}/availability`),
    ]);
    setMap(nextMap);
    applyAvailability(availability);
  }, [applyAvailability, eventId, locale]);

  const loadAvailability = useCallback(async () => {
    applyAvailability(await apiFetch<EventAvailability>(`/api/events/${eventId}/availability`));
  }, [applyAvailability, eventId]);

  useEffect(() => {
    loadAll().catch(showError);
  }, [loadAll, showError]);

  // ── Live updates ─────────────────────────────────────────────────────────
  // True once the gateway confirmed the seat room; exposed as `data-realtime` (browser tests wait
  // for it before another visitor acts, see e2e/shop.spec.ts).
  const [realtimeJoined, setRealtimeJoined] = useState(false);
  useEffect(() => {
    const sync = () => setRealtimeJoined(isRoomJoined('seats', eventId));
    sync();
    return onRoomJoinChange(sync);
  }, [eventId]);

  useEffect(() => {
    const unsubscribe = subscribeRoom('seats', eventId);
    const off = onRealtime('seats:delta', (payload) => {
      const delta = payload as SeatDeltaMessage;
      if (delta.eventId !== eventId) return;
      if (delta.version !== undefined && delta.version !== invRef.current.version) {
        void loadAll();
        return;
      }
      update((draft) => {
        for (const [id, s] of delta.seats) {
          if (s === 'F') {
            draft.taken.delete(id);
            draft.locked.delete(id);
            if (!draft.pending.has(id)) draft.mine.delete(id);
          } else if (s === 'L') {
            if (!draft.mine.has(id) && !draft.pending.has(id)) draft.locked.add(id);
          } else {
            draft.taken.add(id);
            draft.locked.delete(id);
            draft.mine.delete(id);
          }
        }
        if (delta.ga) Object.assign(draft.ga, delta.ga);
        if (delta.gaOpen) Object.assign(draft.gaOpen, delta.gaOpen);
      });
    });
    // After a reconnect (network drop, maintenance) deltas were missed: refetch everything.
    // Carts and seat locks are gone after a restore: the cart is refetched as well. The seat map is
    // only reloaded after maintenance (it can have changed); a plain reconnect needs availability only.
    const offResync = onResync(({ full }) => {
      void (full ? loadAll() : loadAvailability()).catch(() => undefined);
      void refreshCart();
    });
    const ping = setInterval(() => emitRealtime('shop:ping', eventId), PING_INTERVAL_MS);
    emitRealtime('shop:ping', eventId);
    const stopPresence = startSocketPresence(eventId);
    return () => {
      off();
      offResync();
      unsubscribe();
      clearInterval(ping);
      stopPresence();
    };
  }, [eventId, loadAll, loadAvailability, refreshCart, update]);

  // Ticket counts for the waiting-list block of the page (only while the block listens).
  const waitlistWatched = useWaitlistWatched(eventId);
  useEffect(() => {
    if (!waitlistWatched || !map) return;
    publishWaitlistStates(
      eventId,
      computeWaitlistCategoryStates(map, {
        taken: inv.taken,
        held: new Set([...inv.locked, ...inv.mine, ...inv.pending]),
        ga: inv.ga,
        gaOpen: inv.gaOpen,
      }),
    );
  }, [eventId, inv, map, waitlistWatched]);

  const status = useCallback(
    (seatId: string): SeatStatus => {
      const current = invRef.current;
      if (current.pending.has(seatId)) return 'pending';
      if (current.mine.has(seatId)) return 'mine';
      if (current.taken.has(seatId)) return 'taken';
      if (current.locked.has(seatId)) return 'locked';
      return 'free';
    },
    // statusVersion forces a new function identity → seat layer re-renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [statusVersion],
  );

  // ── Derived data ─────────────────────────────────────────────────────────
  const lookups = useMemo(() => {
    if (!map) return null;
    return {
      sections: new Map(map.sections.map((s) => [s.id, s])),
      rows: new Map(map.rows.map((r) => [r.id, r])),
      categories: new Map(map.categories.map((c) => [c.id, c])),
      seats: new Map(map.seats.map((s) => [s.i, s])),
      priceRange: publicPriceRanges(map).byCategory,
    };
  }, [map]);

  /** "€29.00 – €59.00" (or one price) over the tariffs offered in a category. */
  const priceRangeLabel = useCallback(
    (categoryId: string) => {
      const range = lookups?.priceRange.get(categoryId);
      if (!range || !map) return '';
      return range.min === range.max
        ? money(range.min, map.currency)
        : t('priceRange', {
            min: money(range.min, map.currency),
            max: money(range.max, map.currency),
          });
    },
    [lookups, map, money, t],
  );

  /** Type of special seats, shown next to the seat number (tooltip, selection list). */
  const seatTypeLabel = useCallback(
    (seat: PublicSeat) =>
      (seat.f & SEAT_FLAG.WHEELCHAIR) !== 0
        ? t('seatType.wheelchair')
        : (seat.f & SEAT_FLAG.COMPANION) !== 0
          ? config.companionRequiresWheelchair && seat.w?.length
            ? t('companionSeatTitle')
            : t('seatType.companion')
          : null,
    [config.companionRequiresWheelchair, t],
  );

  const seatTitle = useCallback(
    (seat: PublicSeat) => {
      if (!lookups || !map) return '';
      const section = lookups.sections.get(seat.s);
      const row = seat.r ? lookups.rows.get(seat.r) : undefined;
      const category = seat.c ? lookups.categories.get(seat.c) : undefined;
      const parts = [
        section?.showLabelOnTicket ? section.ticketLabel : null,
        row ? t('row', { label: row.label }) : null,
        t('seat', { label: seat.l }),
        category
          ? `${category.name} · ${t('from', { price: money(lookups.priceRange.get(category.id)?.min ?? 0, map.currency) })}`
          : null,
        seatTypeLabel(seat),
      ];
      return parts.filter(Boolean).join(' · ');
    },
    [lookups, map, money, seatTypeLabel, t],
  );

  /** "Block, row A, seat 5" – used in announcements and accessible names. */
  const seatName = useCallback(
    (seat: PublicSeat) => {
      const section = lookups?.sections.get(seat.s);
      const row = seat.r ? lookups?.rows.get(seat.r) : undefined;
      return [
        section?.name,
        row ? t('row', { label: row.label }) : null,
        t('seat', { label: seat.l }),
      ]
        .filter(Boolean)
        .join(', ');
    },
    [lookups, t],
  );

  /** Accessible name of a seat on the plan / in the list: place, type, category + price, state. */
  const seatLabel = useCallback(
    (seat: PublicSeat, availability: SeatAvailability) => {
      const category = seat.c ? lookups?.categories.get(seat.c) : undefined;
      return [
        seatName(seat),
        seatTypeLabel(seat),
        category ? `${category.name}, ${priceRangeLabel(category.id)}` : null,
        t(`state.${availability}`),
      ]
        .filter(Boolean)
        .join(', ');
    },
    [lookups, priceRangeLabel, seatName, seatTypeLabel, t],
  );

  /** Accessible name of a standing section on the plan (keyboard control, opens its quantity panel). */
  const standingLabel = useCallback(
    (section: PublicSection) => {
      const category = section.priceCategoryId
        ? lookups?.categories.get(section.priceCategoryId)
        : undefined;
      return [
        t('standingLabel', { name: section.name }),
        category ? `${category.name}, ${priceRangeLabel(category.id)}` : null,
        t('standing.remaining', { count: inv.ga[section.id] ?? 0 }),
      ]
        .filter(Boolean)
        .join(', ');
    },
    [inv.ga, lookups, priceRangeLabel, t],
  );

  const isSeatUnavailable = useCallback((seat: PublicSeat) => {
    const current = invRef.current;
    return (
      (seat.f & SEAT_FLAG.BLOCKED) !== 0 || current.taken.has(seat.i) || current.locked.has(seat.i)
    );
  }, []);

  // Realtime changes announce only for the seat that has keyboard focus (no flood).
  useEffect(() => {
    const watched = watchedSeat.current;
    const seat = watched ? lookups?.seats.get(watched.id) : undefined;
    if (!watched || !seat) return;
    const unavailable = isSeatUnavailable(seat);
    if (unavailable === watched.unavailable) return;
    watched.unavailable = unavailable;
    announce(
      t(unavailable ? 'announce.nowUnavailable' : 'announce.nowAvailable', {
        seat: seatName(seat),
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusVersion]);

  const handleFocusSeat = useCallback(
    (id: string | null) => {
      const seat = id ? lookups?.seats.get(id) : undefined;
      watchedSeat.current = id && seat ? { id, unavailable: isSeatUnavailable(seat) } : null;
    },
    [isSeatUnavailable, lookups],
  );

  const selectedSeats = useMemo(
    () =>
      lookups
        ? [...inv.mine, ...inv.pending]
            .map((id) => lookups.seats.get(id))
            .filter((s): s is PublicSeat => !!s)
            .sort((a, b) =>
              `${a.s}|${a.r}|${(a.p ?? 0).toString().padStart(6, '0')}`.localeCompare(
                `${b.s}|${b.r}|${(b.p ?? 0).toString().padStart(6, '0')}`,
              ),
            )
        : [],
    [inv.mine, inv.pending, lookups],
  );
  const gaTotal = Object.values(inv.gaMine).reduce((a, b) => a + b, 0);
  const selectionCount = selectedSeats.length + gaTotal;

  // ── Actions ──────────────────────────────────────────────────────────────
  const toggleSeat = useCallback(
    async (seat: PublicSeat) => {
      if (!config.manualSeatSelectionEnabled) return;
      setHighlighted(new Set());
      const current = invRef.current;
      if (current.pending.has(seat.i)) return;
      if (current.mine.has(seat.i)) {
        update((d) => d.mine.delete(seat.i));
        try {
          await apiFetch(`/api/events/${eventId}/seats`, {
            method: 'DELETE',
            json: { seatIds: [seat.i] },
          });
          announce(t('announce.released', { seat: seatName(seat) }));
        } catch (err) {
          showError(err);
          announce(t('announce.failed', { seat: seatName(seat), error: errorMessage(tErr, err) }));
        }
        void refreshCart();
        return;
      }
      if (isSeatUnavailable(seat)) {
        announce(t('announce.unavailable', { seat: seatName(seat) }));
        return;
      }
      update((d) => d.pending.add(seat.i));
      try {
        await apiFetch(`/api/events/${eventId}/seats`, {
          method: 'POST',
          json: { seatIds: [seat.i] },
        });
        update((d) => {
          d.pending.delete(seat.i);
          d.mine.add(seat.i);
        });
        announce(t('announce.selected', { seat: seatName(seat) }));
        void refreshCart();
      } catch (err) {
        if (
          watchedSeat.current?.id === seat.i &&
          ['SEAT_LOCKED', 'SEAT_UNAVAILABLE'].includes(errorCode(err) ?? '')
        ) {
          // Announced below with the error; avoid a second "now not available" message.
          watchedSeat.current.unavailable = true;
        }
        announce(t('announce.failed', { seat: seatName(seat), error: errorMessage(tErr, err) }));
        update((d) => {
          d.pending.delete(seat.i);
          if (errorCode(err) === 'SEAT_LOCKED') d.locked.add(seat.i);
          if (errorCode(err) === 'SEAT_UNAVAILABLE') d.taken.add(seat.i);
        });
        showError(err);
        if (errorCode(err) === 'PASS_REQUIRED') onPassLost();
      }
    },
    [
      announce,
      config.manualSeatSelectionEnabled,
      eventId,
      isSeatUnavailable,
      onPassLost,
      refreshCart,
      seatName,
      showError,
      t,
      tErr,
      update,
    ],
  );

  const setGa = useCallback(
    async (sectionId: string, quantity: number) => {
      setBusy(true);
      try {
        const result = await apiFetch<{ held: number; remaining: number }>(
          `/api/events/${eventId}/general-admission`,
          {
            method: 'PUT',
            json: { sectionId, quantity },
          },
        );
        update((d) => {
          d.gaMine[sectionId] = result.held;
          d.ga[sectionId] = result.remaining;
        });
        void refreshCart();
      } catch (err) {
        showError(err);
      } finally {
        setBusy(false);
      }
    },
    [eventId, refreshCart, showError, update],
  );

  const [bestCategory, setBestCategory] = useState<string>('');
  const [bestQuantity, setBestQuantity] = useState(2);
  const requestBest = useCallback(async () => {
    if (!bestCategory) return;
    setBusy(true);
    try {
      const result = await apiFetch<{ seatIds: string[]; arrangement: BestAvailableArrangement }>(
        `/api/events/${eventId}/best-available`,
        {
          method: 'POST',
          json: { categoryId: bestCategory, quantity: bestQuantity },
        },
      );
      update((d) => {
        for (const id of result.seatIds) {
          d.mine.add(id);
          d.locked.delete(id);
        }
      });
      // Found seats are shown in the normal "your selection" style – the red highlight is
      // reserved for rule violations (orphan / companion seat).
      setHighlighted(new Set());
      if (result.arrangement === 'ROW') {
        toast.success(t('bestAvailable.found', { count: result.seatIds.length }));
      } else {
        // Not side by side: still selected, but tell the customer.
        toast.info(
          t(`bestAvailable.notTogether.${result.arrangement}`, { count: result.seatIds.length }),
          {
            duration: 10_000,
          },
        );
      }
      void refreshCart();
    } catch (err) {
      showError(err);
      if (errorCode(err) === 'PASS_REQUIRED') onPassLost();
    } finally {
      setBusy(false);
    }
  }, [bestCategory, bestQuantity, eventId, onPassLost, refreshCart, showError, t, update]);

  const continueToCart = useCallback(async () => {
    setBusy(true);
    try {
      const check = await apiFetch<{
        ok: boolean;
        orphanSeatIds: string[];
        companionSeatIds: string[];
        companionOwnerCheckSeatIds: string[];
      }>(`/api/events/${eventId}/selection`, {
        method: 'POST',
      });
      if (!check.ok) {
        setHighlighted(new Set([...check.orphanSeatIds, ...check.companionSeatIds]));
        if (check.companionSeatIds.length > 0) toast.warning(t('companionRule'));
        if (check.orphanSeatIds.length > 0) toast.warning(t('orphanRule'));
        return;
      }
      if (check.companionOwnerCheckSeatIds.length > 0) {
        // Wheelchair space already sold: allowed, but only for the same customer (checkout).
        toast.info(t('companionOwnerCheck'), { duration: 15_000 });
      }
      router.push('/cart');
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }, [eventId, router, showError, t]);

  // ── Render ───────────────────────────────────────────────────────────────
  if (!map || !lookups) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> {t('loading')}
      </div>
    );
  }

  const standingSections = map.sections.filter((s) => s.type === 'STANDING' && s.priceCategoryId);
  const activeGa = activeSection ? lookups.sections.get(activeSection) : undefined;
  const seatedCategories = map.categories.filter((c) => map.seats.some((s) => s.c === c.id));
  // Best-available is offered per category (the operator may switch it off, e.g. wheelchair places).
  const bestCategories = seatedCategories.filter((c) => c.bestAvailable);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
      <div className="space-y-3" data-realtime={realtimeJoined ? 'connected' : 'connecting'}>
        <MaintenanceNotice />
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {announcement.text}
          {announcement.n % 2 === 0 ? '' : '\u00a0'}
        </div>
        <div className="flex justify-end">
          <Button
            ref={viewToggleRef}
            variant="outline"
            size="sm"
            data-testid="seat-view-toggle"
            onClick={() => setView((v) => (v === 'plan' ? 'list' : 'plan'))}
          >
            {view === 'plan' ? <List /> : <MapIcon />}
            {view === 'plan' ? t('view.toList') : t('view.toPlan')}
          </Button>
        </div>
        {view === 'list' && (
          <SeatList
            map={map}
            status={status}
            statusVersion={statusVersion}
            seatLabel={seatLabel}
            onToggle={(seat) => void toggleSeat(seat)}
            onSectionClick={setActiveSection}
            gaRemaining={inv.ga}
            standingEnabled
          />
        )}
        {/* Stays mounted while the list is shown (the legend swatches use the plan's symbols). */}
        <div className={view === 'list' ? 'hidden' : undefined}>
          <SeatChart
            map={map}
            colors={colors}
            status={status}
            statusVersion={statusVersion}
            gaRemaining={inv.ga}
            gaMine={inv.gaMine}
            highlighted={highlighted}
            interactive={config.manualSeatSelectionEnabled || standingSections.length > 0}
            onSeatClick={toggleSeat}
            onSectionClick={setActiveSection}
            seatTitle={seatTitle}
            seatLabel={seatLabel}
            keyboardHelp={tChart('keyboardHelp')}
            standingLabel={standingLabel}
            onUnavailableSeat={(seat) => void toggleSeat(seat)}
            onFocusSeat={handleFocusSeat}
            onEscape={() => viewToggleRef.current?.focus()}
          />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {map.categories.map((c) => {
            const seated = map.seats.some((seat) => seat.c === c.id);
            return (
              <span key={c.id} className="flex items-center gap-1.5">
                {seated || !map.sections.some((sec) => sec.priceCategoryId === c.id) ? (
                  <SeatSwatch map={map} colors={colors} kind="free" categoryId={c.id} />
                ) : (
                  <StandingSwatch color={c.color} />
                )}
                {c.name} ·{' '}
                {t('from', {
                  price: money(lookups.priceRange.get(c.id)?.min ?? c.basePrice, map.currency),
                })}
              </span>
            );
          })}
          <SeatStateLegend map={map} colors={colors} />
        </div>
      </div>

      <aside className="space-y-4">
        {config.bestAvailableEnabled && bestCategories.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="size-4" /> {t('bestAvailable.title')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label id="best-available-category-label" htmlFor="best-available-category">
                  {t('bestAvailable.category')}
                </Label>
                <Select value={bestCategory} onValueChange={setBestCategory}>
                  <SelectTrigger
                    id="best-available-category"
                    aria-label={`${t('bestAvailable.category')}: ${
                      bestCategories.find((c) => c.id === bestCategory)
                        ? `${bestCategories.find((c) => c.id === bestCategory)!.name} · ${priceRangeLabel(bestCategory)}`
                        : t('bestAvailable.choose')
                    }`}
                    className="w-full"
                  >
                    <SelectValue placeholder={t('bestAvailable.choose')} />
                  </SelectTrigger>
                  <SelectContent>
                    {bestCategories.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name} · {priceRangeLabel(c.id)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <QuantityStepper
                label={t('bestAvailable.quantity')}
                value={bestQuantity}
                min={1}
                max={Math.min(
                  config.maxTicketsPerOrder ?? MAX_SEATS_PER_REQUEST,
                  MAX_SEATS_PER_REQUEST,
                )}
                onChange={setBestQuantity}
              />
              <Button
                className="w-full"
                disabled={!bestCategories.some((c) => c.id === bestCategory) || busy}
                onClick={requestBest}
              >
                {t('bestAvailable.submit')}
              </Button>
            </CardContent>
          </Card>
        )}

        {activeGa && activeGa.priceCategoryId && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-base">
                {activeGa.name}
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('close')}
                  onClick={() => setActiveSection(null)}
                >
                  <X />
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {t('standing.remaining', { count: inv.ga[activeGa.id] ?? 0 })} ·{' '}
                {t('from', {
                  price: money(
                    lookups.priceRange.get(activeGa.priceCategoryId)?.min ?? 0,
                    map.currency,
                  ),
                })}
              </p>
              <QuantityStepper
                label={t('standing.quantity')}
                value={inv.gaMine[activeGa.id] ?? 0}
                min={0}
                max={Math.min(
                  config.maxTicketsPerOrder ?? GA_MAX_PER_REQUEST,
                  GA_MAX_PER_REQUEST,
                  (inv.ga[activeGa.id] ?? 0) + (inv.gaMine[activeGa.id] ?? 0),
                )}
                disabled={busy}
                onChange={(q) => void setGa(activeGa.id, q)}
              />
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-base">
              {t('yourSelection')}
              <Badge variant="secondary">
                {config.maxTicketsPerOrder === null
                  ? t('countUnlimited', { count: selectionCount })
                  : t('count', { count: selectionCount, max: config.maxTicketsPerOrder })}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {selectionCount === 0 && (
              <p className="text-sm text-muted-foreground">
                {config.manualSeatSelectionEnabled ? t('emptyManual') : t('emptyBest')}
              </p>
            )}
            <ul className="space-y-2 text-sm">
              {selectedSeats.map((seat) => {
                const section = lookups.sections.get(seat.s);
                const row = seat.r ? lookups.rows.get(seat.r) : undefined;
                const category = seat.c ? lookups.categories.get(seat.c) : undefined;
                return (
                  <li key={seat.i} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <span
                        className="inline-block size-2.5 rounded-full"
                        style={{ background: category?.color }}
                      />
                      {[
                        section?.showLabelOnTicket ? section.ticketLabel : null,
                        row ? t('row', { label: row.label }) : null,
                        t('seat', { label: seat.l }),
                        (seat.f & (SEAT_FLAG.WHEELCHAIR | SEAT_FLAG.COMPANION)) !== 0
                          ? (seat.f & SEAT_FLAG.WHEELCHAIR) !== 0
                            ? t('seatType.wheelchair')
                            : t('seatType.companion')
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t('remove')}
                      onClick={() => void toggleSeat(seat)}
                    >
                      <X className="size-4" />
                    </Button>
                  </li>
                );
              })}
              {Object.entries(inv.gaMine)
                .filter(([, n]) => n > 0)
                .map(([sectionId, n]) => (
                  <li key={sectionId} className="flex items-center justify-between gap-2">
                    <span>
                      {lookups.sections.get(sectionId)?.name} × {n}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t('remove')}
                      onClick={() => void setGa(sectionId, 0)}
                    >
                      <X className="size-4" />
                    </Button>
                  </li>
                ))}
            </ul>
            {config.orphanSeatRuleEnabled && selectedSeats.length > 0 && (
              <p className="text-xs text-muted-foreground">{t('orphanHint')}</p>
            )}
            <Button
              className="w-full"
              disabled={selectionCount === 0 || busy}
              onClick={continueToCart}
            >
              {t('continue')}
            </Button>
            <p className="text-xs text-muted-foreground">{t('tariffHint')}</p>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

function QuantityStepper({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const t = useTranslations('shop.selection');
  return (
    <div className="flex items-center justify-between">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Button
          size="icon"
          variant="outline"
          aria-label={t('decrease')}
          disabled={disabled || value <= min}
          onClick={() => onChange(value - 1)}
        >
          <Minus />
        </Button>
        <span className="w-6 text-center tabular-nums" aria-live="polite">
          {value}
        </span>
        <Button
          size="icon"
          variant="outline"
          aria-label={t('increase')}
          disabled={disabled || value >= max}
          onClick={() => onChange(value + 1)}
        >
          <Plus />
        </Button>
      </div>
    </div>
  );
}

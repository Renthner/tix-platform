'use client';

import {
  SEAT_FLAG,
  type EventAvailability,
  type PublicSeat,
  type PublicSeatMap,
} from '@tix/shared';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiFetch, errorMessage } from '@/lib/api';
import { useEventDate } from '@/lib/format';
import { useFieldErrors } from '@/lib/field-errors';
import {
  readHoldSnapshot,
  remountedInDocument,
  resolveHoldTabId,
  writeHoldSnapshot,
} from '@/lib/hold-session';
import { parseMoneyToCents } from '@/lib/money';
import {
  SeatChart,
  type SeatColors,
  type SeatStatus,
} from '@/components/shop/seat-chart/seat-chart';
import { SeatStateLegend } from '@/components/shop/seat-chart/seat-legend';
import {
  buildLines,
  defaultTariff,
  emptyBuyer,
  sectionTotal,
  SELL_FIELDS,
  sortSeatsForList,
} from './parts/helpers';
import { PaymentCard } from './parts/payment-card';
import { SaleSuccess } from './parts/sale-success';
import { SelectionCard } from './parts/selection-card';
import { StandingCard } from './parts/standing-card';
import { TotalsCard } from './parts/totals-card';
import type {
  BoxOfficeEvent,
  BuyerState,
  HeldState,
  HoldSnapshot,
  Inventory,
  Payment,
  Permissions,
  Pick,
  SaleResult,
} from './parts/types';
import { useHoldRelease } from './parts/use-hold-release';
import { useInvoicePoll } from './parts/use-invoice-poll';
import { useLiveSeats } from './parts/use-live-seats';
import { useQuote } from './parts/use-quote';

export type { BoxOfficeEvent } from './parts/types';

export function BoxOffice({
  events,
  colors,
  permissions,
  canOpenOrders,
  defaultLocale,
}: {
  events: BoxOfficeEvent[];
  colors: SeatColors;
  permissions: Permissions;
  canOpenOrders: boolean;
  /** Shop default language: preselected for the buyer's mails. */
  defaultLocale: string;
}) {
  const t = useTranslations('orders.boxOffice');
  const tErr = useTranslations('common.errors');
  const fe = useFieldErrors(SELL_FIELDS, tErr('FIELD_INVALID'));
  const eventDate = useEventDate();

  const [eventId, setEventId] = useState<string>('');
  const [map, setMap] = useState<PublicSeatMap | null>(null);
  const [inv, setInv] = useState<Inventory>({
    taken: new Set(),
    locked: new Set(),
    ga: {},
    version: 0,
  });
  const [statusVersion, setStatusVersion] = useState(0);
  const [seatPicks, setSeatPicks] = useState<Map<string, Pick>>(new Map());
  /** Standing spots per area and tariff. */
  const [gaPicks, setGaPicks] = useState<Record<string, Record<string, number>>>({});
  /** Lock session of this browser tab: stable across navigation / reload (see hold-session). */
  const [tabId, setTabId] = useState<string | null>(null);
  const tabIdRef = useRef<string | null>(null);
  const [buyerLocale, setBuyerLocale] = useState(defaultLocale);
  /** End of the seat lock hold (epoch ms); null = nothing held. */
  const [holdExpiresAt, setHoldExpiresAt] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const pendingSeats = useRef(new Set<string>());
  const [allowBlocked, setAllowBlocked] = useState(false);
  const [payment, setPayment] = useState<Payment>('CASH');
  const [showBuyer, setShowBuyer] = useState(false);
  const [buyer, setBuyer] = useState<BuyerState>(emptyBuyer);
  const [sendEmail, setSendEmail] = useState(false);
  const [reason, setReason] = useState('');
  const [given, setGiven] = useState('');
  const [selling, setSelling] = useState(false);
  const [sale, setSale] = useState<SaleResult | null>(null);

  const invRef = useRef(inv);
  invRef.current = inv;
  const seatPicksRef = useRef(seatPicks);
  seatPicksRef.current = seatPicks;

  const showError = useCallback((err: unknown) => toast.error(errorMessage(tErr, err)), [tErr]);

  // ── Load plan + availability ─────────────────────────────────────────────
  const load = useCallback(async (id: string) => {
    const data = await apiFetch<{ map: PublicSeatMap; availability: EventAvailability }>(
      `/api/admin/box-office/events/${id}`,
    );
    setMap(data.map);
    setInv({
      taken: new Set(data.availability.taken),
      locked: new Set(data.availability.locked),
      ga: data.availability.ga,
      version: data.availability.version,
    });
    setStatusVersion((v) => v + 1);
    return data.map;
  }, []);

  /** Hold API (real seat locks, one lock session per admin tab). */
  const hold = useCallback(
    (body: Record<string, unknown>) =>
      apiFetch<{ expiresAt?: number | null }>('/api/admin/box-office/hold', {
        method: 'POST',
        json: { tabId: tabIdRef.current, ...body },
      }),
    [],
  );

  // ── Restore after navigation / reload: selection + countdown come from the server ────────
  useEffect(() => {
    let cancelled = false;
    void resolveHoldTabId('boxoffice').then(async (id) => {
      if (cancelled) return;
      tabIdRef.current = id;
      setTabId(id);
      const snapshot = readHoldSnapshot<HoldSnapshot>('boxoffice');
      if (!snapshot) {
        remountedInDocument('boxoffice');
        return;
      }
      if (!remountedInDocument('boxoffice') || !events.some((e) => e.id === snapshot.eventId)) {
        // Fresh document (reload / first visit): a reload starts a new sale. Release what the
        // previous document held (its pagehide request may not have arrived yet) and start clean.
        writeHoldSnapshot('boxoffice', null);
        await apiFetch('/api/admin/box-office/hold', {
          method: 'POST',
          json: { op: 'release', eventId: snapshot.eventId, tabId: id },
        }).catch(() => undefined);
        return;
      }
      try {
        const loaded = await load(snapshot.eventId);
        const held = await apiFetch<HeldState>(
          `/api/admin/box-office/hold?eventId=${snapshot.eventId}&tabId=${id}`,
        );
        if (cancelled) return;
        const picks = new Map<string, Pick>();
        const savedPicks = new Map(snapshot.picks);
        const seats = new Map(loaded.seats.map((x) => [x.i, x]));
        for (const seatId of held.seatIds) {
          const seat = seats.get(seatId);
          if (!seat || !seat.c) continue;
          const saved = savedPicks.get(seatId);
          const tariff =
            saved && loaded.ticketTypes.some((x) => x.id === saved.tariffId)
              ? saved.tariffId
              : defaultTariff(loaded, seat.c, seat.f)?.id;
          if (tariff) picks.set(seatId, { tariffId: tariff, override: saved?.override ?? '' });
        }
        const ga: Record<string, Record<string, number>> = {};
        for (const [sectionId, quantity] of Object.entries(held.ga)) {
          const saved = snapshot.ga[sectionId];
          const savedTotal = sectionTotal(saved);
          if (saved && savedTotal === quantity) {
            ga[sectionId] = saved;
            continue;
          }
          const section = loaded.sections.find((x) => x.id === sectionId);
          const tariff = section?.priceCategoryId
            ? defaultTariff(loaded, section.priceCategoryId, null)
            : null;
          if (tariff) ga[sectionId] = { [tariff.id]: quantity };
        }
        setEventId(snapshot.eventId);
        setSeatPicks(picks);
        setGaPicks(ga);
        setHoldExpiresAt(held.expiresAt);
        setStatusVersion((v) => v + 1);
      } catch (err) {
        writeHoldSnapshot('boxoffice', null);
        showError(err);
      }
    });
    return () => {
      cancelled = true;
    };
    // once per mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Remember the selection details the server does not hold (tariffs, overrides).
  useEffect(() => {
    if (!eventId) return;
    writeHoldSnapshot('boxoffice', {
      eventId,
      picks: [...seatPicks],
      ga: gaPicks,
    } satisfies HoldSnapshot);
  }, [eventId, seatPicks, gaPicks]);

  const chooseEvent = (id: string) => {
    // An explicit event switch starts a fresh sale: drop what this tab still holds.
    if (eventId) void hold({ op: 'release', eventId }).catch(() => undefined);
    void hold({ op: 'release', eventId: id }).catch(() => undefined);
    setHoldExpiresAt(null);
    setEventId(id);
    setMap(null);
    setSeatPicks(new Map());
    setGaPicks({});
    setSale(null);
    load(id).catch(showError);
  };

  useLiveSeats({ eventId, load, invRef, setInv, setStatusVersion, setSeatPicks });

  const lookups = useMemo(() => {
    if (!map) return null;
    return {
      sections: new Map(map.sections.map((s) => [s.id, s])),
      rows: new Map(map.rows.map((r) => [r.id, r])),
      categories: new Map(map.categories.map((c) => [c.id, c])),
      seats: new Map(map.seats.map((s) => [s.i, s])),
      tariffs: new Map(map.ticketTypes.map((x) => [x.id, x])),
    };
  }, [map]);

  const status = useCallback(
    (seatId: string): SeatStatus => {
      if (seatPicksRef.current.has(seatId)) return 'mine';
      if (invRef.current.taken.has(seatId)) return 'taken';
      if (invRef.current.locked.has(seatId)) return 'locked';
      return 'free';
    },
    // statusVersion forces a new function identity → the seat layer re-renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [statusVersion],
  );

  const seatText = useCallback(
    (seat: PublicSeat) => {
      if (!lookups) return '';
      const section = lookups.sections.get(seat.s);
      const row = seat.r ? lookups.rows.get(seat.r) : undefined;
      const name = section?.ticketLabel || section?.name || '';
      return row
        ? t('seatLabel', { section: name, row: row.label, seat: seat.l })
        : t('seatLabelNoRow', { section: name, seat: seat.l });
    },
    [lookups, t],
  );

  const toggleSeat = useCallback(
    async (seat: PublicSeat) => {
      if (!map || !seat.c) return;
      const blocked = (seat.f & SEAT_FLAG.BLOCKED) !== 0;
      if (blocked && !allowBlocked) return;
      if (pendingSeats.current.has(seat.i)) return;
      if (seatPicksRef.current.has(seat.i)) {
        removeSeat(seat.i);
        return;
      }
      if (invRef.current.taken.has(seat.i) || invRef.current.locked.has(seat.i)) return;
      const tariff = defaultTariff(map, seat.c, seat.f);
      if (!tariff) return;
      pendingSeats.current.add(seat.i);
      try {
        // Blocked seats cannot be locked online anyway; the unique index guards them at sale time.
        if (!blocked) {
          const result = await hold({ op: 'add', eventId, seatIds: [seat.i] });
          if (result.expiresAt) setHoldExpiresAt(result.expiresAt);
        }
        setSeatPicks((prev) => new Map(prev).set(seat.i, { tariffId: tariff.id, override: '' }));
        setStatusVersion((v) => v + 1);
      } catch (err) {
        showError(err);
      } finally {
        pendingSeats.current.delete(seat.i);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allowBlocked, map, eventId, hold, showError],
  );

  function removeSeat(seatId: string) {
    const blocked = ((lookups?.seats.get(seatId)?.f ?? 0) & SEAT_FLAG.BLOCKED) !== 0;
    setSeatPicks((prev) => {
      const next = new Map(prev);
      next.delete(seatId);
      return next;
    });
    setStatusVersion((v) => v + 1);
    if (!blocked) void hold({ op: 'remove', eventId, seatIds: [seatId] }).catch(() => undefined);
  }

  const updatePick = (seatId: string, patch: Partial<Pick>) =>
    setSeatPicks((prev) => {
      const current = prev.get(seatId);
      return current ? new Map(prev).set(seatId, { ...current, ...patch }) : prev;
    });

  // Un-releasing blocked seats drops them from the selection.
  useEffect(() => {
    if (allowBlocked || !lookups) return;
    setSeatPicks((prev) => {
      const keep = [...prev].filter(
        ([id]) => ((lookups.seats.get(id)?.f ?? 0) & SEAT_FLAG.BLOCKED) === 0,
      );
      if (keep.length === prev.size) return prev;
      setStatusVersion((v) => v + 1);
      return new Map(keep);
    });
  }, [allowBlocked, lookups]);

  /** Sets the quantity of one tariff in a standing area and holds the new total. */
  const setGa = async (sectionId: string, tariffId: string, quantity: number) => {
    const current = gaPicks[sectionId] ?? {};
    const next = { ...current, [tariffId]: Math.max(0, quantity) };
    if (next[tariffId] === 0) delete next[tariffId];
    try {
      const result = await hold({
        op: 'standing',
        eventId,
        sectionId,
        quantity: sectionTotal(next),
      });
      if (result.expiresAt) setHoldExpiresAt(result.expiresAt);
      setGaPicks((prev) => ({ ...prev, [sectionId]: next }));
    } catch (err) {
      showError(err);
    }
  };

  // ── Lines + quote ────────────────────────────────────────────────────────
  const hasOverride =
    payment !== 'COMPLIMENTARY' && [...seatPicks.values()].some((p) => p.override.trim() !== '');
  const lines = useMemo(
    () => buildLines(eventId, seatPicks, gaPicks, payment),
    [eventId, seatPicks, gaPicks, payment],
  );
  const ticketCount = lines.reduce(
    (n, l) => n + (typeof l.quantity === 'number' ? l.quantity : 1),
    0,
  );
  const { quote, quoteBusy, quoteError } = useQuote(lines, payment, allowBlocked, sale);

  // ── Sell ─────────────────────────────────────────────────────────────────
  const emailGiven = buyer.email.trim() !== '';
  const addressGiven = Boolean(buyer.street.trim() && buyer.postalCode.trim() && buyer.city.trim());
  const buyerDataMissing =
    Boolean(quote?.buyerDataRequired) &&
    !(buyer.firstName.trim() && buyer.lastName.trim() && addressGiven);
  const sell = async () => {
    if (lines.length === 0 || selling) return;
    setSelling(true);
    fe.reset();
    try {
      const result = await apiFetch<Omit<SaleResult, 'email'>>('/api/admin/box-office/sell', {
        method: 'POST',
        json: {
          lines,
          payment,
          allowBlocked,
          locale: buyerLocale,
          tabId: tabIdRef.current ?? undefined,
          sendEmail: sendEmail && emailGiven,
          note: buyer.note || undefined,
          priceOverrideReason: hasOverride ? reason : undefined,
          buyer: {
            firstName: buyer.firstName,
            lastName: buyer.lastName,
            email: buyer.email,
            phone: buyer.phone,
            company: buyer.company,
            ...(addressGiven
              ? {
                  address: {
                    street: buyer.street,
                    addressLine2: buyer.addressLine2 || undefined,
                    postalCode: buyer.postalCode,
                    city: buyer.city,
                    country: buyer.country,
                  },
                }
              : {}),
          },
        },
      });
      setHoldExpiresAt(null);
      setSale({ ...result, email: sendEmail && emailGiven ? buyer.email.trim() : null });
      // Show the sale on the plan right away (the broadcast follows anyway).
      void load(eventId).catch(() => undefined);
      setSeatPicks(new Map());
      setGaPicks({});
    } catch (err) {
      // Red border + message on the affected buyer fields (the buyer block opens if hidden).
      if (fe.apply(err)) setShowBuyer(true);
      showError(err);
      void load(eventId).catch(() => undefined);
    } finally {
      setSelling(false);
    }
  };

  /** "Clear selection": releases everything this tab holds. */
  const clearSelection = () => {
    setSeatPicks(new Map());
    setGaPicks({});
    setHoldExpiresAt(null);
    setStatusVersion((v) => v + 1);
    writeHoldSnapshot('boxoffice', null);
    void hold({ op: 'release', eventId })
      .catch(() => undefined)
      .finally(() => void load(eventId).catch(() => undefined));
  };

  const nextSale = () => {
    setSale(null);
    setBuyer(emptyBuyer());
    setSendEmail(false);
    setReason('');
    setGiven('');
    setPayment('CASH');
    setAllowBlocked(false);
    void hold({ op: 'release', eventId }).catch(() => undefined);
    void load(eventId).catch(showError);
  };

  // ── Hold countdown, expiry, release on leaving ────────────────────────────
  useEffect(() => {
    if (!holdExpiresAt) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [holdExpiresAt]);
  useEffect(() => {
    if (!holdExpiresAt || clock < holdExpiresAt) return;
    // The locks are gone: clear the selection (blocked-seat picks were never locked).
    setHoldExpiresAt(null);
    setSeatPicks(new Map());
    setGaPicks({});
    setStatusVersion((v) => v + 1);
    toast.warning(t('hold.expired'));
    void load(eventId).catch(() => undefined);
  }, [clock, holdExpiresAt, eventId, load, t]);
  useHoldRelease({
    eventId,
    tabId,
    load,
    showError,
    setSeatPicks,
    setGaPicks,
    setHoldExpiresAt,
    setStatusVersion,
  });

  const { invoiceId, invoiceGaveUp } = useInvoicePoll(sale);

  // ── Render ───────────────────────────────────────────────────────────────
  const selectedEvent = events.find((e) => e.id === eventId);
  // Admission-only events have no seating plan: the contingent list replaces the plan picker.
  const admission = selectedEvent?.admission === true;
  const standing = map?.sections.filter((s) => s.type === 'STANDING' && s.priceCategoryId) ?? [];
  const givenCents = given.trim() ? parseMoneyToCents(given) : null;
  const sortedSeats = useMemo(() => {
    if (!lookups) return [];
    return sortSeatsForList(
      [...seatPicks.keys()].map((id) => lookups.seats.get(id)).filter((s): s is PublicSeat => !!s),
    );
  }, [lookups, seatPicks]);

  return (
    <div className="space-y-4">
      <div className="max-w-xl space-y-1.5">
        <Label>{t('event')}</Label>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noEvents')}</p>
        ) : (
          <Select value={eventId} onValueChange={chooseEvent} disabled={!tabId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t('chooseEvent')} />
            </SelectTrigger>
            <SelectContent>
              {events.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.title} · {eventDate(e.startsAt, e.timeZone)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {selectedEvent?.venueName && (
          <p className="text-xs text-muted-foreground">{selectedEvent.venueName}</p>
        )}
      </div>

      {eventId && (!map || !lookups) && (
        <div className="flex h-48 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> {t('loading')}
        </div>
      )}

      {map && lookups && (
        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
          <div className="space-y-3">
            {admission ? (
              <StandingCard
                map={map}
                standing={standing}
                gaPicks={gaPicks}
                inv={inv}
                setGa={setGa}
                title={t('admissionTickets')}
              />
            ) : (
              <>
                <SeatChart
                  map={map}
                  colors={colors}
                  status={status}
                  statusVersion={statusVersion}
                  gaRemaining={inv.ga}
                  gaMine={Object.fromEntries(
                    Object.entries(gaPicks).map(([id, picks]) => [id, sectionTotal(picks)]),
                  )}
                  highlighted={new Set()}
                  interactive
                  onSeatClick={(seat) => void toggleSeat(seat)}
                  onSectionClick={(sectionId) => {
                    const section = lookups.sections.get(sectionId);
                    const category = section?.priceCategoryId;
                    const tariff = category ? defaultTariff(map, category, null) : null;
                    if (section?.type === 'STANDING' && tariff)
                      void setGa(sectionId, tariff.id, (gaPicks[sectionId]?.[tariff.id] ?? 0) + 1);
                  }}
                  seatTitle={seatText}
                  sellBlocked={allowBlocked}
                />
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  <SeatStateLegend map={map} colors={colors} sellBlocked={allowBlocked} />
                </div>
                {permissions.blockedSeats && (
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={allowBlocked}
                      onCheckedChange={(v) => setAllowBlocked(v === true)}
                      className="mt-0.5"
                    />
                    <span>
                      {t('allowBlocked')}
                      <span className="block text-xs text-muted-foreground">
                        {t('allowBlockedHint')}
                      </span>
                    </span>
                  </label>
                )}
              </>
            )}
          </div>

          <aside className="space-y-4">
            {sale ? (
              <SaleSuccess
                sale={sale}
                invoiceId={invoiceId}
                invoiceGaveUp={invoiceGaveUp}
                canOpenOrders={canOpenOrders}
                onNext={nextSale}
              />
            ) : (
              <>
                <SelectionCard
                  map={map}
                  lookups={lookups}
                  sortedSeats={sortedSeats}
                  seatPicks={seatPicks}
                  seatText={seatText}
                  permissions={permissions}
                  payment={payment}
                  lineCount={lines.length}
                  holdExpiresAt={holdExpiresAt}
                  clock={clock}
                  hasOverride={hasOverride}
                  reason={reason}
                  setReason={setReason}
                  fe={fe}
                  removeSeat={removeSeat}
                  updatePick={updatePick}
                  emptyText={admission ? t('emptyAdmission') : undefined}
                />
                {!admission && standing.length > 0 && (
                  <StandingCard
                    map={map}
                    standing={standing}
                    gaPicks={gaPicks}
                    inv={inv}
                    setGa={setGa}
                  />
                )}
                <PaymentCard
                  permissions={permissions}
                  payment={payment}
                  setPayment={setPayment}
                  quote={quote}
                  showBuyer={showBuyer}
                  setShowBuyer={setShowBuyer}
                  buyerDataMissing={buyerDataMissing}
                  buyer={buyer}
                  setBuyer={setBuyer}
                  buyerLocale={buyerLocale}
                  setBuyerLocale={setBuyerLocale}
                  sendEmail={sendEmail}
                  setSendEmail={setSendEmail}
                  emailGiven={emailGiven}
                  fe={fe}
                />
                <TotalsCard
                  quote={quote}
                  quoteError={quoteError}
                  quoteBusy={quoteBusy}
                  payment={payment}
                  given={given}
                  setGiven={setGiven}
                  givenCents={givenCents}
                  lineCount={lines.length}
                  ticketCount={ticketCount}
                  selling={selling}
                  sellDisabled={!quote || buyerDataMissing || (hasOverride && reason.trim() === '')}
                  onClear={clearSelection}
                  onSell={() => void sell()}
                />
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

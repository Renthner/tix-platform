'use client';

import {
  SEAT_FLAG,
  SUPPORTED_LOCALES,
  type EventAvailability,
  type PublicSeat,
  type PublicSeatMap,
  type PublicTicketType,
  type SeatDeltaMessage,
} from '@tix/shared';
import { Check, Loader2, Minus, Plus, Printer, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatCountdown } from '@/lib/format';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { COUNTRIES } from '@/components/shop/checkout-form';
import { Link } from '@/i18n/navigation';
import { apiFetch, errorMessage } from '@/lib/api';
import { useEventDate, useMoney } from '@/lib/format';
import { useFieldErrors, type FieldMap } from '@/lib/field-errors';
import {
  readHoldSnapshot,
  remountedInDocument,
  resolveHoldTabId,
  writeHoldSnapshot,
} from '@/lib/hold-session';
import { parseMoneyToCents } from '@/lib/money';
import { onRealtime, onResync, subscribeRoom } from '@/lib/realtime';
import {
  SeatChart,
  type SeatColors,
  type SeatStatus,
} from '@/components/shop/seat-chart/seat-chart';
import { SeatStateLegend } from '@/components/shop/seat-chart/seat-legend';

export interface BoxOfficeEvent {
  id: string;
  title: string;
  startsAt: string;
  timeZone: string;
  venueName: string;
}

interface Permissions {
  complimentary: boolean;
  priceOverride: boolean;
  blockedSeats: boolean;
}

type Payment = 'CASH' | 'CARD' | 'COMPLIMENTARY';

interface Inventory {
  taken: Set<string>;
  locked: Set<string>;
  ga: Record<string, number>;
  version: number;
}

interface Pick {
  tariffId: string;
  /** Typed price override (text, as entered). */
  override: string;
}

/** What the tab remembers about its selection (the server only knows seats and quantities). */
interface HoldSnapshot {
  eventId: string;
  picks: [string, Pick][];
  ga: Record<string, Record<string, number>>;
}

interface Quote {
  currency: string;
  subtotalGross: number;
  discountTotal: number;
  feeTotal: number;
  totalGross: number;
  fees: { name: string; totalGross: number }[];
  buyerDataRequired: boolean;
  smallAmountInvoiceLimit: number;
}

interface SaleResult {
  orderId: string;
  orderNumber: string;
  totalGross: number;
  currency: string;
  ticketCount: number;
  ticketsReady: boolean;
  payment: Payment;
  email: string | null;
}

/** Tariffs sellable on a seat / in an area (same rules as the shop cart). */
function allowedTariffs(
  map: PublicSeatMap,
  categoryId: string,
  flags: number | null,
): PublicTicketType[] {
  return map.ticketTypes.filter((t) => {
    if (t.prices[categoryId] === undefined) return false;
    if (t.requiredSeatFeature === 'WHEELCHAIR_SPACE')
      return flags !== null && (flags & SEAT_FLAG.WHEELCHAIR) !== 0;
    if (t.requiredSeatFeature === 'COMPANION_SEAT')
      return flags !== null && (flags & SEAT_FLAG.COMPANION) !== 0;
    return true;
  });
}

function defaultTariff(
  map: PublicSeatMap,
  categoryId: string,
  flags: number | null,
): PublicTicketType | null {
  const allowed = allowedTariffs(map, categoryId, flags);
  return (
    allowed.find((t) => t.requiredSeatFeature !== null) ??
    allowed.find((t) => t.isDefault) ??
    allowed[0] ??
    null
  );
}

/** Zod issue path (sell API) → control id. */
const SELL_FIELDS: FieldMap = {
  'buyer.firstName': 'bo-firstName',
  'buyer.lastName': 'bo-lastName',
  'buyer.email': 'bo-email',
  'buyer.phone': 'bo-phone',
  'buyer.company': 'bo-company',
  'buyer.address': 'bo-street',
  'buyer.address.street': 'bo-street',
  'buyer.address.addressLine2': 'bo-addressLine2',
  'buyer.address.postalCode': 'bo-postalCode',
  'buyer.address.city': 'bo-city',
  'buyer.address.country': 'bo-country',
  note: 'bo-note',
  locale: 'bo-language',
  priceOverrideReason: 'bo-reason',
};

function FieldMessage({ message }: { message: string | undefined }) {
  return message ? (
    <p className="text-xs text-destructive" role="alert">
      {message}
    </p>
  ) : null;
}

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
  const locale = useLocale();
  const tMethod = useTranslations('orders.method');
  const money = useMoney();
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
  const tErrAddress = useTranslations('checkout.address');
  const [allowBlocked, setAllowBlocked] = useState(false);
  const [payment, setPayment] = useState<Payment>('CASH');
  const [showBuyer, setShowBuyer] = useState(false);
  const [buyer, setBuyer] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    company: '',
    note: '',
    street: '',
    addressLine2: '',
    postalCode: '',
    city: '',
    country: 'DE',
  });
  const [sendEmail, setSendEmail] = useState(false);
  const [reason, setReason] = useState('');
  const [given, setGiven] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
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
        const held = await apiFetch<{
          seatIds: string[];
          ga: Record<string, number>;
          expiresAt: number | null;
        }>(`/api/admin/box-office/hold?eventId=${snapshot.eventId}&tabId=${id}`);
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
          const savedTotal = Object.values(saved ?? {}).reduce((n, q) => n + q, 0);
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
    setQuote(null);
    setSale(null);
    load(id).catch(showError);
  };

  // ── Live updates (same stream as the shop; no shopper heartbeat is sent) ──
  useEffect(() => {
    if (!eventId) return;
    const unsubscribe = subscribeRoom('seats', eventId);
    const off = onRealtime('seats:delta', (payload) => {
      const delta = payload as SeatDeltaMessage;
      if (delta.eventId !== eventId) return;
      if (delta.version !== undefined && delta.version !== invRef.current.version) {
        void load(eventId).catch(() => undefined);
        return;
      }
      setInv((prev) => {
        const next: Inventory = {
          ...prev,
          taken: new Set(prev.taken),
          locked: new Set(prev.locked),
          ga: { ...prev.ga },
        };
        for (const [id, s] of delta.seats) {
          if (s === 'F') {
            next.taken.delete(id);
            next.locked.delete(id);
          } else if (s === 'L') {
            next.locked.add(id);
          } else {
            next.taken.add(id);
            next.locked.delete(id);
          }
        }
        if (delta.ga) Object.assign(next.ga, delta.ga);
        return next;
      });
      setStatusVersion((v) => v + 1);
      // A selected seat that was sold meanwhile leaves the selection.
      setSeatPicks((prev) => {
        const sold = delta.seats.filter(([id, s]) => s === 'S' && prev.has(id));
        if (sold.length === 0) return prev;
        const next = new Map(prev);
        for (const [id] of sold) next.delete(id);
        return next;
      });
    });
    const offResync = onResync(() => void load(eventId).catch(() => undefined));
    return () => {
      off();
      offResync();
      unsubscribe();
    };
  }, [eventId, load]);

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

  const sectionTotal = (picks: Record<string, number> | undefined) =>
    Object.values(picks ?? {}).reduce((n, q) => n + q, 0);

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
  const lines = useMemo(() => {
    const result: Record<string, unknown>[] = [];
    for (const [seatId, pick] of seatPicks) {
      const cents =
        payment !== 'COMPLIMENTARY' && pick.override.trim()
          ? parseMoneyToCents(pick.override)
          : null;
      result.push({
        eventId,
        seatId,
        ticketTypeId: pick.tariffId,
        ...(cents !== null ? { priceOverrideCents: cents } : {}),
      });
    }
    for (const [sectionId, picks] of Object.entries(gaPicks)) {
      for (const [tariffId, quantity] of Object.entries(picks)) {
        if (quantity > 0) result.push({ eventId, sectionId, quantity, ticketTypeId: tariffId });
      }
    }
    return result;
  }, [eventId, seatPicks, gaPicks, payment]);
  const ticketCount = lines.reduce(
    (n, l) => n + (typeof l.quantity === 'number' ? l.quantity : 1),
    0,
  );

  useEffect(() => {
    if (lines.length === 0 || sale) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    let cancelled = false;
    setQuoteBusy(true);
    const timer = setTimeout(() => {
      apiFetch<Quote>('/api/admin/box-office/quote', {
        method: 'POST',
        json: { lines, payment, allowBlocked },
      })
        .then((q) => {
          if (cancelled) return;
          setQuote(q);
          setQuoteError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setQuote(null);
          setQuoteError(errorMessage(tErr, err));
        })
        .finally(() => {
          if (!cancelled) setQuoteBusy(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [lines, payment, allowBlocked, sale, tErr]);

  // ── Sell ─────────────────────────────────────────────────────────────────
  const languageNames = useMemo(
    () => new Intl.DisplayNames([locale], { type: 'language' }),
    [locale],
  );
  const regionNames = useMemo(() => new Intl.DisplayNames([locale], { type: 'region' }), [locale]);
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
    setBuyer({
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      company: '',
      note: '',
      street: '',
      addressLine2: '',
      postalCode: '',
      city: '',
      country: 'DE',
    });
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
  // Only closing / reloading the tab releases the hold; client-side navigation keeps it (the
  // selection is restored when the page is opened again, the TTL frees it otherwise).
  useEffect(() => {
    if (!eventId || !tabId) return;
    const release = () =>
      void fetch('/api/admin/box-office/hold', {
        method: 'POST',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'release', eventId, tabId }),
      }).catch(() => undefined);
    // Back/forward cache: the page returns without remounting although pagehide released the
    // hold on the server. Re-read what the server still holds so the UI never shows a stale hold.
    const restored = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      void (async () => {
        try {
          await load(eventId);
          const held = await apiFetch<{
            seatIds: string[];
            ga: Record<string, number>;
            expiresAt: number | null;
          }>(`/api/admin/box-office/hold?eventId=${eventId}&tabId=${tabId}`);
          const heldSeats = new Set(held.seatIds);
          setSeatPicks((prev) => new Map([...prev].filter(([seatId]) => heldSeats.has(seatId))));
          setGaPicks((prev) => {
            const next: Record<string, Record<string, number>> = {};
            for (const [sectionId, quantity] of Object.entries(held.ga)) {
              const mine = prev[sectionId];
              if (mine && Object.values(mine).reduce((n, q) => n + q, 0) === quantity) {
                next[sectionId] = mine;
              }
            }
            return next;
          });
          setHoldExpiresAt(held.expiresAt);
          setStatusVersion((v) => v + 1);
        } catch (err) {
          showError(err);
        }
      })();
    };
    window.addEventListener('pagehide', release);
    window.addEventListener('pageshow', restored);
    return () => {
      window.removeEventListener('pagehide', release);
      window.removeEventListener('pageshow', restored);
    };
  }, [eventId, tabId, load, showError]);

  // ── Invoice (issued by the worker shortly after the sale) ─────────────────
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [invoiceGaveUp, setInvoiceGaveUp] = useState(false);
  useEffect(() => {
    setInvoiceId(null);
    setInvoiceGaveUp(false);
    if (!sale || sale.payment === 'COMPLIMENTARY') return;
    let stopped = false;
    let attempts = 0;
    const poll = async () => {
      attempts += 1;
      try {
        const state = await apiFetch<{ invoiceId: string | null }>(
          `/api/admin/box-office/orders/${sale.orderId}`,
        );
        if (stopped) return;
        if (state.invoiceId) {
          setInvoiceId(state.invoiceId);
          return;
        }
      } catch {
        // keep polling
      }
      if (attempts >= 10) setInvoiceGaveUp(true);
      else timer = setTimeout(poll, 2000);
    };
    let timer = setTimeout(poll, 1500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [sale]);

  // ── Render ───────────────────────────────────────────────────────────────
  const selectedEvent = events.find((e) => e.id === eventId);
  const standing = map?.sections.filter((s) => s.type === 'STANDING' && s.priceCategoryId) ?? [];
  const givenCents = given.trim() ? parseMoneyToCents(given) : null;
  const sortedSeats = useMemo(() => {
    if (!lookups) return [];
    return [...seatPicks.keys()]
      .map((id) => lookups.seats.get(id))
      .filter((s): s is PublicSeat => !!s)
      .sort((a, b) =>
        `${a.s}|${a.r}|${String(a.p ?? 0).padStart(6, '0')}`.localeCompare(
          `${b.s}|${b.r}|${String(b.p ?? 0).padStart(6, '0')}`,
        ),
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
        {selectedEvent && (
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
                    {lines.length === 0 && (
                      <p className="text-sm text-muted-foreground">{t('empty')}</p>
                    )}
                    <ul className="space-y-3 text-sm">
                      {sortedSeats.map((seat) => {
                        const pick = seatPicks.get(seat.i)!;
                        const allowed = seat.c ? allowedTariffs(map, seat.c, seat.f) : [];
                        const price = seat.c
                          ? (lookups.tariffs.get(pick.tariffId)?.prices[seat.c] ?? 0)
                          : 0;
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
                                      {tariff.name} ·{' '}
                                      {money(tariff.prices[seat.c!] ?? 0, map.currency)}
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

                {standing.length > 0 && (
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">{t('standing')}</CardTitle>
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
                                <div
                                  key={tariff.id}
                                  className="flex items-center justify-between gap-2 text-sm"
                                >
                                  <span>
                                    {tariff.name} ·{' '}
                                    {money(
                                      tariff.prices[section.priceCategoryId!] ?? 0,
                                      map.currency,
                                    )}
                                  </span>
                                  <span className="flex items-center gap-2">
                                    <Button
                                      size="icon"
                                      variant="outline"
                                      aria-label={t('decrease')}
                                      disabled={quantity <= 0}
                                      onClick={() =>
                                        void setGa(section.id, tariff.id, quantity - 1)
                                      }
                                    >
                                      <Minus />
                                    </Button>
                                    <span className="w-6 text-center tabular-nums">{quantity}</span>
                                    <Button
                                      size="icon"
                                      variant="outline"
                                      aria-label={t('increase')}
                                      disabled={remaining <= 0}
                                      onClick={() =>
                                        void setGa(section.id, tariff.id, quantity + 1)
                                      }
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
                )}

                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">{t('payment.title')}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-3 gap-2">
                      {(['CASH', 'CARD', 'COMPLIMENTARY'] as const)
                        .filter((p) => p !== 'COMPLIMENTARY' || permissions.complimentary)
                        .map((p) => (
                          <Button
                            key={p}
                            type="button"
                            variant={payment === p ? 'default' : 'outline'}
                            aria-pressed={payment === p}
                            onClick={() => setPayment(p)}
                          >
                            {t(`payment.${p}`)}
                          </Button>
                        ))}
                    </div>
                    {payment === 'COMPLIMENTARY' && (
                      <p className="text-xs text-muted-foreground">{t('complimentaryHint')}</p>
                    )}

                    {quote?.buyerDataRequired && (
                      <p className="text-sm text-amber-700">
                        {t('buyer.required', {
                          limit: money(quote.smallAmountInvoiceLimit, quote.currency),
                        })}
                      </p>
                    )}
                    <button
                      type="button"
                      className="text-sm text-primary underline-offset-2 hover:underline"
                      onClick={() => setShowBuyer((v) => !v)}
                    >
                      {showBuyer || buyerDataMissing ? t('buyer.hide') : t('buyer.show')}
                    </button>
                    {(showBuyer || buyerDataMissing) && (
                      <div className="space-y-2" onChange={fe.onFormChange}>
                        <div className="grid grid-cols-2 gap-2">
                          {(['firstName', 'lastName'] as const).map((k) => (
                            <div key={k} className="space-y-1">
                              <Label htmlFor={`bo-${k}`}>{t(`buyer.${k}`)}</Label>
                              <Input
                                id={`bo-${k}`}
                                aria-invalid={fe.invalid(`bo-${k}`)}
                                value={buyer[k]}
                                maxLength={100}
                                onChange={(e) => setBuyer((b) => ({ ...b, [k]: e.target.value }))}
                              />
                              <FieldMessage message={fe.message(`bo-${k}`)} />
                            </div>
                          ))}
                        </div>
                        {(['email', 'phone', 'company'] as const).map((k) => (
                          <div key={k} className="space-y-1">
                            <Label htmlFor={`bo-${k}`}>{t(`buyer.${k}`)}</Label>
                            <Input
                              id={`bo-${k}`}
                              aria-invalid={fe.invalid(`bo-${k}`)}
                              type={k === 'email' ? 'email' : 'text'}
                              value={buyer[k]}
                              maxLength={k === 'email' ? 254 : 200}
                              onChange={(e) => setBuyer((b) => ({ ...b, [k]: e.target.value }))}
                            />
                            <FieldMessage message={fe.message(`bo-${k}`)} />
                          </div>
                        ))}
                        <div className="space-y-1">
                          <Label htmlFor="bo-language">{t('buyer.language')}</Label>
                          <select
                            id="bo-language"
                            aria-invalid={fe.invalid('bo-language')}
                            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20"
                            value={buyerLocale}
                            onChange={(e) => setBuyerLocale(e.target.value)}
                          >
                            {SUPPORTED_LOCALES.map((code) => (
                              <option key={code} value={code}>
                                {languageNames.of(code) ?? code}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="space-y-2 rounded-md border p-2">
                          <div className="text-sm font-medium">{t('buyer.address')}</div>
                          {(
                            [
                              ['street', tErrAddress('street')],
                              ['addressLine2', tErrAddress('line2')],
                            ] as const
                          ).map(([k, label]) => (
                            <div key={k} className="space-y-1">
                              <Label htmlFor={`bo-${k}`}>{label}</Label>
                              <Input
                                id={`bo-${k}`}
                                aria-invalid={fe.invalid(`bo-${k}`)}
                                value={buyer[k]}
                                maxLength={200}
                                onChange={(e) => setBuyer((b) => ({ ...b, [k]: e.target.value }))}
                              />
                              <FieldMessage message={fe.message(`bo-${k}`)} />
                            </div>
                          ))}
                          <div className="grid grid-cols-[1fr_2fr] gap-2">
                            {(
                              [
                                ['postalCode', tErrAddress('postalCode')],
                                ['city', tErrAddress('city')],
                              ] as const
                            ).map(([k, label]) => (
                              <div key={k} className="space-y-1">
                                <Label htmlFor={`bo-${k}`}>{label}</Label>
                                <Input
                                  id={`bo-${k}`}
                                  aria-invalid={fe.invalid(`bo-${k}`)}
                                  value={buyer[k]}
                                  maxLength={k === 'postalCode' ? 20 : 120}
                                  onChange={(e) => setBuyer((b) => ({ ...b, [k]: e.target.value }))}
                                />
                                <FieldMessage message={fe.message(`bo-${k}`)} />
                              </div>
                            ))}
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor="bo-country">{tErrAddress('country')}</Label>
                            <select
                              id="bo-country"
                              aria-invalid={fe.invalid('bo-country')}
                              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20"
                              value={buyer.country}
                              onChange={(e) => setBuyer((b) => ({ ...b, country: e.target.value }))}
                            >
                              {COUNTRIES.map((code) => (
                                <option key={code} value={code}>
                                  {regionNames.of(code) ?? code}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="bo-note">{t('buyer.note')}</Label>
                          <Textarea
                            id="bo-note"
                            aria-invalid={fe.invalid('bo-note')}
                            rows={2}
                            maxLength={1000}
                            value={buyer.note}
                            onChange={(e) => setBuyer((b) => ({ ...b, note: e.target.value }))}
                          />
                        </div>
                      </div>
                    )}
                    <label className="flex items-start gap-2 text-sm">
                      <Checkbox
                        checked={sendEmail && emailGiven}
                        disabled={!emailGiven}
                        onCheckedChange={(v) => setSendEmail(v === true)}
                        className="mt-0.5"
                      />
                      <span>
                        {t('sendEmail')}
                        {!emailGiven && (
                          <span className="block text-xs text-muted-foreground">
                            {t('sendEmailNeedsAddress')}
                          </span>
                        )}
                      </span>
                    </label>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="space-y-3 pt-6">
                    {quoteError && <p className="text-sm text-destructive">{quoteError}</p>}
                    {quote && (
                      <dl className="space-y-1 text-sm">
                        <Row
                          label={t('totals.subtotal')}
                          value={money(quote.subtotalGross, quote.currency)}
                        />
                        {quote.discountTotal > 0 && (
                          <Row
                            label={t('totals.discount')}
                            value={`−${money(quote.discountTotal, quote.currency)}`}
                          />
                        )}
                        {quote.fees.map((fee, i) => (
                          <Row
                            key={i}
                            label={fee.name}
                            value={money(fee.totalGross, quote.currency)}
                          />
                        ))}
                        <div className="flex justify-between border-t pt-1 text-base font-semibold">
                          <dt>{t('totals.total')}</dt>
                          <dd className="tabular-nums">
                            {money(quote.totalGross, quote.currency)}
                          </dd>
                        </div>
                      </dl>
                    )}
                    {!quote && !quoteError && quoteBusy && (
                      <p className="text-sm text-muted-foreground">{t('totals.calculating')}</p>
                    )}
                    {payment === 'CASH' && quote && quote.totalGross > 0 && (
                      <div className="space-y-1.5">
                        <Label htmlFor="bo-given">{t('cash.given')}</Label>
                        <Input
                          id="bo-given"
                          inputMode="decimal"
                          value={given}
                          onChange={(e) => setGiven(e.target.value)}
                        />
                        {givenCents !== null && (
                          <p
                            className={`text-sm font-medium tabular-nums ${givenCents < quote.totalGross ? 'text-destructive' : ''}`}
                          >
                            {givenCents >= quote.totalGross
                              ? `${t('cash.change')}: ${money(givenCents - quote.totalGross, quote.currency)}`
                              : `${t('cash.missing')}: ${money(quote.totalGross - givenCents, quote.currency)}`}
                          </p>
                        )}
                      </div>
                    )}
                    {lines.length > 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="w-full"
                        disabled={selling}
                        onClick={clearSelection}
                      >
                        <X /> {t('clearSelection')}
                      </Button>
                    )}
                    <Button
                      className="w-full"
                      size="lg"
                      disabled={
                        selling ||
                        lines.length === 0 ||
                        !quote ||
                        buyerDataMissing ||
                        (hasOverride && reason.trim() === '')
                      }
                      onClick={() => void sell()}
                    >
                      {selling ? (
                        <>
                          <Loader2 className="animate-spin" /> {t('selling')}
                        </>
                      ) : (
                        <>
                          {t('sellCount', { count: ticketCount })} · {tMethod(payment)}
                        </>
                      )}
                    </Button>
                  </CardContent>
                </Card>
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function SaleSuccess({
  sale,
  invoiceId,
  invoiceGaveUp,
  canOpenOrders,
  onNext,
}: {
  sale: SaleResult;
  invoiceId: string | null;
  invoiceGaveUp: boolean;
  canOpenOrders: boolean;
  onNext: () => void;
}) {
  const t = useTranslations('orders.boxOffice.success');
  const money = useMoney();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base text-green-700">
          <Check className="size-5" /> {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-sm">
          <div className="font-medium">{t('order', { number: sale.orderNumber })}</div>
          <div>
            {t('total', { amount: money(sale.totalGross, sale.currency) })} ·{' '}
            {t('tickets', { count: sale.ticketCount })}
          </div>
          {sale.email && (
            <div className="text-muted-foreground">{t('emailQueued', { email: sale.email })}</div>
          )}
        </div>
        {!sale.ticketsReady && <p className="text-sm text-amber-700">{t('ticketsNotReady')}</p>}
        <Button asChild className="w-full" size="lg">
          <a
            href={`/api/admin/box-office/orders/${sale.orderId}/tickets`}
            target="_blank"
            rel="noopener"
          >
            <Printer /> {t('print')}
          </a>
        </Button>
        {sale.payment !== 'COMPLIMENTARY' &&
          (invoiceId ? (
            <Button asChild variant="outline" className="w-full">
              <a
                href={`/api/admin/box-office/orders/${sale.orderId}/invoice`}
                target="_blank"
                rel="noopener"
              >
                {t('invoice')}
              </a>
            </Button>
          ) : (
            !invoiceGaveUp && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> {t('invoicePending')}
              </p>
            )
          ))}
        <Button variant="secondary" className="w-full" onClick={onNext}>
          {t('nextSale')}
        </Button>
        {canOpenOrders && (
          <Link
            href={`/admin/orders/${sale.orderId}`}
            className="block text-center text-sm text-primary hover:underline"
          >
            {t('orderDetail')}
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

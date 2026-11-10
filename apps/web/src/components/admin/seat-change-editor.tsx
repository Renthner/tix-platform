'use client';

import {
  SEAT_FLAG,
  type EventAvailability,
  type PublicSeat,
  type PublicSeatMap,
  type SeatDeltaMessage,
} from '@tix/shared';
import { Check, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  SeatChart,
  type SeatColors,
  type SeatStatus,
} from '@/components/shop/seat-chart/seat-chart';
import { SeatStateLegend, SeatSwatch } from '@/components/shop/seat-chart/seat-legend';
import { useRouter } from '@/i18n/navigation';
import { apiFetch, errorMessage } from '@/lib/api';
import { formatCountdown, useMoney } from '@/lib/format';
import {
  readHoldSnapshot,
  remountedInDocument,
  resolveHoldTabId,
  writeHoldSnapshot,
} from '@/lib/hold-session';
import { onRealtime, subscribeRoom } from '@/lib/realtime';

interface ChangeItem {
  id: string;
  seatId: string;
  sectionLabel: string;
  rowLabel: string | null;
  seatLabel: string | null;
  categoryName: string;
  ticketTypeName: string;
  ticketTypeId: string;
  priceCategoryId: string;
  priceGross: number;
  status: 'PENDING' | 'CONFIRMED';
}

interface SeatChangeData {
  map: PublicSeatMap;
  availability: EventAvailability;
  items: ChangeItem[];
  version: number;
  status: string;
  currency: string;
  complimentary: boolean;
  hasEmail: boolean;
  canBlocked: boolean;
}

interface Inventory {
  taken: Set<string>;
  locked: Set<string>;
  version: number;
}

type PriceCheck =
  | { ok: true }
  | { ok: false; reason: 'PRICE'; expected: number }
  | { ok: false; reason: 'TARIFF' | 'BLOCKED' };

export function SeatChangeEditor({
  orderId,
  eventId,
  colors,
}: {
  orderId: string;
  eventId: string;
  colors: SeatColors;
}) {
  const t = useTranslations('orders.admin.seatChange');
  const tErr = useTranslations('common.errors');
  const formatMoney = useMoney();
  const router = useRouter();
  const money = (cents: number) => formatMoney(cents, data?.currency ?? 'EUR');

  const [data, setData] = useState<SeatChangeData | null>(null);
  const [inv, setInv] = useState<Inventory>({ taken: new Set(), locked: new Set(), version: 0 });
  const [statusVersion, setStatusVersion] = useState(0);
  /** itemId → new seat id. */
  const [assigned, setAssigned] = useState<Map<string, string>>(new Map());
  const [activeId, setActiveId] = useState<string | null>(null);
  /** Seats this tab holds with a real lock (swap targets are not held). */
  const [held, setHeld] = useState<Set<string>>(new Set());
  const [holdExpiresAt, setHoldExpiresAt] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  /** Lock session of this browser tab and order: stable across navigation / reload. */
  const scope = `seatchange:${orderId}:${eventId}`;
  const [tabId, setTabId] = useState<string | null>(null);
  const tabIdRef = useRef<string | null>(null);
  const restored = useRef(false);
  const [notify, setNotify] = useState(true);
  const [reason, setReason] = useState('');
  const [allowBlocked, setAllowBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(new Set<string>());

  const invRef = useRef(inv);
  invRef.current = inv;
  const assignedRef = useRef(assigned);
  assignedRef.current = assigned;
  const heldRef = useRef(held);
  heldRef.current = held;

  const showError = useCallback((err: unknown) => toast.error(errorMessage(tErr, err)), [tErr]);

  const load = useCallback(async () => {
    const result = await apiFetch<SeatChangeData>(
      `/api/admin/orders/${orderId}/seat-change?eventId=${eventId}`,
    );
    setData(result);
    setInv({
      taken: new Set(result.availability.taken),
      locked: new Set(result.availability.locked),
      version: result.availability.version,
    });
    setStatusVersion((v) => v + 1);
    return result;
  }, [orderId, eventId]);

  const hold = useCallback(
    (body: Record<string, unknown>) =>
      apiFetch<{ expiresAt?: number | null }>('/api/admin/box-office/hold', {
        method: 'POST',
        json: { tabId: tabIdRef.current, eventId, ...body },
      }),
    [eventId],
  );

  useEffect(() => {
    let cancelled = false;
    void resolveHoldTabId(scope).then((id) => {
      if (cancelled) return;
      tabIdRef.current = id;
      setTabId(id);
    });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  useEffect(() => {
    load()
      .then((result) => setActiveId(result.items[0]?.id ?? null))
      .catch(showError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // ── Live availability ─────────────────────────────────────────────────────
  useEffect(() => {
    const unsubscribe = subscribeRoom('seats', eventId);
    const off = onRealtime('seats:delta', (payload) => {
      const delta = payload as SeatDeltaMessage;
      if (delta.eventId !== eventId) return;
      if (delta.version !== undefined && delta.version !== invRef.current.version) {
        void load().catch(() => undefined);
        return;
      }
      setInv((prev) => {
        const next: Inventory = {
          ...prev,
          taken: new Set(prev.taken),
          locked: new Set(prev.locked),
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
        return next;
      });
      setStatusVersion((v) => v + 1);
    });
    return () => {
      off();
      unsubscribe();
    };
  }, [eventId, load]);

  // ── Lookups ───────────────────────────────────────────────────────────────
  const lookups = useMemo(() => {
    if (!data) return null;
    const map = data.map;
    return {
      sections: new Map(map.sections.map((s) => [s.id, s])),
      rows: new Map(map.rows.map((r) => [r.id, r])),
      seats: new Map(map.seats.map((s) => [s.i, s])),
      tariffs: new Map(map.ticketTypes.map((x) => [x.id, x])),
      itemBySeat: new Map(data.items.map((i) => [i.seatId, i])),
    };
  }, [data]);

  const placeText = useCallback(
    (seat: PublicSeat) => {
      if (!lookups) return '';
      const section = lookups.sections.get(seat.s);
      const row = seat.r ? lookups.rows.get(seat.r) : undefined;
      const name = section?.ticketLabel || section?.name || '';
      return row
        ? t('place', { section: name, row: row.label, seat: seat.l })
        : t('placeNoRow', { section: name, seat: seat.l });
    },
    [lookups, t],
  );
  const itemPlace = (item: ChangeItem) =>
    item.rowLabel
      ? t('place', {
          section: item.sectionLabel,
          row: item.rowLabel,
          seat: item.seatLabel ?? '–',
        })
      : t('placeNoRow', { section: item.sectionLabel, seat: item.seatLabel ?? '–' });

  const check = useCallback(
    (item: ChangeItem, seat: PublicSeat): PriceCheck => {
      if (!data || !lookups) return { ok: false, reason: 'TARIFF' };
      const tariff = lookups.tariffs.get(item.ticketTypeId);
      if (!seat.c || !tariff || tariff.prices[seat.c] === undefined) {
        return { ok: false, reason: 'TARIFF' };
      }
      if (
        tariff.requiredSeatFeature === 'WHEELCHAIR_SPACE' &&
        (seat.f & SEAT_FLAG.WHEELCHAIR) === 0
      )
        return { ok: false, reason: 'TARIFF' };
      if (tariff.requiredSeatFeature === 'COMPANION_SEAT' && (seat.f & SEAT_FLAG.COMPANION) === 0)
        return { ok: false, reason: 'TARIFF' };
      const expected = data.complimentary ? 0 : tariff.prices[seat.c]!;
      // Same category keeps the price paid; another category needs the same current price.
      return item.priceCategoryId === seat.c || expected === item.priceGross
        ? { ok: true }
        : { ok: false, reason: 'PRICE', expected };
    },
    [data, lookups],
  );

  const status = useCallback(
    (seatId: string): SeatStatus => {
      const assignedSeats = new Set(assignedRef.current.values());
      if (assignedSeats.has(seatId)) return 'changeNew';
      // The order's own seats stay clickable as swap targets.
      const own = lookups?.itemBySeat.get(seatId);
      if (own) return assignedRef.current.has(own.id) ? 'changeReplaced' : 'changeCurrent';
      if (invRef.current.taken.has(seatId)) return 'taken';
      if (invRef.current.locked.has(seatId) && !heldRef.current.has(seatId)) return 'locked';
      return 'free';
    },
    // statusVersion forces a new function identity → the seat layer re-renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [statusVersion, lookups],
  );

  const releaseHeld = useCallback(
    (seatId: string) => {
      if (!heldRef.current.has(seatId)) return;
      setHeld((prev) => {
        const next = new Set(prev);
        next.delete(seatId);
        return next;
      });
      void hold({ op: 'remove', seatIds: [seatId] }).catch(() => undefined);
    },
    [hold],
  );

  const unassign = useCallback(
    (itemId: string) => {
      const seatId = assignedRef.current.get(itemId);
      if (!seatId) return;
      setAssigned((prev) => {
        const next = new Map(prev);
        next.delete(itemId);
        return next;
      });
      releaseHeld(seatId);
      setStatusVersion((v) => v + 1);
    },
    [releaseHeld],
  );

  const nextOpenItem = (after: ChangeItem[], assignedNow: Map<string, string>, skip: string) =>
    after.find((i) => i.id !== skip && !assignedNow.has(i.id))?.id ?? null;

  const onSeatClick = useCallback(
    async (seat: PublicSeat) => {
      if (!data || !lookups || !seat.c) return;
      const blocked = (seat.f & SEAT_FLAG.BLOCKED) !== 0;
      if (blocked && !allowBlocked) return;
      if (pending.current.has(seat.i)) return;
      const active = data.items.find((i) => i.id === activeId);
      if (!active) return;

      // Click on a seat that is already the target of the active item → undo.
      if (assignedRef.current.get(active.id) === seat.i) {
        unassign(active.id);
        return;
      }
      const ownItem = lookups.itemBySeat.get(seat.i);
      if (ownItem) {
        // Swap with another ticket of this order.
        if (ownItem.id === active.id) return;
        const next = new Map(assignedRef.current);
        for (const id of [active.id, ownItem.id]) {
          const old = next.get(id);
          if (old) releaseHeld(old);
          next.delete(id);
        }
        next.set(active.id, ownItem.seatId);
        // The other ticket takes the seat of the active one unless it was assigned elsewhere.
        next.set(ownItem.id, active.seatId);
        setAssigned(next);
        setStatusVersion((v) => v + 1);
        setActiveId(nextOpenItem(data.items, next, active.id));
        return;
      }
      if (
        !blocked &&
        (invRef.current.taken.has(seat.i) ||
          (invRef.current.locked.has(seat.i) && !heldRef.current.has(seat.i)))
      )
        return;
      if (blocked && invRef.current.taken.has(seat.i)) return;
      // A seat that is already the target of another ticket is not offered twice.
      if ([...assignedRef.current.values()].includes(seat.i)) return;

      pending.current.add(seat.i);
      try {
        if (!blocked) {
          const result = await hold({ op: 'add', seatIds: [seat.i] });
          if (result.expiresAt) setHoldExpiresAt(result.expiresAt);
          setHeld((prev) => new Set(prev).add(seat.i));
        }
        const next = new Map(assignedRef.current);
        const old = next.get(active.id);
        if (old) releaseHeld(old);
        next.set(active.id, seat.i);
        setAssigned(next);
        setStatusVersion((v) => v + 1);
        setActiveId(nextOpenItem(data.items, next, active.id) ?? active.id);
      } catch (err) {
        showError(err);
      } finally {
        pending.current.delete(seat.i);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, lookups, activeId, allowBlocked, hold, showError, unassign, releaseHeld],
  );

  // Restore the assignments and the countdown after navigating away and back: the server knows
  // which seats this tab still holds, the snapshot which ticket each seat was chosen for.
  useEffect(() => {
    if (!tabId || !data || !lookups || restored.current) return;
    restored.current = true;
    const snapshot = readHoldSnapshot<{ assigned: [string, string][]; allowBlocked: boolean }>(
      scope,
    );
    const again = remountedInDocument(scope);
    if (!snapshot || snapshot.assigned.length === 0) return;
    if (!again) {
      // Fresh document (reload / first visit): release what the previous document held (its
      // pagehide request may not have arrived yet) and start clean.
      writeHoldSnapshot(scope, null);
      void hold({ op: 'release' }).catch(() => undefined);
      return;
    }
    apiFetch<{ seatIds: string[]; expiresAt: number | null }>(
      `/api/admin/box-office/hold?eventId=${eventId}&tabId=${tabId}`,
    )
      .then((state) => {
        const heldNow = new Set(state.seatIds);
        const keep = new Map<string, string>();
        const heldTargets = new Set<string>();
        for (const [itemId, seatId] of snapshot.assigned) {
          if (!data.items.some((i) => i.id === itemId)) continue;
          const seat = lookups.seats.get(seatId);
          if (!seat) continue;
          const blocked = (seat.f & SEAT_FLAG.BLOCKED) !== 0;
          if (heldNow.has(seatId)) {
            keep.set(itemId, seatId);
            heldTargets.add(seatId);
          } else if (lookups.itemBySeat.has(seatId) || (blocked && snapshot.allowBlocked)) {
            keep.set(itemId, seatId); // swap with a ticket of this order / blocked seat: no lock
          }
        }
        if (snapshot.allowBlocked) setAllowBlocked(true);
        setAssigned(keep);
        setHeld(heldTargets);
        setHoldExpiresAt(heldTargets.size > 0 ? state.expiresAt : null);
        setStatusVersion((v) => v + 1);
        setActiveId(nextOpenItem(data.items, keep, ''));
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, data, lookups]);

  useEffect(() => {
    if (!restored.current && assigned.size === 0) return; // do not erase before restoring
    writeHoldSnapshot(scope, assigned.size > 0 ? { assigned: [...assigned], allowBlocked } : null);
  }, [scope, assigned, allowBlocked]);

  // Un-ticking "allow blocked" drops blocked targets.
  useEffect(() => {
    if (allowBlocked || !lookups) return;
    setAssigned((prev) => {
      const keep = [...prev].filter(
        ([, seatId]) => ((lookups.seats.get(seatId)?.f ?? 0) & SEAT_FLAG.BLOCKED) === 0,
      );
      if (keep.length === prev.size) return prev;
      setStatusVersion((v) => v + 1);
      return new Map(keep);
    });
  }, [allowBlocked, lookups]);

  // ── Hold countdown / expiry / release on leaving ─────────────────────────
  useEffect(() => {
    if (!holdExpiresAt) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [holdExpiresAt]);
  useEffect(() => {
    if (!holdExpiresAt || clock < holdExpiresAt) return;
    setHoldExpiresAt(null);
    // Targets that needed a lock are gone; swaps and blocked seats need none.
    setAssigned((prev) => new Map([...prev].filter(([, seatId]) => !heldRef.current.has(seatId))));
    setHeld(new Set());
    setStatusVersion((v) => v + 1);
    toast.warning(t('holdExpired'));
    void load().catch(() => undefined);
  }, [clock, holdExpiresAt, load, t]);
  // Leaving the page releases the hold so the picked seats do not stay "in a cart": tab close /
  // reload / navigation to another document (pagehide, also fired when the page enters the
  // back/forward cache) and client-side navigation (unmount). A page restored from the bfcache
  // starts clean again, because its hold is gone.
  useEffect(() => {
    if (!tabId) return;
    const release = () => {
      writeHoldSnapshot(scope, null);
      void fetch('/api/admin/box-office/hold', {
        method: 'POST',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'release', eventId, tabId }),
      }).catch(() => undefined);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setAssigned(new Map());
      setHeld(new Set());
      setHoldExpiresAt(null);
      setStatusVersion((v) => v + 1);
      void load().catch(() => undefined);
    };
    window.addEventListener('pagehide', release);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pagehide', release);
      window.removeEventListener('pageshow', onPageShow);
      if (heldRef.current.size > 0 || assignedRef.current.size > 0) release();
    };
  }, [eventId, tabId, scope, load]);

  // ── Confirm ──────────────────────────────────────────────────────────────
  const rows = useMemo(() => {
    if (!data || !lookups) return [];
    return data.items.map((item) => {
      const seatId = assigned.get(item.id);
      const seat = seatId ? lookups.seats.get(seatId) : undefined;
      return { item, seat, result: seat ? check(item, seat) : null };
    });
  }, [data, lookups, assigned, check]);
  const changed = rows.filter((r) => r.seat);
  const allOk = changed.length > 0 && changed.every((r) => r.result?.ok);
  const confirmed = data?.status === 'PAID' || data?.status === 'PARTIALLY_REFUNDED';

  const submit = async () => {
    if (!data || !allOk || busy) return;
    setBusy(true);
    try {
      const result = await apiFetch<{ reissuedTickets: number; emailQueued: boolean }>(
        `/api/admin/orders/${orderId}/seat-change`,
        {
          method: 'POST',
          json: {
            tabId: tabIdRef.current,
            changes: changed.map((r) => ({ orderItemId: r.item.id, newSeatId: r.seat!.i })),
            notify: notify && data.hasEmail && confirmed,
            reason: reason.trim() || undefined,
            allowBlocked,
            expectedVersion: data.version,
          },
        },
      );
      toast.success(
        result.emailQueued
          ? t('doneMail', { count: result.reissuedTickets })
          : t('done', { count: result.reissuedTickets }),
      );
      writeHoldSnapshot(scope, null);
      router.push(`/admin/orders/${orderId}`);
      router.refresh();
    } catch (err) {
      showError(err);
      void load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  if (!data || !lookups) {
    return (
      <div className="flex h-48 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> {t('loading')}
      </div>
    );
  }
  if (data.items.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('noItems')}</p>;
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('howTo')}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {(
            [
              ['legend.current', 'changeCurrent'],
              ['legend.replaced', 'changeReplaced'],
              ['legend.new', 'changeNew'],
            ] as const
          ).map(([key, kind]) => (
            <span key={key} className="flex items-center gap-1.5">
              <SeatSwatch map={data.map} colors={colors} kind={kind} sellBlocked={allowBlocked} />
              {t(key)}
            </span>
          ))}
          <SeatStateLegend
            map={data.map}
            colors={colors}
            sellBlocked={allowBlocked}
            className="flex items-center gap-1.5 text-muted-foreground"
          />
        </div>
        <SeatChart
          map={data.map}
          colors={colors}
          status={status}
          statusVersion={statusVersion}
          gaRemaining={data.availability.ga}
          gaMine={{}}
          highlighted={new Set()}
          interactive
          onSeatClick={(seat) => void onSeatClick(seat)}
          onSectionClick={() => undefined}
          seatTitle={placeText}
          sellBlocked={allowBlocked}
        />
      </div>
      <aside className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-base">
              {t('tickets')}
              {holdExpiresAt && (
                <span className="text-xs font-normal text-muted-foreground tabular-nums">
                  {t('holdCountdown', {
                    time: formatCountdown(Math.max(0, holdExpiresAt - clock)),
                  })}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {rows.map(({ item, seat, result }) => (
              <div
                key={item.id}
                className={`rounded-md border p-2 text-sm ${
                  activeId === item.id ? 'border-primary ring-1 ring-primary' : ''
                }`}
              >
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => setActiveId(item.id)}
                >
                  <div className="font-medium">{itemPlace(item)}</div>
                  <div className="text-xs text-muted-foreground">
                    {item.categoryName} · {item.ticketTypeName} · {money(item.priceGross)}
                  </div>
                </button>
                {seat ? (
                  <div className="mt-2 space-y-1 border-t pt-2">
                    <div>
                      {t('newSeat')}: <span className="font-medium">{placeText(seat)}</span>
                    </div>
                    {result?.ok ? (
                      <div className="flex items-center gap-1 text-xs text-green-700">
                        <Check className="size-3" /> {t('priceOk')}
                      </div>
                    ) : result?.reason === 'PRICE' ? (
                      <div className="text-xs text-destructive">
                        {t('priceDiffers', {
                          expected: money(result.expected),
                          current: money(item.priceGross),
                        })}
                      </div>
                    ) : (
                      <div className="text-xs text-destructive">{t('tariffNotAllowed')}</div>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      onClick={() => unassign(item.id)}
                    >
                      {t('undo')}
                    </Button>
                  </div>
                ) : (
                  <div className="mt-1 text-xs text-muted-foreground">{t('noNewSeat')}</div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 pt-6">
            {data.canBlocked && (
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
            <div className="space-y-1.5">
              <Label htmlFor="seat-change-reason">{t('reason')}</Label>
              <Textarea
                id="seat-change-reason"
                rows={2}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            {confirmed ? (
              <div className="space-y-1">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={notify && data.hasEmail}
                    disabled={!data.hasEmail}
                    onCheckedChange={(v) => setNotify(v === true)}
                  />
                  {t('notify')}
                </label>
                {!data.hasEmail && <p className="text-xs text-muted-foreground">{t('noEmail')}</p>}
                <p className="text-xs text-muted-foreground">{t('walletNote')}</p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t('unpaidNote')}</p>
            )}
            <Button type="button" disabled={!allOk || busy} onClick={() => void submit()}>
              {busy && <Loader2 className="animate-spin" />}{' '}
              {t('confirm', { count: changed.length })}
            </Button>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

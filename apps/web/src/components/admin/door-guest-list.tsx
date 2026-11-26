'use client';

import type { DoorGuest } from '@tix/core';
import { LogIn, LogOut, X } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { uid } from '@/components/seatmap-editor/doc-ops';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { doorCheckAction, type DoorActionState } from '@/server/admin/door';

const COLOR_CLASS = {
  GREEN: 'border-success-border bg-success-soft text-success',
  YELLOW: 'border-warning-border bg-warning-soft text-warning',
  RED: 'border-destructive/40 bg-destructive/10 text-destructive',
} as const;

/** Guest list with big check-in / check-out buttons (phone / tablet friendly). */
export function DoorGuestList({ guests, eventId }: { guests: DoorGuest[]; eventId: string }) {
  const t = useTranslations('scanners.door');
  const tResults = useTranslations('scanners.checkIn.results');
  const tWarnings = useTranslations('scanners.checkIn.warnings');
  const format = useFormatter();
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [last, setLast] = useState<DoorActionState | null>(null);
  const [, startTransition] = useTransition();
  // One scan id per intended action: a double click (fired before the button is disabled) or a
  // repeated request reuses the id while it is in flight, so the server records ONE scan and
  // returns its outcome again instead of a RED "already checked in".
  const inFlight = useRef(new Map<string, string>());

  const act = (guest: DoorGuest, action: 'CHECK_IN' | 'CHECK_OUT') => {
    const key = `${guest.id}:${action}`;
    let clientScanId = inFlight.current.get(key);
    if (!clientScanId) {
      // `uid` falls back to getRandomValues on plain-HTTP LAN access (no crypto.randomUUID).
      clientScanId = uid();
      inFlight.current.set(key, clientScanId);
    }
    const scanId = clientScanId;
    setPendingId(guest.id);
    startTransition(async () => {
      // The id is dropped only on a definitive answer (outcome or domain error). A network
      // failure or an internal error may or may not have recorded the scan: a manual retry then
      // reuses the id and the server returns the first outcome instead of a second scan.
      let definitive = false;
      try {
        const state = await doorCheckAction(eventId, guest.id, action, scanId);
        definitive = state.status === 'ok' || state.code !== 'INTERNAL_ERROR';
        setLast(state);
      } finally {
        if (definitive) {
          if (inFlight.current.get(key) === scanId) inFlight.current.delete(key);
          // A kept id of the opposite action (earlier network failure) must not replay an old
          // outcome once the guest's state moved on.
          const opposite = `${guest.id}:${action === 'CHECK_IN' ? 'CHECK_OUT' : 'CHECK_IN'}`;
          inFlight.current.delete(opposite);
        }
        setPendingId(null);
        router.refresh();
      }
    });
  };

  const seat = (g: DoorGuest) =>
    [
      g.sectionLabel,
      g.rowLabel && `${t('row')} ${g.rowLabel}`,
      g.seatLabel && `${t('seat')} ${g.seatLabel}`,
    ]
      .filter(Boolean)
      .join(' · ');
  const time = (d: Date) => format.dateTime(d, { timeStyle: 'short', dateStyle: 'short' });

  const bannerContent = () => {
    if (!last) return null;
    if (last.status === 'error') {
      return (
        <Alert variant="destructive" role="alert" data-testid="door-result" className="pr-12">
          <AlertDescription>
            {t(
              `errors.${last.code === 'INVALID' || last.code === 'EVENT_NOT_ASSIGNED' ? last.code : 'INTERNAL_ERROR'}`,
            )}
          </AlertDescription>
        </Alert>
      );
    }
    const { outcome } = last;
    const name = outcome.ticket?.attendeeName ?? outcome.ticket?.ticketCode ?? '';
    return (
      <div
        role="status"
        data-testid="door-result"
        data-color={outcome.color}
        className={cn('rounded-md border p-3 pr-12 text-sm', COLOR_CLASS[outcome.color])}
      >
        <p className="text-base font-semibold">{tResults(outcome.result)}</p>
        {name && <p>{name}</p>}
        {outcome.warnings.map((w) => (
          <p key={w}>
            {w === 'DISCOUNT_PROOF_REQUIRED' && outcome.warningTexts[w]
              ? outcome.warningTexts[w]
              : tWarnings(w)}
          </p>
        ))}
        {outcome.result === 'REJECTED_ALREADY_CHECKED_IN' && outcome.firstScan && (
          <p>
            {t('firstScan', {
              time: time(new Date(outcome.firstScan.at)),
              device: outcome.firstScan.deviceName ?? '–',
            })}
          </p>
        )}
      </div>
    );
  };

  const banner = bannerContent();
  const accent = (g: DoorGuest) => {
    if (g.status !== 'VALID') return 'border-l-destructive';
    if (g.checkInState === 'CHECKED_IN') return 'border-l-success';
    if (g.checkInState === 'CHECKED_OUT') return 'border-l-warning';
    return 'border-l-muted-foreground/30';
  };

  return (
    <div className="space-y-3">
      {banner && (
        <div className="sticky top-2 z-20 rounded-md bg-background shadow-md">
          {banner}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute top-2 right-2"
            onClick={() => setLast(null)}
            aria-label={t('dismiss')}
          >
            <X />
          </Button>
        </div>
      )}
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {guests.map((g) => {
          const valid = g.status === 'VALID';
          const busy = pendingId === g.id;
          const seatText = seat(g);
          const tier = [g.categoryName, g.ticketTypeName].filter(Boolean).join(' · ');
          return (
            <li key={g.id} className="min-w-0">
              <Card className={cn('h-full gap-3 border-l-4 p-4', accent(g))}>
                <div className="min-w-0 space-y-1">
                  <div className="text-lg leading-tight font-semibold break-words">
                    {g.attendeeName ?? g.buyerName}
                  </div>
                  {seatText && (
                    <div className="text-base font-medium break-words tabular-nums">{seatText}</div>
                  )}
                  {tier && <div className="text-sm text-muted-foreground">{tier}</div>}
                  <div className="font-mono text-xs break-all text-muted-foreground">
                    {g.orderNumber} · {g.ticketCode}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {!valid && <Badge variant="destructive">{t(`ticketStatus.${g.status}`)}</Badge>}
                  {valid && g.checkInState === 'NONE' && (
                    <Badge variant="outline">{t('state.NONE')}</Badge>
                  )}
                  {valid && g.checkInState === 'CHECKED_IN' && (
                    <Badge>
                      {t('state.CHECKED_IN')}
                      {g.firstCheckedInAt ? ` · ${time(g.firstCheckedInAt)}` : ''}
                    </Badge>
                  )}
                  {valid && g.checkInState === 'CHECKED_OUT' && (
                    <Badge variant="secondary">{t('state.CHECKED_OUT')}</Badge>
                  )}
                  {valid && g.requiresProof && (
                    <Badge
                      variant="outline"
                      className="border-warning-border whitespace-normal text-warning"
                    >
                      {g.scannerWarning ?? tWarnings('DISCOUNT_PROOF_REQUIRED')}
                    </Badge>
                  )}
                  {valid && g.additionalPaymentOpen && (
                    <Badge variant="outline" className="border-warning-border text-warning">
                      {tWarnings('ADDITIONAL_PAYMENT_OPEN')}
                    </Badge>
                  )}
                </div>
                {valid && g.checkInState !== 'NONE' && g.firstCheckedInDeviceName && (
                  <div className="text-xs text-muted-foreground">
                    {t('firstEntry', { device: g.firstCheckedInDeviceName })}
                  </div>
                )}
                {valid && (
                  <div className="mt-auto pt-1">
                    {g.checkInState !== 'CHECKED_IN' && (
                      <Button
                        type="button"
                        size="lg"
                        className="min-h-11 w-full"
                        disabled={busy}
                        onClick={() => act(g, 'CHECK_IN')}
                        data-testid="door-check-in"
                      >
                        <LogIn /> {t('checkIn')}
                      </Button>
                    )}
                    {g.checkInState === 'CHECKED_IN' && (
                      <Button
                        type="button"
                        size="lg"
                        variant="outline"
                        className="min-h-11 w-full"
                        disabled={busy}
                        onClick={() => act(g, 'CHECK_OUT')}
                        data-testid="door-check-out"
                      >
                        <LogOut /> {t('checkOut')}
                      </Button>
                    )}
                  </div>
                )}
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

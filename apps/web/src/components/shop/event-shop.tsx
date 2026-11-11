'use client';

import { Clock, KeyRound, Loader2, Megaphone, Users } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { localized, type Translations } from '@tix/shared';
import { apiFetch, errorCode } from '@/lib/api';
import { formatCountdown } from '@/lib/format';
import { onRealtime, onResync, subscribeRoom } from '@/lib/realtime';
import type { PublicDecision } from '@/server/shop';
import type { SeatColors } from './seat-chart/seat-chart';
import { SeatSelection, type ShopConfig } from './seat-selection';

export interface Announcement {
  id: string;
  message: string;
  translations?: Translations;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  publishedAt: string;
}

export interface QueueInfo {
  title: string | null;
  message: string | null;
  admissionBatchSize: number;
  admissionIntervalSeconds: number;
}

interface Props {
  eventId: string;
  config: ShopConfig;
  seatColors: SeatColors;
  queue: QueueInfo;
  announcements: Announcement[];
  /** Shop default language (base language of announcement texts). */
  defaultLocale: string;
}

type QueueBroadcast =
  | { type: 'cursor'; eventId: string; cursor: number; waiting: number }
  | { type: 'state'; eventId: string; state: string }
  | ({ type: 'announcement'; eventId: string } & Announcement);

const POLL_MS = 20_000;

/** Entry point of an event shop: waiting room / code gate → seat selection. */
export function EventShop({
  eventId,
  config,
  seatColors,
  queue,
  announcements: initialAnnouncements,
  defaultLocale,
}: Props) {
  const locale = useLocale();
  const t = useTranslations('queue');
  const tErr = useTranslations('common.errors');
  const [decision, setDecision] = useState<PublicDecision | null>(null);
  const [announcements, setAnnouncements] = useState(initialAnnouncements);
  const claiming = useRef(false);

  const showError = useCallback(
    (err: unknown) => {
      const code = errorCode(err);
      toast.error(tErr.has(code as never) ? tErr(code as never) : tErr('INTERNAL_ERROR'));
    },
    [tErr],
  );

  const enter = useCallback(async () => {
    try {
      setDecision(
        await apiFetch<PublicDecision>(`/api/events/${eventId}/enter`, { method: 'POST' }),
      );
    } catch (err) {
      showError(err);
    }
  }, [eventId, showError]);

  const claim = useCallback(async () => {
    if (claiming.current) return;
    claiming.current = true;
    try {
      setDecision(
        await apiFetch<PublicDecision>(`/api/events/${eventId}/claim`, { method: 'POST' }),
      );
    } catch (err) {
      showError(err);
      void enter();
    } finally {
      claiming.current = false;
    }
  }, [enter, eventId, showError]);

  useEffect(() => {
    void enter();
  }, [enter]);

  // Live queue updates, admission notification and announcements.
  useEffect(() => {
    const unsubscribe = subscribeRoom('queue', eventId);
    const offQueue = onRealtime('queue:update', (payload) => {
      const message = payload as QueueBroadcast;
      if (message.eventId !== eventId) return;
      if (message.type === 'announcement') {
        setAnnouncements((list) =>
          [
            {
              id: message.id,
              message: message.message,
              translations: message.translations,
              severity: message.severity,
              publishedAt: message.publishedAt,
            },
            ...list.filter((a) => a.id !== message.id),
          ].slice(0, 5),
        );
      } else if (message.type === 'cursor') {
        setDecision((d) => {
          if (d?.status !== 'QUEUED') return d;
          const position = Math.max(1, d.number - message.cursor);
          return {
            ...d,
            position,
            waiting: message.waiting,
            estimatedWaitSeconds:
              Math.ceil(position / queue.admissionBatchSize) * queue.admissionIntervalSeconds,
          };
        });
      } else if (message.type === 'state' && message.state === 'DRAWN') {
        void enter();
      }
    });
    const offSession = onRealtime('session:message', (payload) => {
      const message = payload as { type: string; eventId: string };
      if (message.type === 'admitted' && message.eventId === eventId) void claim();
    });
    // After a reconnect queue updates were missed: ask for the current decision again.
    // Random delay: after maintenance everybody resyncs at once, spread the load.
    let resyncTimer: ReturnType<typeof setTimeout> | undefined;
    const offResync = onResync(() => {
      clearTimeout(resyncTimer);
      resyncTimer = setTimeout(() => void enter(), Math.random() * 5_000);
    });
    return () => {
      offQueue();
      offSession();
      offResync();
      clearTimeout(resyncTimer);
      unsubscribe();
    };
  }, [claim, enter, eventId, queue.admissionBatchSize, queue.admissionIntervalSeconds]);

  // Polling fallback while waiting (WebSocket blocked by proxies, sleeping tabs …).
  useEffect(() => {
    if (
      decision?.status !== 'QUEUED' &&
      decision?.status !== 'LOBBY' &&
      decision?.status !== 'ADMITTED'
    )
      return;
    const id = setInterval(async () => {
      try {
        const next = await apiFetch<PublicDecision>(`/api/events/${eventId}/queue`);
        if (next.status === 'ADMITTED') void claim();
        else setDecision(next);
      } catch {
        /* next poll retries */
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [claim, decision?.status, eventId]);

  const announcementList = announcements.length > 0 && (
    <div className="space-y-2">
      {announcements.map((a) => (
        <Alert key={a.id} variant={a.severity === 'INFO' ? 'default' : 'destructive'}>
          <Megaphone className="size-4" />
          <AlertDescription>
            {localized(a, 'message', locale, defaultLocale, a.message)}
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );

  if (!decision) {
    return (
      <div className="flex h-48 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> {t('checking')}
      </div>
    );
  }

  if (decision.status === 'GRANTED') {
    return (
      <div className="space-y-4">
        {announcementList}
        <SeatSelection
          eventId={eventId}
          config={config}
          colors={seatColors}
          onPassLost={() => {
            setDecision(null);
            void enter();
          }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      {announcementList}
      {decision.status === 'QUEUED' && <QueueCard decision={decision} queue={queue} />}
      {decision.status === 'ADMITTED' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('admitted.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Button className="w-full" onClick={claim}>
              {t('admitted.enter')}
            </Button>
          </CardContent>
        </Card>
      )}
      {decision.status === 'LOBBY' && (
        <CountdownCard
          title={queue.title ?? t('lobby.title')}
          description={queue.message ?? t('lobby.description')}
          target={decision.saleOpensAt}
          onElapsed={enter}
        />
      )}
      {decision.status === 'NOT_STARTED' && (
        <CountdownCard
          title={t('notStarted.title')}
          description={decision.lobbyOpensAt ? t('notStarted.lobby') : t('notStarted.description')}
          target={decision.lobbyOpensAt ?? decision.saleOpensAt}
          onElapsed={enter}
        />
      )}
      {decision.status === 'CODE_REQUIRED' && (
        <AccessCodeForm eventId={eventId} reason={decision.reason} onDecision={setDecision} />
      )}
      {decision.status === 'CLOSED' && (
        <Alert>
          <AlertTitle>{t(`closed.${decision.reason}`)}</AlertTitle>
        </Alert>
      )}
    </div>
  );
}

function QueueCard({
  decision,
  queue,
}: {
  decision: Extract<PublicDecision, { status: 'QUEUED' }>;
  queue: QueueInfo;
}) {
  const t = useTranslations('queue');
  const initial = useRef(decision.position);
  if (decision.position > initial.current) initial.current = decision.position;
  const progress = initial.current > 1 ? 1 - (decision.position - 1) / initial.current : 0.98;
  const minutes = Math.max(1, Math.round(decision.estimatedWaitSeconds / 60));
  return (
    <Card aria-live="polite">
      <CardHeader>
        <CardTitle>{queue.title ?? t('waiting.title')}</CardTitle>
        <CardDescription>{queue.message ?? t('waiting.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-4 text-center">
          <div className="rounded-lg bg-muted p-4">
            <Users className="mx-auto mb-1 size-5 text-muted-foreground" />
            <div className="text-3xl font-semibold tabular-nums">{decision.position}</div>
            <div className="text-xs text-muted-foreground">{t('waiting.position')}</div>
          </div>
          <div className="rounded-lg bg-muted p-4">
            <Clock className="mx-auto mb-1 size-5 text-muted-foreground" />
            <div className="text-3xl font-semibold tabular-nums">~{minutes}</div>
            <div className="text-xs text-muted-foreground">{t('waiting.minutes')}</div>
          </div>
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <div
            className="h-full rounded-full bg-primary transition-all duration-1000"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
        {decision.paused && <p className="text-sm text-amber-600">{t('waiting.paused')}</p>}
        <p className="text-xs text-muted-foreground">{t('waiting.keepOpen')}</p>
      </CardContent>
    </Card>
  );
}

function CountdownCard({
  title,
  description,
  target,
  onElapsed,
}: {
  title: string;
  description: string;
  target: string | null;
  onElapsed: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const fired = useRef(false);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = target ? new Date(target).getTime() - now : null;
  useEffect(() => {
    if (remaining !== null && remaining <= 0 && !fired.current) {
      fired.current = true;
      // Small random delay spreads the T-0 thundering herd.
      setTimeout(onElapsed, 500 + Math.random() * 2500);
    }
  }, [onElapsed, remaining]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {remaining !== null && (
        <CardContent>
          <div className="text-center text-4xl font-semibold tabular-nums">
            {formatCountdown(remaining)}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function AccessCodeForm({
  eventId,
  reason,
  onDecision,
}: {
  eventId: string;
  reason: 'PRESALE' | 'VIP_ONLY';
  onDecision: (decision: PublicDecision) => void;
}) {
  const t = useTranslations('queue.code');
  const tErr = useTranslations('common.errors');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      onDecision(
        await apiFetch<PublicDecision>(`/api/events/${eventId}/code`, {
          method: 'POST',
          json: { code },
        }),
      );
    } catch (err) {
      const c = errorCode(err);
      setError(tErr.has(c as never) ? tErr(c as never) : tErr('INTERNAL_ERROR'));
    } finally {
      setPending(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-5" /> {t(`title.${reason}`)}
        </CardTitle>
        <CardDescription>{t(`description.${reason}`)}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={t('placeholder')}
            autoComplete="off"
            aria-label={t('placeholder')}
            aria-invalid={!!error}
            required
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={pending || code.trim().length < 4}>
            {t('submit')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

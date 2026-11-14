'use client';

import { Smartphone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Field } from '../form-controls';
import { AssignmentPicker } from './assignment-picker';
import {
  adminRequest,
  useErrorMessage,
  type DeviceAssignmentValue,
  type ScannerEventOption,
} from './scanner-client';

interface CreatedCode {
  id: string;
  code: string;
  serverUrl: string;
  expiresAt: string;
  qrDataUrl: string;
}

type PairingStatus = { status: 'PENDING' | 'CONSUMED' | 'EXPIRED'; deviceName: string | null };

const POLL_MS = 2_000;

function remaining(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Creates a one-time pairing code, shows the QR code and waits until the device has paired. */
export function PairDeviceDialog({ events }: { events: ScannerEventOption[] }) {
  const t = useTranslations('scanners.pair');
  const te = useTranslations('scanners.errors');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [assignments, setAssignments] = useState<DeviceAssignmentValue[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedCode | null>(null);
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const message = useErrorMessage();

  const reset = useCallback(() => {
    setCreated(null);
    setStatus(null);
    setError(null);
  }, []);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      // An unused code is invalidated when the dialog is dismissed.
      if (created && status?.status !== 'CONSUMED') {
        void adminRequest(`/api/admin/scanners/pairing/${created.id}`, { method: 'DELETE' });
      }
      reset();
      router.refresh();
    }
  };

  useEffect(() => {
    if (!created || status?.status === 'CONSUMED') return;
    const timer = setInterval(async () => {
      setNow(Date.now());
      const result = await adminRequest<PairingStatus>(
        `/api/admin/scanners/pairing/${created.id}`,
        { method: 'GET' },
      );
      if (result.ok) setStatus(result.data);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [created, status?.status]);

  useEffect(() => {
    if (!created) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [created]);

  const create = async () => {
    if (assignments.length === 0) {
      setError(te('NO_EVENTS'));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await adminRequest<CreatedCode>('/api/admin/scanners/pairing', {
      method: 'POST',
      json: { label: label.trim() || undefined, assignments },
    });
    setBusy(false);
    if (!result.ok) {
      setError(message(result.code));
      return;
    }
    setCreated(result.data);
    setStatus({ status: 'PENDING', deviceName: null });
    setNow(Date.now());
  };

  const expired =
    created !== null &&
    status?.status !== 'CONSUMED' &&
    (status?.status === 'EXPIRED' || new Date(created.expiresAt).getTime() <= now);
  const paired = status?.status === 'CONSUMED';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button">
          <Smartphone /> {t('button')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {!created ? (
          <div className="space-y-4">
            <Field label={t('label')} htmlFor="pairLabel" hint={t('labelHint')}>
              <Input
                id="pairLabel"
                value={label}
                maxLength={80}
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
            <Field label={t('events')}>
              {events.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noEvents')}</p>
              ) : (
                <AssignmentPicker
                  idPrefix="pair"
                  options={events}
                  value={assignments}
                  onChange={setAssignments}
                />
              )}
            </Field>
            <DialogFooter>
              <Button type="button" disabled={busy || events.length === 0} onClick={create}>
                {busy ? t('creating') : t('create')}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4 text-center">
            {paired ? (
              <Alert>
                <AlertDescription className="text-base font-medium">
                  {t('paired', { name: status?.deviceName ?? '' })}
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">{t('scanHint')}</p>
                {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL */}
                <img
                  src={created.qrDataUrl}
                  alt=""
                  width={240}
                  height={240}
                  className={`mx-auto size-60 rounded-md border bg-paper ${expired ? 'opacity-30' : ''}`}
                />
                <div>
                  <div className="text-xs text-muted-foreground">{t('codeLabel')}</div>
                  <div className="font-mono text-2xl font-semibold tracking-widest">
                    {created.code}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('server', { url: created.serverUrl })}
                </p>
                <p className="text-sm">
                  {expired
                    ? t('expired')
                    : `${t('expiresIn', { time: remaining(created.expiresAt, now) })} · ${t('waiting')}`}
                </p>
              </>
            )}
            <DialogFooter>
              {!paired ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void adminRequest(`/api/admin/scanners/pairing/${created.id}`, {
                      method: 'DELETE',
                    });
                    reset();
                  }}
                >
                  {t('newCode')}
                </Button>
              ) : null}
              <Button type="button" onClick={() => handleOpenChange(false)}>
                {t('close')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

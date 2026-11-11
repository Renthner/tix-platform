'use client';

import { Pencil, ShieldOff, Trash2 } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Field } from '../form-controls';
import { AssignmentPicker } from './assignment-picker';
import {
  adminRequest,
  useErrorMessage,
  type DeviceAssignmentValue,
  type ScannerEventOption,
} from './scanner-client';

export interface DeviceRow {
  id: string;
  name: string;
  appVersion: string | null;
  deviceModel: string | null;
  isActive: boolean;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  assignments: {
    eventId: string;
    eventTitle: string;
    entranceId: string | null;
    entranceName: string | null;
    allowCheckOut: boolean;
  }[];
}

function EditDialog({
  device,
  events,
  open,
  onOpenChange,
}: {
  device: DeviceRow;
  events: ScannerEventOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('scanners.edit');
  const router = useRouter();
  const message = useErrorMessage();
  const [name, setName] = useState(device.name);
  const [assignments, setAssignments] = useState<DeviceAssignmentValue[]>(
    device.assignments.map((a) => ({
      eventId: a.eventId,
      entranceId: a.entranceId,
      allowCheckOut: a.allowCheckOut,
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (assignments.length === 0) {
      setError(t('noEventSelected'));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await adminRequest(`/api/admin/scanners/devices/${device.id}`, {
      method: 'PATCH',
      json: { name: name.trim(), assignments },
    });
    setBusy(false);
    if (!result.ok) {
      setError(message(result.code));
      return;
    }
    onOpenChange(false);
    router.refresh();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('eventsHint')}</DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="space-y-4">
          <Field label={t('name')} htmlFor={`name-${device.id}`}>
            <Input
              id={`name-${device.id}`}
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label={t('events')}>
            <AssignmentPicker
              idPrefix={`edit-${device.id}`}
              options={events}
              value={assignments}
              onChange={setAssignments}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button type="button" disabled={busy || name.trim() === ''} onClick={save}>
            {busy ? t('saving') : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevokeDialog({
  device,
  open,
  onOpenChange,
}: {
  device: DeviceRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('scanners.revoke');
  const tc = useTranslations('common.actions');
  const router = useRouter();
  const message = useErrorMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const revoke = async () => {
    setBusy(true);
    setError(null);
    const result = await adminRequest(`/api/admin/scanners/devices/${device.id}/revoke`, {
      method: 'POST',
    });
    setBusy(false);
    if (!result.ok) {
      setError(message(result.code));
      return;
    }
    onOpenChange(false);
    router.refresh();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('text', { name: device.name })}</DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {tc('cancel')}
          </Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={revoke}>
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  device,
  open,
  onOpenChange,
}: {
  device: DeviceRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('scanners.delete');
  const tc = useTranslations('common.actions');
  const router = useRouter();
  const message = useErrorMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    const result = await adminRequest(`/api/admin/scanners/devices/${device.id}`, {
      method: 'DELETE',
    });
    setBusy(false);
    if (!result.ok) {
      setError(message(result.code));
      return;
    }
    onOpenChange(false);
    router.refresh();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('text', { name: device.name })}</DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {tc('cancel')}
          </Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={remove}>
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Device list with edit (name, events, entrance, check-out) and revoke. */
export function ScannerDevices({
  devices,
  events,
  canManage,
}: {
  devices: DeviceRow[];
  events: ScannerEventOption[];
  canManage: boolean;
}) {
  const t = useTranslations('scanners.devices');
  const te = useTranslations('scanners.edit');
  const tr = useTranslations('scanners.revoke');
  const td = useTranslations('scanners.delete');
  const format = useFormatter();
  const [editing, setEditing] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  if (devices.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">{t('empty')}</p>;
  }
  const when = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'short', timeStyle: 'short' }) : t('never');

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('name')}</TableHead>
            <TableHead>{t('events')}</TableHead>
            <TableHead>{t('lastSeen')}</TableHead>
            <TableHead>{t('lastSync')}</TableHead>
            <TableHead>{t('appVersion')}</TableHead>
            <TableHead>{t('status')}</TableHead>
            {canManage ? <TableHead className="text-right">{t('actions')}</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {devices.map((device) => (
            <TableRow key={device.id} className={device.isActive ? undefined : 'opacity-60'}>
              <TableCell>
                <div className="font-medium">{device.name}</div>
                {device.deviceModel ? (
                  <div className="text-xs text-muted-foreground">{device.deviceModel}</div>
                ) : null}
              </TableCell>
              <TableCell>
                {device.assignments.length === 0 ? (
                  <span className="text-muted-foreground">{t('noEvents')}</span>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {device.assignments.map((a) => (
                      <li key={a.eventId}>
                        {a.eventTitle}
                        <span className="block text-xs text-muted-foreground">
                          {a.entranceName ?? t('anyEntrance')} ·{' '}
                          {a.allowCheckOut ? t('checkOutAllowed') : t('checkOutDenied')}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap">{when(device.lastSeenAt)}</TableCell>
              <TableCell className="whitespace-nowrap">{when(device.lastSyncAt)}</TableCell>
              <TableCell>{device.appVersion ?? '–'}</TableCell>
              <TableCell>
                <Badge variant={device.isActive ? 'secondary' : 'destructive'}>
                  {device.isActive ? t('active') : t('revoked')}
                </Badge>
              </TableCell>
              {canManage ? (
                <TableCell className="text-right whitespace-nowrap">
                  {device.isActive ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setEditing(device.id)}
                      >
                        <Pencil /> {te('button')}
                      </Button>{' '}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setRevoking(device.id)}
                      >
                        <ShieldOff /> {tr('button')}
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setDeleting(device.id)}
                    >
                      <Trash2 /> {td('button')}
                    </Button>
                  )}
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {devices.map((device) =>
        editing === device.id ? (
          <EditDialog
            key={`edit-${device.id}`}
            device={device}
            events={events}
            open
            onOpenChange={(open) => !open && setEditing(null)}
          />
        ) : revoking === device.id ? (
          <RevokeDialog
            key={`revoke-${device.id}`}
            device={device}
            open
            onOpenChange={(open) => !open && setRevoking(null)}
          />
        ) : deleting === device.id ? (
          <DeleteDialog
            key={`delete-${device.id}`}
            device={device}
            open
            onOpenChange={(open) => !open && setDeleting(null)}
          />
        ) : null,
      )}
    </>
  );
}

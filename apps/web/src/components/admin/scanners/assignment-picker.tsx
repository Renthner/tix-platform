'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { NativeSelect } from '@/components/admin/form-controls';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import type { DeviceAssignmentValue, ScannerEventOption } from './scanner-client';

/**
 * Event selection of a scanner device: tick the events it may scan, choose the entrance it is
 * stationed at and whether it may check guests out. Used by the pairing and the edit dialog.
 */
export function AssignmentPicker({
  options,
  value,
  onChange,
  idPrefix,
}: {
  options: ScannerEventOption[];
  value: DeviceAssignmentValue[];
  onChange: (next: DeviceAssignmentValue[]) => void;
  idPrefix: string;
}) {
  const t = useTranslations('scanners.edit');
  const format = useFormatter();
  const byEvent = new Map(value.map((a) => [a.eventId, a]));
  const update = (eventId: string, patch: Partial<DeviceAssignmentValue> | null) => {
    if (patch === null) {
      onChange(value.filter((a) => a.eventId !== eventId));
      return;
    }
    const current = byEvent.get(eventId);
    if (!current) {
      onChange([...value, { eventId, entranceId: null, allowCheckOut: true, ...patch }]);
    } else {
      onChange(value.map((a) => (a.eventId === eventId ? { ...a, ...patch } : a)));
    }
  };
  return (
    <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border p-2">
      {options.map((option) => {
        const assignment = byEvent.get(option.id);
        const checkId = `${idPrefix}-${option.id}`;
        return (
          <div key={option.id} className="space-y-2 rounded-md border p-2.5">
            <div className="flex items-center gap-2">
              <Checkbox
                id={checkId}
                checked={Boolean(assignment)}
                onCheckedChange={(checked) => update(option.id, checked === true ? {} : null)}
              />
              <Label htmlFor={checkId} className="flex-1 cursor-pointer">
                {option.title}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {format.dateTime(new Date(option.startsAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </span>
              </Label>
            </div>
            {assignment ? (
              <div className="grid gap-2 pl-6 sm:grid-cols-2">
                <NativeSelect
                  aria-label={t('events')}
                  value={assignment.entranceId ?? ''}
                  onChange={(e) => update(option.id, { entranceId: e.target.value || null })}
                >
                  <option value="">{t('anyEntrance')}</option>
                  {option.entrances.map((entrance) => (
                    <option key={entrance.id} value={entrance.id}>
                      {entrance.name}
                    </option>
                  ))}
                </NativeSelect>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`${checkId}-out`}
                    checked={assignment.allowCheckOut}
                    onCheckedChange={(checked) =>
                      update(option.id, { allowCheckOut: checked === true })
                    }
                  />
                  <Label htmlFor={`${checkId}-out`} className="cursor-pointer font-normal">
                    {t('allowCheckOut')}
                  </Label>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

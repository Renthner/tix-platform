'use client';

import type { SeatOrientation } from '@tix/shared';
import {
  ArrowDown,
  ArrowDownLeft,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  Spline,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { NumberField, PanelSection, SelectField } from './fields';
import type { Doc, Selection } from './model';
import { sameOrientation, setSeatOrientation } from './row-ops';

type Apply = (update: (doc: Doc) => Doc, coalesceKey?: string, select?: Selection) => void;

/** 3×3 direction pad; the centre lets the seats follow the row again. */
type Direction = 'up' | 'upRight' | 'right' | 'downRight' | 'down' | 'downLeft' | 'left' | 'upLeft';

const PAD: ({ key: Direction; angle: number; icon: LucideIcon } | null)[] = [
  { key: 'upLeft', angle: -45, icon: ArrowUpLeft },
  { key: 'up', angle: 0, icon: ArrowUp },
  { key: 'upRight', angle: 45, icon: ArrowUpRight },
  { key: 'left', angle: -90, icon: ArrowLeft },
  null,
  { key: 'right', angle: 90, icon: ArrowRight },
  { key: 'downLeft', angle: -135, icon: ArrowDownLeft },
  { key: 'down', angle: 180, icon: ArrowDown },
  { key: 'downRight', angle: 135, icon: ArrowDownRight },
];

/**
 * Seat orientation of one or more rows: follow the row (perpendicular to the curve, with an
 * optional turn such as 180°) or one fixed direction for all seats (up, left, diagonal …).
 */
export function SeatOrientationSection({
  doc,
  rowIds,
  apply,
}: {
  doc: Doc;
  rowIds: ReadonlySet<string>;
  apply: Apply;
}) {
  const t = useTranslations('editor');
  const rows = doc.rows.filter((r) => rowIds.has(r.id));
  if (rows.length === 0) return null;
  const current = rows[0]!.geometry.seatOrientation;
  const mixed = rows.some((r) => !sameOrientation(r.geometry.seatOrientation, current));
  const mode = current?.mode ?? 'ROW';
  const angle = current?.angle ?? 0;
  const key = [...rowIds].sort().join(',');

  const set = (orientation: SeatOrientation | null, coalesce?: string) =>
    apply(
      (d) => setSeatOrientation(d, rowIds, orientation),
      coalesce ? `orientation:${key}:${coalesce}` : undefined,
    );
  // ROW mode without turn is the default → store nothing.
  const normalized = (o: SeatOrientation): SeatOrientation | null =>
    o.mode === 'ROW' && o.angle === 0 ? null : o;

  return (
    <PanelSection title={t('panel.seatOrientation')}>
      <div className="grid w-fit grid-cols-3 gap-1">
        {PAD.map((cell) => {
          if (!cell) {
            const active = !mixed && mode === 'ROW';
            return (
              <Button
                key="follow"
                type="button"
                size="icon"
                variant={active ? 'default' : 'outline'}
                className="size-8"
                title={t('actions.followRow')}
                aria-label={t('actions.followRow')}
                aria-pressed={active}
                onClick={() => set(null)}
              >
                <Spline />
              </Button>
            );
          }
          const Icon = cell.icon;
          const active = !mixed && mode === 'FIXED' && angle === cell.angle;
          return (
            <Button
              key={cell.key}
              type="button"
              size="icon"
              variant={active ? 'default' : 'outline'}
              className={cn('size-8')}
              title={t(`directions.${cell.key}`)}
              aria-label={t(`directions.${cell.key}`)}
              aria-pressed={active}
              onClick={() => set({ mode: 'FIXED', angle: cell.angle })}
            >
              <Icon />
            </Button>
          );
        })}
      </div>
      {mixed && <p className="text-[11px] text-muted-foreground">{t('hints.orientationMixed')}</p>}
      <SelectField
        label={t('fields.orientationMode')}
        value={mixed ? null : mode}
        options={(['ROW', 'FIXED'] as const).map((v) => ({
          value: v,
          label: t(`options.orientationMode.${v}`),
        }))}
        onChange={(v) => {
          if (v === 'ROW') set(normalized({ mode: 'ROW', angle: 0 }));
          if (v === 'FIXED') set({ mode: 'FIXED', angle: 0 });
        }}
      />
      <NumberField
        label={t(mode === 'FIXED' ? 'fields.orientationAngle' : 'fields.orientationOffset')}
        hint={t('hints.orientation')}
        value={mixed ? null : angle}
        min={-360}
        max={360}
        step={5}
        onChange={(v) => v !== null && set(normalized({ mode, angle: v }), 'angle')}
      />
      {mode === 'ROW' && !mixed && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => set(normalized({ mode: 'ROW', angle: angle === 180 ? 0 : 180 }))}
        >
          {t('actions.turnAround')}
        </Button>
      )}
    </PanelSection>
  );
}

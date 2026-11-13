'use client';

import { Info, Table2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

/*
 * Small dependency-free SVG / CSS chart kit for the admin statistics and system pages.
 * Colours come from the theme variables (`--chart-1..8`, `--muted-foreground`, `--border`), so
 * light and dark mode work without extra code; text is real HTML/SVG text in the page font.
 * Every chart has an aria-label summary and a data table behind a toggle (ChartCard).
 */

export const CHART_COLORS = Array.from({ length: 8 }, (_, i) => `var(--chart-${i + 1})`);
export const chartColor = (index: number) => CHART_COLORS[index % CHART_COLORS.length]!;

/** Width of an element (ResizeObserver), so SVG text keeps its size at every screen width. */
function useElementWidth<T extends HTMLElement>(initial = 640) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.max(120, Math.round(el.getBoundingClientRect().width)));
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(120, Math.round(entry.contentRect.width)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * "Nice" axis maximum and tick values for 0..max. `minMax` keeps an empty chart from collapsing
 * to a 0-1 axis; `integer` never uses fractional steps (counts).
 */
export function niceScale(
  max: number,
  {
    ticks = 4,
    minMax = 1,
    integer = false,
  }: { ticks?: number; minMax?: number; integer?: boolean } = {},
): { max: number; ticks: number[] } {
  const top0 = Math.max(max, minMax);
  const rough = top0 / ticks;
  const pow = 10 ** Math.floor(Math.log10(rough));
  let unit = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((u) => u >= rough) ?? 10 * pow;
  if (integer) unit = Math.max(1, Math.ceil(unit));
  const top = Math.ceil(top0 / unit) * unit;
  return {
    max: top,
    ticks: Array.from({ length: Math.round(top / unit) + 1 }, (_, i) => i * unit),
  };
}

// ─── Card with info popover and data-table toggle ────────────────────────────────

export interface ChartTable {
  columns: string[];
  rows: ReactNode[][];
}

export function InfoPopover({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative inline-block">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <Info className="size-4" />
      </Button>
      {open && (
        <div
          id={id}
          role="note"
          className="absolute right-0 z-20 mt-1 w-[min(22rem,80vw)] rounded-md border bg-popover p-3 text-xs leading-relaxed text-popover-foreground shadow-md"
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function ChartCard({
  title,
  description,
  info,
  table,
  className,
  actions,
  children,
}: {
  title: string;
  description?: string;
  info?: ReactNode;
  table?: ChartTable;
  className?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations('statistics.chart');
  const [showTable, setShowTable] = useState(false);
  return (
    <Card className={cn('min-w-0', className)}>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div className="min-w-0">
          <CardTitle className="text-base">{title}</CardTitle>
          {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          {table && (
            <Button
              type="button"
              variant={showTable ? 'secondary' : 'ghost'}
              size="icon"
              className="size-7"
              aria-pressed={showTable}
              aria-label={showTable ? t('hideTable') : t('showTable')}
              title={showTable ? t('hideTable') : t('showTable')}
              onClick={() => setShowTable((v) => !v)}
            >
              <Table2 className="size-4" />
            </Button>
          )}
          {info && <InfoPopover label={t('info')}>{info}</InfoPopover>}
        </div>
      </CardHeader>
      <CardContent className="min-w-0">
        {showTable && table ? (
          <div className="max-h-80 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {table.columns.map((c, i) => (
                    <TableHead key={c} className={i > 0 ? 'text-right' : undefined}>
                      {c}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {table.rows.map((row, r) => (
                  <TableRow key={r}>
                    {row.map((cell, i) => (
                      <TableCell key={i} className={cn('tabular-nums', i > 0 && 'text-right')}>
                        {cell}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

export function Legend({ items }: { items: { key: string; label: string; color: string }[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block size-2.5 rounded-sm"
            style={{ backgroundColor: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

// ─── Line / area chart ──────────────────────────────────────────────────────────

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  /** One value per x position; null = no data (the line breaks). */
  values: (number | null)[];
}

const M = { top: 10, right: 14, bottom: 26, left: 8 };

export function LineChart({
  labels,
  tooltipLabels,
  series,
  formatValue,
  formatTick,
  area = false,
  height = 240,
  minMax,
  integer = false,
  ariaLabel,
}: {
  /** X axis labels (already formatted), one per position. */
  labels: string[];
  /** Longer label shown in the tooltip (default: `labels`). */
  tooltipLabels?: string[];
  series: LineSeries[];
  formatValue: (value: number) => string;
  /** Compact y axis format (default `formatValue`). */
  formatTick?: (value: number) => string;
  area?: boolean;
  height?: number;
  /** Smallest axis maximum (keeps an empty chart readable). */
  minMax?: number;
  /** Whole-number ticks only (counts). */
  integer?: boolean;
  ariaLabel: string;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const n = labels.length;
  const tick = formatTick ?? formatValue;
  const rawMax = Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
  const scale = niceScale(rawMax, { minMax, integer });
  const leftPad = Math.min(
    96,
    Math.max(32, Math.max(...scale.ticks.map((v) => tick(v).length)) * 7 + 12),
  );
  const plotW = Math.max(40, width - leftPad - M.right);
  const plotH = height - M.top - M.bottom;
  const x = (i: number) => leftPad + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => M.top + plotH - (v / scale.max) * plotH;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 64))));

  const move = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const rel = (event.clientX - rect.left - leftPad) / plotW;
    setActive(Math.min(n - 1, Math.max(0, Math.round(rel * (n - 1)))));
  };
  const key = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === 'ArrowRight') setActive((a) => Math.min(n - 1, (a ?? -1) + 1));
    else if (event.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? n) - 1));
    else if (event.key === 'Escape') setActive(null);
    else return;
    event.preventDefault();
  };

  const paths = series.map((s) => {
    const segments: string[] = [];
    let open = false;
    s.values.forEach((v, i) => {
      if (v === null) {
        open = false;
        return;
      }
      segments.push(`${open ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`);
      open = true;
    });
    return segments.join(' ');
  });

  const tooltipLeft = active === null ? 0 : x(active);
  const flip = tooltipLeft > width * 0.6;

  return (
    <div ref={ref} className="relative w-full select-none">
      <svg
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block max-w-full overflow-visible rounded-sm outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
        onPointerMove={move}
        onPointerLeave={() => setActive(null)}
        onKeyDown={key}
        onBlur={() => setActive(null)}
      >
        {scale.ticks.map((v) => (
          <g key={v}>
            <line
              x1={leftPad}
              x2={leftPad + plotW}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--border)"
              strokeDasharray={v === 0 ? undefined : '3 3'}
            />
            <text
              x={leftPad - 6}
              y={y(v)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={11}
              fill="var(--muted-foreground)"
            >
              {tick(v)}
            </text>
          </g>
        ))}
        {labels.map((label, i) =>
          i % every === 0 ? (
            <text
              key={i}
              x={x(i)}
              y={height - 8}
              textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
              fontSize={11}
              fill="var(--muted-foreground)"
            >
              {label}
            </text>
          ) : null,
        )}
        {series.map((s, si) => (
          <g key={s.key}>
            {area && paths[si] && (
              <path
                d={`${paths[si]} L${x(n - 1).toFixed(1)} ${y(0)} L${x(0).toFixed(1)} ${y(0)} Z`}
                fill={s.color}
                opacity={0.12}
              />
            )}
            <path
              d={paths[si]}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {n <= 40 &&
              s.values.map((v, i) =>
                v === null ? null : <circle key={i} cx={x(i)} cy={y(v)} r={2.5} fill={s.color} />,
              )}
          </g>
        ))}
        {active !== null && (
          <g pointerEvents="none">
            <line
              x1={x(active)}
              x2={x(active)}
              y1={M.top}
              y2={M.top + plotH}
              stroke="var(--muted-foreground)"
              strokeDasharray="2 3"
            />
            {series.map((s) => {
              const v = s.values[active];
              return v === null || v === undefined ? null : (
                <circle
                  key={s.key}
                  cx={x(active)}
                  cy={y(v)}
                  r={4.5}
                  fill={s.color}
                  stroke="var(--card)"
                  strokeWidth={2}
                />
              );
            })}
          </g>
        )}
      </svg>
      {active !== null && (
        <div
          role="status"
          className="pointer-events-none absolute top-1 z-10 min-w-32 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
          style={flip ? { right: width - tooltipLeft + 10 } : { left: tooltipLeft + 10 }}
        >
          <div className="mb-1 font-medium">{(tooltipLabels ?? labels)[active]}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block size-2 rounded-full"
                  style={{ backgroundColor: s.color }}
                />
                {s.label}
              </span>
              <span className="tabular-nums">
                {s.values[active] === null || s.values[active] === undefined
                  ? '–'
                  : formatValue(s.values[active]!)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Horizontal bar list ────────────────────────────────────────────────────────

export interface BarItem {
  key: string;
  label: string;
  value: number;
  /** Text right of the bar (default: the formatted value). */
  valueLabel?: string;
  /** Second line below the label (e.g. ticket count). */
  detail?: string;
  color?: string;
}

export function BarList({
  items,
  ariaLabel,
  emptyLabel,
}: {
  items: BarItem[];
  ariaLabel: string;
  emptyLabel: string;
}) {
  const max = Math.max(0, ...items.map((i) => i.value));
  if (items.length === 0)
    return <p className="py-6 text-center text-sm text-muted-foreground">{emptyLabel}</p>;
  return (
    <ul aria-label={ariaLabel} className="space-y-2.5">
      {items.map((item, i) => (
        <li key={item.key}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate" title={item.label}>
              {item.label}
            </span>
            <span className="shrink-0 tabular-nums">{item.valueLabel ?? item.value}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${max > 0 ? Math.max(2, (item.value / max) * 100) : 0}%`,
                backgroundColor: item.color ?? chartColor(i),
              }}
            />
          </div>
          {item.detail && <div className="mt-0.5 text-xs text-muted-foreground">{item.detail}</div>}
        </li>
      ))}
    </ul>
  );
}

// ─── Column chart (small number of categories, e.g. lead time) ───────────────────

export function ColumnChart({
  items,
  ariaLabel,
  formatValue,
  color = chartColor(0),
  height = 160,
}: {
  items: { key: string; label: string; value: number }[];
  ariaLabel: string;
  formatValue: (value: number) => string;
  color?: string;
  height?: number;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div role="img" aria-label={ariaLabel}>
      <div className="flex items-end gap-1.5 sm:gap-2" style={{ height }}>
        {items.map((item) => (
          <div
            key={item.key}
            className="flex h-full min-w-0 flex-1 flex-col justify-end"
            title={`${item.label}: ${formatValue(item.value)}`}
          >
            <div className="mb-0.5 text-center text-[11px] tabular-nums text-muted-foreground">
              {item.value > 0 ? formatValue(item.value) : ''}
            </div>
            <div
              className="w-full rounded-t-sm"
              style={{
                height: `${(item.value / max) * 100}%`,
                minHeight: item.value > 0 ? 2 : 0,
                backgroundColor: color,
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1.5 sm:gap-2">
        {items.map((item) => (
          <div
            key={item.key}
            className="min-w-0 flex-1 truncate text-center text-[11px] text-muted-foreground"
          >
            {item.label}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Heatmap (weekday × hour) ───────────────────────────────────────────────────

export function Heatmap({
  rowLabels,
  hourLabel,
  cells,
  cellLabel,
  ariaLabel,
}: {
  /** Seven short weekday labels, Monday first. */
  rowLabels: string[];
  hourLabel: (hour: number) => string;
  /** `cells[dow-1][hour]` = value. */
  cells: number[][];
  cellLabel: (row: number, hour: number, value: number) => string;
  ariaLabel: string;
}) {
  const max = Math.max(1, ...cells.flat());
  return (
    <table
      aria-label={ariaLabel}
      className="w-full table-fixed border-separate border-spacing-0.5 text-[10px]"
    >
      <thead>
        <tr>
          <th className="w-7 sm:w-9" />
          {Array.from({ length: 24 }, (_, h) => (
            <th
              key={h}
              className="overflow-visible p-0 text-center font-normal text-muted-foreground"
            >
              {h % 3 === 0 ? (
                <span>{hourLabel(h)}</span>
              ) : (
                <span className="sr-only">{hourLabel(h)}</span>
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rowLabels.map((label, r) => (
          <tr key={label}>
            <th scope="row" className="pr-1 text-right font-normal text-muted-foreground">
              {label}
            </th>
            {Array.from({ length: 24 }, (_, h) => {
              const value = cells[r]?.[h] ?? 0;
              return (
                <td
                  key={h}
                  title={cellLabel(r, h, value)}
                  className="h-5 rounded-[3px] bg-muted sm:h-6"
                  style={
                    value > 0
                      ? {
                          backgroundColor: `color-mix(in oklab, var(--chart-1) ${Math.round(
                            18 + (value / max) * 82,
                          )}%, transparent)`,
                        }
                      : undefined
                  }
                >
                  <span className="sr-only">{cellLabel(r, h, value)}</span>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Sparkline (system page) ────────────────────────────────────────────────────

export function Sparkline({
  values,
  color = chartColor(0),
  width = 96,
  height = 28,
  label,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
  label: string;
}) {
  if (values.length < 2)
    return <span aria-hidden className="inline-block" style={{ width, height }} />;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const points = values
    .map((v, i) => {
      const px = (i / (values.length - 1)) * (width - 2) + 1;
      const py = height - 2 - ((v - min) / span) * (height - 4);
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      role="img"
      aria-label={label}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      <polyline
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}

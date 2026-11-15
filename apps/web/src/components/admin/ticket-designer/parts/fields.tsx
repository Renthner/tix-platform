'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { round } from './model';

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.5,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Input
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={text}
        className="h-8 px-2"
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(n)) onChange(round(n));
        }}
      />
    </label>
  );
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <select
        className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ColorField({
  label,
  value,
  onChange,
  clearable,
  clearLabel,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  clearable?: boolean;
  clearLabel?: string;
}) {
  return (
    <div className="space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={label}
          value={value ?? '#000000'}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="h-8 w-10 cursor-pointer rounded border bg-transparent p-0.5"
        />
        {clearable && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs"
            disabled={value === undefined}
            onClick={() => onChange(undefined)}
          >
            {clearLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

export function PanelGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </div>
      {children}
    </div>
  );
}

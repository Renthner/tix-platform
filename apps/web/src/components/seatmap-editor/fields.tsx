'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/** Compact form controls for the properties panel and dialogs. */

export function Field({
  label,
  children,
  hint,
  className,
  htmlFor,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  maxLength,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  placeholder?: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <Input
        id={id}
        className="h-8 text-sm"
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

/**
 * Number input that tolerates intermediate states ("", "-", "1.") while typing and only
 * commits finite values within [min, max].
 */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  integer,
  hint,
  allowEmpty,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  hint?: string;
  allowEmpty?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState(value === null ? '' : String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value === null ? '' : String(value));
  }, [value, focused]);
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <Input
        id={id}
        className="h-8 text-sm"
        inputMode={integer ? 'numeric' : 'decimal'}
        type="number"
        min={min}
        max={max}
        step={step ?? (integer ? 1 : 'any')}
        value={text}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          if (raw.trim() === '') {
            if (allowEmpty) onChange(null);
            return;
          }
          const n = Number(raw);
          if (!Number.isFinite(n)) return;
          if (integer && !Number.isInteger(n)) return;
          if (min !== undefined && n < min) return;
          if (max !== undefined && n > max) return;
          onChange(n);
        }}
      />
    </Field>
  );
}

export interface Option {
  value: string;
  label: string;
}

/** Native select (fast, accessible, supports an empty option). */
export function SelectField({
  label,
  value,
  options,
  onChange,
  emptyLabel,
  hint,
}: {
  label: string;
  value: string | null;
  options: Option[];
  onChange: (value: string | null) => void;
  /** When given, an empty choice mapped to `null` is offered. */
  emptyLabel?: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <select
        id={id}
        className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      >
        {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function SwitchField({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id} className="text-sm font-normal">
          {label}
        </Label>
        <Switch id={id} checked={checked} onCheckedChange={onChange} />
      </div>
      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function ColorField({
  label,
  value,
  onChange,
  allowEmpty,
  emptyLabel,
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
}) {
  const id = useId();
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  return (
    <Field label={label} htmlFor={id}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={label}
          className="h-8 w-9 shrink-0 cursor-pointer rounded border border-input bg-background p-0.5"
          value={(value ?? '#94a3b8').slice(0, 7)}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
        />
        <Input
          id={id}
          className="h-8 font-mono text-xs"
          value={text}
          placeholder={allowEmpty ? emptyLabel : '#RRGGBB'}
          onChange={(e) => {
            const raw = e.target.value.trim();
            setText(raw);
            if (raw === '' && allowEmpty) onChange(null);
            else if (/^#[0-9a-fA-F]{6}$/.test(raw)) onChange(raw.toUpperCase());
          }}
        />
      </div>
    </Field>
  );
}

export function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-b px-4 py-4 last:border-b-0">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

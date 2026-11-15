'use client';

import { TICKET_FIELD_VARIABLES, TICKET_LABEL_KEYS } from '@tix/shared';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

const PLACEHOLDER_NAME_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Free-text editor with a placeholder picker (inserts `{{name}}` at the cursor). */
export function StaticTextField({
  value,
  onChange,
}: {
  value: string;
  onChange: (text: string) => void;
}) {
  const t = useTranslations('ticketDesigner');
  const tp = useTranslations('ticketDesigner.props');
  const ref = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);

  const fieldItems = (
    Object.entries(TICKET_FIELD_VARIABLES) as [keyof typeof TICKET_FIELD_VARIABLES, string][]
  ).map(([field, name]) => ({
    name,
    label: t(`fields.${field}`),
    example: t(`sample.${field}`),
  }));
  const labelItems = TICKET_LABEL_KEYS.map((key) => ({
    name: `label.${key}`,
    label: t(`labels.${key}`),
    example: t(`labels.${key}`),
  }));

  const known = new Set([...fieldItems, ...labelItems].map((i) => i.name));
  const unknown = [
    ...new Set(
      [...value.matchAll(PLACEHOLDER_NAME_RE)].map((m) => m[1] ?? '').filter((n) => !known.has(n)),
    ),
  ];

  const insert = (name: string) => {
    const token = `{{${name}}}`;
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    if (next.length > 2000) return;
    onChange(next);
    const caret = start + token.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  const renderGroup = (title: string, items: typeof fieldItems) => (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
      <div className="flex flex-wrap gap-1">
        {items.map((v) => (
          <button
            key={v.name}
            type="button"
            title={`${v.label} – ${t('placeholders.example', { value: v.example })}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insert(v.name)}
            className="rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] hover:bg-accent"
          >
            {v.name}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{tp('text')}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((o) => !o)}
        >
          {t('placeholders.insert')}
        </Button>
      </div>
      <Textarea
        ref={ref}
        rows={3}
        maxLength={2000}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {open && (
        <div className="space-y-2 rounded-md border p-2">
          <p className="text-xs text-muted-foreground">
            {t('placeholders.hint', { example: '{{eventTitle}}' })}
          </p>
          {renderGroup(t('placeholders.fields'), fieldItems)}
          {renderGroup(t('placeholders.labelsGroup'), labelItems)}
        </div>
      )}
      {unknown.length > 0 && (
        <p role="alert" className="text-xs text-warning">
          {t('placeholders.unknown', { names: unknown.map((n) => `{{${n}}}`).join(', ') })}
        </p>
      )}
    </div>
  );
}

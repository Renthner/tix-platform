'use client';

import type { SymbolKind } from '@tix/shared';
import { Ban, ExternalLink, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import { symbolDataUrl } from './symbols';
import type { EditorSymbol } from './types';

/**
 * Reusable symbol picker: a field showing the current symbol that opens a searchable grid
 * of library previews. "None" maps to null. Library management lives on /admin/symbols.
 */
export function SymbolPicker({
  label,
  symbols,
  kind,
  value,
  onChange,
  noneLabel,
  previewColor = '#475569',
  hint,
}: {
  label: string;
  symbols: readonly EditorSymbol[];
  kind: SymbolKind;
  value: string | null;
  onChange: (symbolId: string | null) => void;
  noneLabel: string;
  previewColor?: string;
  hint?: string;
}) {
  const t = useTranslations('editor.symbols');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const options = useMemo(() => symbols.filter((s) => s.kind === kind), [symbols, kind]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((s) => s.name.toLowerCase().includes(q)) : options;
  }, [options, query]);
  const current = value ? symbols.find((s) => s.id === value) : undefined;

  const choose = (id: string | null) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full justify-start gap-2 font-normal"
        onClick={() => setOpen(true)}
        aria-label={`${label}: ${current?.name ?? noneLabel}`}
      >
        {current ? (
          <img src={symbolDataUrl(current, previewColor)} alt="" className="size-5 shrink-0" />
        ) : (
          <Ban className="text-muted-foreground" />
        )}
        <span className="truncate">{current?.name ?? (value ? t('missing') : noneLabel)}</span>
      </Button>
      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t(kind === 'SEAT' ? 'seatTitle' : 'elementTitle')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              className="pl-8"
              placeholder={t('search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t('search')}
            />
          </div>
          <div
            className="grid max-h-80 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6"
            role="listbox"
            aria-label={label}
          >
            <SymbolTile selected={value === null} label={noneLabel} onClick={() => choose(null)}>
              <Ban className="size-7 text-muted-foreground" />
            </SymbolTile>
            {filtered.map((s) => (
              <SymbolTile
                key={s.id}
                selected={value === s.id}
                label={s.name}
                onClick={() => choose(s.id)}
              >
                <img
                  src={symbolDataUrl(s, previewColor)}
                  alt=""
                  className="size-8"
                  loading="lazy"
                />
              </SymbolTile>
            ))}
          </div>
          {filtered.length === 0 && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
          <Link
            href="/admin/symbols"
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            <ExternalLink className="size-3.5" />
            {t('manage')}
          </Link>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SymbolTile({
  selected,
  label,
  onClick,
  children,
}: {
  selected: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      title={label}
      onClick={onClick}
      className={cn(
        'flex flex-col items-center gap-1 rounded-md border p-2 text-center text-[11px] leading-tight transition-colors hover:bg-accent',
        selected && 'border-primary ring-2 ring-primary/30',
      )}
    >
      <span className="flex size-9 items-center justify-center">{children}</span>
      <span className="line-clamp-2 w-full break-words">{label}</span>
    </button>
  );
}

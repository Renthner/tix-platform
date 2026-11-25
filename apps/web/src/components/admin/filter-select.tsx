'use client';

import { useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface FilterOption {
  value: string;
  label: string;
}

/**
 * Native `<select>` for GET filter forms (works without JavaScript for submitting). The first,
 * empty option means "no filter". Long lists (`searchable`, or more than `searchThreshold`
 * options) get a small search box that narrows the options; the selected option always stays.
 */
export function FilterSelect({
  name,
  value,
  options,
  allLabel,
  ariaLabel,
  searchable,
  searchThreshold = 12,
  className,
}: {
  name: string;
  value?: string;
  options: readonly FilterOption[];
  /** Label of the empty "no filter" option; omitted = the list has no empty option. */
  allLabel?: string;
  ariaLabel: string;
  searchable?: boolean;
  searchThreshold?: number;
  className?: string;
}) {
  const t = useTranslations('common.filterSelect');
  const id = useId();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(value ?? '');
  const showSearch = searchable ?? options.length > searchThreshold;
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((o) => o.value === selected || o.label.toLowerCase().includes(needle));
  }, [options, query, selected]);

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {showSearch && (
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter in the search box narrows the list; it must not submit the filter form.
            if (e.key === 'Enter') e.preventDefault();
          }}
          placeholder={t('search')}
          aria-label={t('searchLabel', { field: ariaLabel })}
          aria-controls={id}
          className="h-8"
        />
      )}
      <select
        id={id}
        name={name}
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="h-9 max-w-64 rounded-md border border-input bg-transparent px-3 text-sm"
        aria-label={ariaLabel}
      >
        {allLabel !== undefined && <option value="">{allLabel}</option>}
        {visible.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

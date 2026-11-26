import { useTranslations } from 'next-intl';
import { ChevronDown, Search, SlidersHorizontal, X } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  AutoSubmitFallbackButton,
  AutoSubmitForm,
  AutoSubmitPending,
  FilterSearchInput,
} from '@/components/admin/auto-submit-form';
import { Link } from '@/i18n/navigation';

export interface ActiveFilterChip {
  key: string;
  /** e.g. "Status: Paid". */
  label: string;
  /** The list URL without this filter. */
  removeHref: string;
}

/**
 * Filter bar of an admin list: ONE GET form that applies itself (`AutoSubmitForm`: selects and
 * checkboxes on change, the search after a typing pause or on Enter; without JavaScript a plain
 * GET form with an apply button) with a search field, compact filter selects, a "More filters"
 * panel for rarely used filters, a reset link while a filter is active and a right-aligned slot
 * for actions (export …). Active filters can be listed below as removable chips.
 *
 * The "More filters" panel is a native `<details>` (not a portaled popover): its inputs stay
 * inside the form and are submitted even while the panel is closed.
 */
export function ListToolbar({
  action = '',
  search,
  filters,
  moreFilters,
  moreActiveCount = 0,
  hidden,
  resetHref,
  chips,
  actions,
  ...rest
}: {
  action?: string;
  search?: { name?: string; value?: string; placeholder: string; label?: string };
  /** Compact controls shown in the bar (e.g. `FilterSelect`s). */
  filters?: ReactNode;
  /** Rarely used controls inside the "More filters" panel. */
  moreFilters?: ReactNode;
  /** Active filters inside the panel (shown as a count on its button). */
  moreActiveCount?: number;
  /** Params the form must keep (sort, page size, quick filters …); empty values are skipped. */
  hidden?: Record<string, string | number | undefined | null>;
  /** Shown as "Reset filters" link when set (i.e. while any filter is active). */
  resetHref?: string | null;
  chips?: readonly ActiveFilterChip[];
  actions?: ReactNode;
  'data-testid'?: string;
}) {
  const t = useTranslations('admin.list');
  const searchName = search?.name ?? 'q';
  // Chip/reset links navigate client-side; uncontrolled controls (FilterSelect state, date inputs)
  // would keep their old values and resubmit a removed filter. Remount those controls whenever
  // the active filter state changes. The search (and its chip) is left out: it is never
  // remounted, so typing never loses characters or focus (`FilterSearchInput` follows the URL).
  const formKey = JSON.stringify([
    hidden ?? null,
    (chips ?? []).filter((c) => c.key !== searchName).map((c) => [c.key, c.label]),
    moreActiveCount,
  ]);
  return (
    <div className="space-y-2" data-testid={rest['data-testid']}>
      <div className="flex flex-wrap items-start gap-2">
        <AutoSubmitForm
          action={action}
          resetKey={formKey}
          role="search"
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
        >
          {search && (
            <div className="relative min-w-56 flex-1 sm:max-w-sm">
              <Search
                className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground"
                aria-hidden
              />
              <FilterSearchInput
                name={searchName}
                value={search.value ?? ''}
                placeholder={search.placeholder}
                aria-label={search.label ?? search.placeholder}
                className="pl-8"
              />
            </div>
          )}
          {filters && (
            <div key={formKey} className="contents">
              {filters}
            </div>
          )}
          {moreFilters && (
            // Only the panel content is remounted: the panel stays open while its filters apply.
            <details className="group relative" data-testid="list-more-filters">
              <summary className="inline-flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm shadow-xs select-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden">
                <SlidersHorizontal className="size-4" aria-hidden />
                {t('moreFilters')}
                {moreActiveCount > 0 && (
                  <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">
                    {moreActiveCount}
                  </span>
                )}
                <ChevronDown
                  className="size-3.5 opacity-70 transition-transform group-open:rotate-180"
                  aria-hidden
                />
              </summary>
              <div
                key={formKey}
                className="absolute left-0 z-30 mt-1 w-72 max-w-[calc(100vw-3rem)] space-y-3 rounded-md border bg-popover p-3 text-popover-foreground shadow-md"
              >
                {moreFilters}
              </div>
            </details>
          )}
          {Object.entries(hidden ?? {}).map(([name, value]) =>
            value === undefined || value === null || value === '' ? null : (
              <input key={name} type="hidden" name={name} value={String(value)} />
            ),
          )}
          <AutoSubmitFallbackButton>{t('apply')}</AutoSubmitFallbackButton>
          <AutoSubmitPending />
          {resetHref && (
            <Link
              href={resetHref}
              className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              data-testid="list-reset-filters"
            >
              {t('reset')}
            </Link>
          )}
        </AutoSubmitForm>
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {chips && chips.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('activeFilters')}>
          {chips.map((chip) => (
            <li key={chip.key}>
              <Link
                href={chip.removeHref}
                className="inline-flex items-center gap-1 rounded-full border bg-muted px-2.5 py-0.5 text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                aria-label={t('removeFilter', { filter: chip.label })}
              >
                {chip.label}
                <X className="size-3" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Labelled control inside the "More filters" panel (label above the control). */
export function MoreFilterField({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

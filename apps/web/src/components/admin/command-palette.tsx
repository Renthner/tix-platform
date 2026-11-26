'use client';

import { CalendarDays, FileText, Loader2, ReceiptText, Search, UserRound } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import type { AdminSearchResponse } from '@/app/api/admin/search/route';
import type { PaletteEntry } from '@/server/admin/palette';

const MAX_STATIC = 12;
const DEBOUNCE_MS = 250;

interface Option {
  id: string;
  label: string;
  hint: string;
  href: string;
  icon: ReactNode;
  section: 'pages' | 'orders' | 'customers' | 'events';
}

function staticMatches(entries: PaletteEntry[], needle: string) {
  if (!needle) return entries.slice(0, MAX_STATIC).map((e) => ({ entry: e, hits: [] as string[] }));
  const scored: { entry: PaletteEntry; hits: string[]; score: number }[] = [];
  for (const entry of entries) {
    const label = entry.label.toLowerCase();
    const nameHit = label.includes(needle) || entry.group.toLowerCase().includes(needle);
    const hits = nameHit ? [] : entry.keywords.filter((k) => k.toLowerCase().includes(needle));
    if (!nameHit && hits.length === 0) continue;
    scored.push({
      entry,
      hits: hits.slice(0, 2),
      score: label.startsWith(needle) ? 0 : label.includes(needle) ? 1 : nameHit ? 2 : 3,
    });
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, MAX_STATIC);
}

/**
 * Search button in the admin top bar plus the palette it opens (also via Ctrl+K / ⌘K): admin
 * pages and settings pages (filtered by role on the server, `entries`) and live results for
 * orders, customers and events from `/api/admin/search`. Combobox pattern: the input keeps the
 * focus, arrow keys move the active option, Enter opens it.
 */
export function CommandPalette({ entries }: { entries: PaletteEntry[] }) {
  const t = useTranslations('admin.shell.search');
  const format = useFormatter();
  const router = useRouter();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [live, setLive] = useState<AdminSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [mac, setMac] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  // Platform hint after hydration (the server renders "Ctrl K").
  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        // Rich-text editors may bind Mod-K themselves (links).
        const target = e.target as HTMLElement | null;
        if (target?.isContentEditable) return;
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const needle = query.trim().toLowerCase();

  useEffect(() => {
    if (!open || needle.length < 2) {
      setLive(null);
      setLoading(false);
      setFailed(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      fetch(`/api/admin/search?q=${encodeURIComponent(needle)}`, {
        signal: controller.signal,
        cache: 'no-store',
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status));
          setLive((await res.json()) as AdminSearchResponse);
          setFailed(false);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setLive(null);
          setFailed(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [needle, open]);

  const options = useMemo<Option[]>(() => {
    const list: Option[] = staticMatches(entries, needle).map(({ entry, hits }) => ({
      id: entry.id,
      label: entry.label,
      hint: [entry.group, ...hits].join(' · '),
      href: entry.href,
      icon: <FileText className="size-4" aria-hidden />,
      section: 'pages',
    }));
    if (live) {
      for (const o of live.orders) {
        list.push({
          id: `order:${o.id}`,
          label: o.orderNumber,
          hint: [o.name, o.email, o.paymentReference].filter(Boolean).join(' · '),
          href: `/admin/orders/${o.id}`,
          icon: <ReceiptText className="size-4" aria-hidden />,
          section: 'orders',
        });
      }
      for (const c of live.customers) {
        list.push({
          id: `customer:${c.id}`,
          label: c.name || c.email,
          hint: c.email,
          href: `/admin/customers/${c.id}`,
          icon: <UserRound className="size-4" aria-hidden />,
          section: 'customers',
        });
      }
      for (const e of live.events) {
        list.push({
          id: `event:${e.id}`,
          label: e.title,
          hint: [format.dateTime(new Date(e.startsAt), { dateStyle: 'medium' }), e.venueName].join(
            ' · ',
          ),
          href: `/admin/events/${e.id}`,
          icon: <CalendarDays className="size-4" aria-hidden />,
          section: 'events',
        });
      }
    }
    return list;
  }, [entries, needle, live, format]);

  // Keep the active option in range and visible.
  useEffect(() => setActive(0), [needle, live]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const go = (option: Option | undefined) => {
    if (!option) return;
    setOpen(false);
    setQuery('');
    router.push(option.href);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (options.length ? (i + 1) % options.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (options.length ? (i - 1 + options.length) % options.length : 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(Math.max(options.length - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(options[active]);
    }
  };

  const optionId = (i: number) => `${listId}-opt-${i}`;
  const sections: Option['section'][] = ['pages', 'orders', 'customers', 'events'];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 w-full max-w-xs items-center gap-2 rounded-md border bg-background px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        aria-keyshortcuts="Control+K Meta+K"
        data-testid="admin-search-button"
      >
        <Search className="size-4 shrink-0" aria-hidden />
        <span className="flex-1 truncate text-left">{t('button')}</span>
        <kbd className="hidden rounded border bg-muted px-1.5 font-mono text-[0.7rem] sm:inline-block">
          {mac ? '⌘ K' : t('ctrlK')}
        </kbd>
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery('');
        }}
      >
        <DialogContent
          className="top-[12%] translate-y-0 gap-0 p-0 sm:max-w-xl"
          showCloseButton={false}
          data-testid="admin-search"
        >
          <DialogTitle className="sr-only">{t('title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('description')}</DialogDescription>
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={options.length ? optionId(active) : undefined}
              aria-label={t('label')}
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t('placeholder')}
              className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              maxLength={100}
            />
            {loading && (
              <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
            )}
          </div>
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={t('results')}
            className="max-h-[min(60dvh,28rem)] overflow-y-auto p-1"
          >
            {sections.map((section) => {
              const items = options
                .map((option, index) => ({ option, index }))
                .filter(({ option }) => option.section === section);
              if (items.length === 0) return null;
              return (
                <li key={section} role="presentation">
                  <div
                    className="px-2 pt-2 pb-1 text-[0.7rem] font-semibold tracking-wider text-muted-foreground uppercase"
                    aria-hidden
                  >
                    {t(`sections.${section}`)}
                  </div>
                  <ul role="group" aria-label={t(`sections.${section}`)}>
                    {items.map(({ option, index }) => (
                      <li
                        key={option.id}
                        id={optionId(index)}
                        role="option"
                        aria-selected={index === active}
                        data-index={index}
                        onMouseMove={() => setActive(index)}
                        onClick={() => go(option)}
                        className={cn(
                          'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
                          index === active && 'bg-accent text-accent-foreground',
                        )}
                      >
                        <span className="text-muted-foreground">{option.icon}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{option.label}</span>
                          {option.hint && (
                            <span className="block truncate text-xs text-muted-foreground">
                              {option.hint}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
          <div className="border-t px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
            {failed
              ? t('failed')
              : options.length === 0 && !loading
                ? t('none')
                : needle.length === 1
                  ? t('minChars')
                  : t('footer')}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

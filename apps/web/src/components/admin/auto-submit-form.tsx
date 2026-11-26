'use client';

import { Loader2 } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ChangeEvent,
  type ComponentProps,
  type CompositionEvent,
  type SubmitEvent,
  type KeyboardEvent,
} from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { usePathname, useRouter } from '@/i18n/navigation';
import {
  DATE_INPUT_TYPES,
  FILTER_RESET_PARAMS,
  TEXT_INPUT_TYPES,
  canonicalQuery,
  filterEntriesToParams,
  isApplicableDateValue,
} from '@/lib/filter-query';
import { cn } from '@/lib/utils';

/**
 * Client-side navigation of a filter form: `router.replace` (no scroll, inside a transition, so
 * the latest change wins), the page param is dropped, and nothing happens when the query (order
 * independent, without `page`) equals the current URL – or the target still in flight.
 * `action` = target path; empty = the current path.
 */
export function useFilterNavigation(action = '') {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const target = useRef<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!pending) inFlight.current = false;
  }, [pending]);

  const navigate = useCallback(
    (params: URLSearchParams): boolean => {
      for (const name of FILTER_RESET_PARAMS) params.delete(name);
      const next = canonicalQuery(params);
      const current = canonicalQuery(window.location.search);
      if (inFlight.current && current === target.current) inFlight.current = false;
      if (next === (inFlight.current ? target.current : current)) return false;
      target.current = next;
      inFlight.current = true;
      const path = action || pathname;
      const qs = params.toString();
      startTransition(() => router.replace(qs ? `${path}?${qs}` : path, { scroll: false }));
      return true;
    },
    [action, pathname, router],
  );

  return { navigate, pending };
}

interface AutoSubmitState {
  /** Hydrated: the form applies changes itself (the fallback submit button is hidden). */
  ready: boolean;
  /** A filter navigation is in flight. */
  pending: boolean;
  /** A typing pause is being waited for (a text field must not be overwritten meanwhile). */
  isDebouncing: () => boolean;
}

const AutoSubmitContext = createContext<AutoSubmitState | null>(null);

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function isField(el: EventTarget | null): el is Field {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
  );
}

/** A half-typed date (or one with an implausible year) blocks applying: it would read as "". */
function hasIncompleteDate(form: HTMLFormElement): boolean {
  for (const el of Array.from(form.elements)) {
    if (!(el instanceof HTMLInputElement) || !el.name || !DATE_INPUT_TYPES.has(el.type)) continue;
    if (el.validity.badInput || !isApplicableDateValue(el.type, el.value)) return true;
  }
  return false;
}

/**
 * Drop-in replacement for an admin filter `<form action="" method="get">` that applies itself:
 * selects, checkboxes and radios on change, text fields after a typing pause (`debounceMs`) or
 * immediately on Enter, date inputs after a short pause once complete (or cleared). The query is
 * built from the form fields like a GET submit (empty values skipped, `page` dropped, everything
 * else – hidden inputs too – kept) and applied with `router.replace`.
 *
 * Without JavaScript it stays a plain GET form: render an `AutoSubmitFallbackButton` inside it.
 * Fields without a `name` or inside `[data-auto-submit="off"]` are ignored. While hydrated the
 * form carries `data-auto-submit="ready"` (and `data-pending` during a navigation).
 *
 * `resetKey`: when the caller remounts (keyed) uncontrolled controls after a URL change, pass the
 * same key – keyboard focus returns to the control that triggered the change.
 */
export function AutoSubmitForm({
  action = '',
  debounceMs = 400,
  resetKey,
  children,
  onChange,
  onCompositionEnd,
  onKeyDown,
  onSubmit,
  ...props
}: Omit<ComponentProps<'form'>, 'action' | 'method'> & {
  action?: string;
  debounceMs?: number;
  resetKey?: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const { navigate, pending } = useFilterNavigation(action);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusTarget = useRef<{ name: string; value?: string } | null>(null);
  const [ready, setReady] = useState(false);

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => {
    setReady(true);
    return clearTimer;
  }, [clearTimer]);

  const apply = (trigger: Field | null, submitter?: HTMLElement | null) => {
    clearTimer();
    const form = formRef.current;
    if (!form || hasIncompleteDate(form)) return;
    let data: FormData;
    try {
      data = submitter ? new FormData(form, submitter) : new FormData(form);
    } catch {
      data = new FormData(form);
    }
    if (!navigate(filterEntriesToParams(data.entries()))) return;
    focusTarget.current = trigger?.name
      ? {
          name: trigger.name,
          value:
            trigger instanceof HTMLInputElement &&
            (trigger.type === 'checkbox' || trigger.type === 'radio')
              ? trigger.value
              : undefined,
        }
      : null;
  };

  const schedule = (trigger: Field) => {
    clearTimer();
    timer.current = setTimeout(() => apply(trigger), debounceMs);
  };

  const handles = (el: EventTarget | null): el is Field =>
    isField(el) &&
    !!el.name &&
    el.form === formRef.current &&
    !el.closest('[data-auto-submit="off"]');

  const handleChange = (e: ChangeEvent<HTMLFormElement>) => {
    onChange?.(e);
    const el = e.target as EventTarget;
    if (e.defaultPrevented || !handles(el)) return;
    if (el instanceof HTMLInputElement) {
      if (el.type === 'hidden' || el.type === 'file') return;
      if (TEXT_INPUT_TYPES.has(el.type)) {
        if (!(e.nativeEvent as InputEvent).isComposing) schedule(el);
        return;
      }
      if (DATE_INPUT_TYPES.has(el.type)) {
        // Debounced too: typing a date changes the value segment by segment.
        if (!el.validity.badInput && isApplicableDateValue(el.type, el.value)) schedule(el);
        return;
      }
    }
    if (el instanceof HTMLTextAreaElement) {
      schedule(el);
      return;
    }
    apply(el);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    onKeyDown?.(e);
    const el = e.target as EventTarget;
    if (e.key !== 'Enter' || e.defaultPrevented || e.nativeEvent.isComposing) return;
    if (!(el instanceof HTMLInputElement) || !handles(el)) return;
    if (!TEXT_INPUT_TYPES.has(el.type) && !DATE_INPUT_TYPES.has(el.type)) return;
    // Not left to implicit submission (the fallback button is hidden): apply right away.
    e.preventDefault();
    apply(el);
  };

  // The input event that commits IME text may still be flagged as composing: apply afterwards.
  const handleCompositionEnd = (e: CompositionEvent<HTMLFormElement>) => {
    onCompositionEnd?.(e);
    const el = e.target as EventTarget;
    if (el instanceof HTMLInputElement && handles(el) && TEXT_INPUT_TYPES.has(el.type)) {
      schedule(el);
    }
  };

  const handleSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    onSubmit?.(e);
    if (e.defaultPrevented) return;
    e.preventDefault();
    apply(null, e.submitter);
  };

  // Keyed controls were remounted: give keyboard focus back to the control that was changed.
  useLayoutEffect(() => {
    const wanted = focusTarget.current;
    const form = formRef.current;
    if (!wanted || !form) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const el = Array.from(form.elements).find(
      (c): c is Field =>
        isField(c) &&
        c.name === wanted.name &&
        (wanted.value === undefined || c.value === wanted.value),
    );
    el?.focus({ preventScroll: true });
  }, [resetKey]);

  useEffect(() => {
    if (!pending) focusTarget.current = null;
  }, [pending]);

  const isDebouncing = useCallback(() => timer.current !== null, []);
  const state = useMemo(() => ({ ready, pending, isDebouncing }), [ready, pending, isDebouncing]);

  return (
    <AutoSubmitContext.Provider value={state}>
      <form
        ref={formRef}
        {...props}
        action={action}
        method="get"
        data-auto-submit={ready ? 'ready' : undefined}
        data-pending={pending ? '' : undefined}
        onChange={handleChange}
        onCompositionEnd={handleCompositionEnd}
        onKeyDown={handleKeyDown}
        onSubmit={handleSubmit}
      >
        {children}
      </form>
    </AutoSubmitContext.Provider>
  );
}

/**
 * Search field of an `AutoSubmitForm` (uncontrolled, so typing never loses characters or focus).
 * `value` is the value from the URL: the field follows it only when the URL changed for another
 * reason (chip removal, reset link) – never while it is focused or a typing pause is pending.
 */
export function FilterSearchInput({
  value = '',
  type = 'search',
  ...props
}: Omit<ComponentProps<typeof Input>, 'value' | 'defaultValue'> & { value?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const ctx = useContext(AutoSubmitContext);
  const isDebouncing = ctx?.isDebouncing;
  useEffect(() => {
    const el = ref.current;
    if (!el || el.value === value) return;
    if (document.activeElement === el || isDebouncing?.()) return;
    el.value = value;
  }, [value, isDebouncing]);
  return <Input ref={ref} type={type} defaultValue={value} {...props} />;
}

/**
 * Submit button for browsers without JavaScript; hidden once the `AutoSubmitForm` is hydrated
 * (Enter is handled by the form then).
 */
export function AutoSubmitFallbackButton({
  className,
  variant = 'secondary',
  ...props
}: ComponentProps<typeof Button>) {
  const ctx = useContext(AutoSubmitContext);
  return (
    <Button
      type="submit"
      variant={variant}
      {...props}
      className={cn(className, ctx?.ready && 'hidden')}
      data-auto-submit-fallback=""
    />
  );
}

/** Small spinner while the filter navigation of the surrounding `AutoSubmitForm` is in flight. */
export function AutoSubmitPending({ className }: { className?: string }) {
  const ctx = useContext(AutoSubmitContext);
  // Always rendered (invisible when idle), so nothing next to it shifts while typing.
  return (
    <Loader2
      className={cn(
        'size-4 shrink-0 text-muted-foreground',
        ctx?.pending ? 'animate-spin' : 'invisible',
        className,
      )}
      aria-hidden
      data-testid={ctx?.pending ? 'auto-submit-pending' : undefined}
    />
  );
}

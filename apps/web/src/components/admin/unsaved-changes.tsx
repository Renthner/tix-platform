'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';

type DirtyCheck = () => boolean;

interface GuardRegistry {
  register: (id: string, check: DirtyCheck) => void;
  unregister: (id: string) => void;
}

const GuardContext = createContext<GuardRegistry | null>(null);

/**
 * Admin-wide "unsaved changes" guard. Editors register a dirty check through
 * `useUnsavedChangesGuard` / `useUnsavedFormGuard`; the checks run lazily when the user tries to
 * leave, so uncontrolled forms (rich-text editors) need no change tracking. While something is
 * dirty, clicks on internal links are intercepted and a confirmation dialog is shown (the App
 * Router has no route-change events, so the click is the interception point). Leaving the app
 * (reload, close tab, external link) is covered by the browser's `beforeunload` prompt.
 *
 * Not covered (by design): the browser back/forward buttons and programmatic `router.push` calls.
 */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const t = useTranslations('common.unsaved');
  const router = useRouter();
  const checks = useRef(new Map<string, DirtyCheck>());
  const [target, setTarget] = useState<string | null>(null);

  const register = useCallback(
    (id: string, check: DirtyCheck) => void checks.current.set(id, check),
    [],
  );
  const unregister = useCallback((id: string) => void checks.current.delete(id), []);
  const registry = useMemo(() => ({ register, unregister }), [register, unregister]);

  useEffect(() => {
    const anyDirty = () => [...checks.current.values()].some((check) => check());

    const onClick = (event: MouseEvent) => {
      if (checks.current.size === 0) return;
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return; // handled by beforeunload
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return; // same page / hash link
      }
      if (!anyDirty()) return;
      event.preventDefault();
      event.stopPropagation();
      setTarget(`${url.pathname}${url.search}${url.hash}`);
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (checks.current.size === 0 || !anyDirty()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    // Capture phase on the document: runs before the links' own (React/Next) handlers.
    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  return (
    <GuardContext.Provider value={registry}>
      {children}
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        title={t('title')}
        description={t('description')}
        cancelLabel={t('stay')}
        confirmLabel={t('leave')}
        onConfirm={() => {
          // The dirty editor unmounts with the navigation; nothing else to clear.
          if (target) router.push(target as Parameters<typeof router.push>[0]);
        }}
      />
    </GuardContext.Provider>
  );
}

/**
 * Warns before the user loses unsaved work (see `UnsavedChangesProvider`). Pass the dirty flag
 * of a state-driven editor; it must turn false again after a successful save.
 */
export function useUnsavedChangesGuard(isDirty: boolean): void {
  const id = useId();
  const registry = useContext(GuardContext);
  const dirty = useRef(isDirty);
  useEffect(() => {
    dirty.current = isDirty;
  }, [isDirty]);
  useEffect(() => {
    registry?.register(id, () => dirty.current);
    return () => registry?.unregister(id);
  }, [id, registry]);
}

function snapshot(form: HTMLFormElement): string {
  const entries: [string, string][] = [];
  for (const [key, value] of new FormData(form)) {
    entries.push([key, typeof value === 'string' ? value : `file:${value.name}:${value.size}`]);
  }
  return JSON.stringify(entries);
}

/**
 * Guard for uncontrolled forms: dirty while the form's data differs from the snapshot taken when
 * the form was first shown or last saved. Pass the form's action state; a new `success` result
 * adopts the current data as the saved baseline.
 */
export function useUnsavedFormGuard(
  formRef: RefObject<HTMLFormElement | null>,
  state?: { status: string; at?: number },
  enabled = true,
): void {
  const id = useId();
  const registry = useContext(GuardContext);
  const baseline = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    // Editors (TipTap) render their hidden field after mount: baseline once things settled.
    const timer = window.setTimeout(() => {
      if (formRef.current && baseline.current === null)
        baseline.current = snapshot(formRef.current);
    }, 300);
    registry?.register(id, () => {
      const form = formRef.current;
      return !!form && baseline.current !== null && snapshot(form) !== baseline.current;
    });
    return () => {
      window.clearTimeout(timer);
      registry?.unregister(id);
    };
  }, [id, registry, formRef, enabled]);
  const successAt = state?.status === 'success' ? (state.at ?? 0) : null;
  useEffect(() => {
    if (successAt !== null && formRef.current) baseline.current = snapshot(formRef.current);
  }, [successAt, formRef]);
}

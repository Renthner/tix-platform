'use client';

import type { WaitlistCategoryState } from '@tix/shared';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * Bridge between the seating plan (which owns the live inventory) and the waiting-list block of
 * the event page (a separate island): the plan publishes per-category ticket counts, the block
 * reads them. No extra requests – the counts derive from the seat deltas the plan receives anyway.
 */

const snapshots = new Map<string, readonly WaitlistCategoryState[]>();
const watchers = new Map<string, number>();
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const sameStates = (a: readonly WaitlistCategoryState[], b: readonly WaitlistCategoryState[]) =>
  a.length === b.length &&
  a.every((s, i) => {
    const o = b[i]!;
    return s.id === o.id && s.capacity === o.capacity && s.free === o.free && s.held === o.held;
  });

/** Called by the seating plan with the current counts; unchanged counts cause no re-render. */
export function publishWaitlistStates(
  eventId: string,
  states: readonly WaitlistCategoryState[],
): void {
  const previous = snapshots.get(eventId);
  if (previous && sameStates(previous, states)) return;
  snapshots.set(eventId, states);
  emit();
}

/** Live counts of an event, null until the seating plan published them. */
export function useLiveWaitlistStates(eventId: string): readonly WaitlistCategoryState[] | null {
  // Registers the block as a reader so the plan only computes while somebody listens.
  useEffect(() => {
    watchers.set(eventId, (watchers.get(eventId) ?? 0) + 1);
    emit();
    return () => {
      const left = (watchers.get(eventId) ?? 1) - 1;
      if (left <= 0) {
        watchers.delete(eventId);
        snapshots.delete(eventId);
      } else watchers.set(eventId, left);
      emit();
    };
  }, [eventId]);
  return useSyncExternalStore(
    subscribe,
    () => snapshots.get(eventId) ?? null,
    () => null,
  );
}

/** Whether a waiting-list block listens for this event (the plan computes counts only then). */
export function useWaitlistWatched(eventId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (watchers.get(eventId) ?? 0) > 0,
    () => false,
  );
}

'use client';

import {
  decideWaitlistOffer,
  type WaitlistCategoryState,
  type WaitlistDecision,
  type WaitlistTrigger,
} from '@tix/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveWaitlistStates } from '@/lib/waitlist-live';
import { WaitlistCard } from './waitlist-card';

/** Show/hide changes are applied after this pause so churning cart locks do not make it flicker. */
const SETTLE_MS = 1_500;
/** After the visitor leaves the form empty, changes are held back for this long. */
const RELEASE_MS = 4_000;

export interface WaitlistBlockProps {
  eventId: string;
  trigger: WaitlistTrigger;
  maxTickets: number;
  /** Categories with their counts at render time (names for the form, counts until live data). */
  categories: (WaitlistCategoryState & { name: string })[];
}

/**
 * Waiting-list block of the event page. Whether it shows is decided from the ticket counts: those
 * of the server render first, then the live counts the seating plan derives from the realtime
 * seat deltas. Visitors waiting in the queue (no plan mounted yet) see the server state.
 */
export function WaitlistBlock({ eventId, trigger, maxTickets, categories }: WaitlistBlockProps) {
  const live = useLiveWaitlistStates(eventId);
  const names = useMemo(
    () => new Map(categories.map((c) => [c.id, c.name] as const)),
    [categories],
  );
  const target = useMemo(
    () => decideWaitlistOffer(live ?? categories, trigger),
    [live, categories, trigger],
  );
  const targetKey = target ? `${target.soldOut}:${target.categoryIds.join(',')}` : '';

  const [shown, setShown] = useState<WaitlistDecision | null>(target);
  const shownKey = shown ? `${shown.soldOut}:${shown.categoryIds.join(',')}` : '';
  const submitted = useRef(false);

  // While the visitor is typing (focus inside, or something entered) the card stays exactly as it
  // is: it must not vanish or change its category list under their hands.
  const wrapper = useRef<HTMLDivElement>(null);
  const [engaged, setEngaged] = useState(false);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isEngaged = () => {
    const el = wrapper.current;
    if (!el) return false;
    const typed = Array.from(
      el.querySelectorAll<HTMLInputElement>('input[name="email"], input[name="firstName"]'),
    ).some((input) => input.value.trim() !== '');
    return typed || el.contains(document.activeElement);
  };
  const engage = () => {
    if (releaseTimer.current) clearTimeout(releaseTimer.current);
    releaseTimer.current = null;
    setEngaged(true);
  };
  const maybeRelease = () => {
    if (releaseTimer.current) clearTimeout(releaseTimer.current);
    releaseTimer.current = setTimeout(() => setEngaged(isEngaged()), RELEASE_MS);
  };
  useEffect(
    () => () => {
      if (releaseTimer.current) clearTimeout(releaseTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (targetKey === shownKey || engaged) return;
    const timer = setTimeout(() => setShown(target), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [target, targetKey, shownKey, engaged]);

  // After signing up the confirmation stays visible even if tickets turn up in the meantime.
  const [lastShown, setLastShown] = useState<WaitlistDecision | null>(null);
  useEffect(() => {
    if (shown) setLastShown(shown);
  }, [shown]);
  const decision = shown ?? (submitted.current ? lastShown : null);
  if (!decision) return null;

  return (
    <div ref={wrapper} onFocus={engage} onInput={engage} onBlur={maybeRelease}>
      <WaitlistCard
        eventId={eventId}
        soldOut={decision.soldOut}
        categories={decision.categoryIds
          .map((id) => ({ id, name: names.get(id) ?? '' }))
          .filter((c) => c.name)}
        maxTickets={maxTickets}
        onSubmitted={() => {
          submitted.current = true;
          // sent: the confirmation stays, nothing left to protect
          setEngaged(false);
        }}
      />
    </div>
  );
}

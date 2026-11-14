'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useState, type CSSProperties } from 'react';
import { MediaImage } from '@/components/media-image';
import { cn } from '@/lib/utils';

export interface SponsorView {
  id: string;
  assetId: string;
  width: number | null;
  height: number | null;
  alt: string;
  /** https URL or shop path; opens in a new tab. */
  href?: string;
  /** How long this sponsor stays visible (seconds). */
  seconds: number;
}

/**
 * Sponsors directly next to the logo (phones and desktop alike; the nav and the controls follow): one visible at a time, cross-fading to the next after its own
 * duration. Pauses while hovered or focused; with `prefers-reduced-motion` nothing rotates by
 * itself (previous / next buttons instead). The first sponsor is rendered by the server, so the
 * banner is complete without JavaScript. Not a live region: rotation is never announced.
 */
export function HeaderSponsors({
  items,
  height,
  label,
  regionLabel,
  previousLabel,
  nextLabel,
}: {
  items: SponsorView[];
  /** Banner height in px (phones scale it down in CSS). */
  height: number;
  /** Visible text before the banner (may be empty). */
  label: string;
  /** Accessible name of the region when there is no visible label. */
  regionLabel: string;
  previousLabel: string;
  nextLabel: string;
}) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const count = items.length;

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const active = count > 0 ? index % count : 0;
  useEffect(() => {
    if (count < 2 || paused || reduced) return;
    const timer = window.setTimeout(
      () => setIndex((active + 1) % count),
      Math.max(1, items[active]?.seconds ?? 5) * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [active, count, items, paused, reduced]);

  if (count === 0) return null;
  const step = (delta: number) => setIndex((active + delta + count) % count);

  return (
    <section
      aria-label={label || regionLabel}
      aria-live="off"
      data-testid="header-sponsors"
      className="flex min-w-0 items-center gap-2"
      style={{ '--tix-h': `${height}px` } as CSSProperties}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false);
      }}
    >
      {label && (
        <span className="hidden shrink-0 text-xs text-muted-foreground md:inline" aria-hidden>
          {label}
        </span>
      )}
      {reduced && count > 1 && (
        <button
          type="button"
          onClick={() => step(-1)}
          aria-label={previousLabel}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent"
        >
          <ChevronLeft className="size-4" aria-hidden />
        </button>
      )}
      <div className="grid min-w-0 items-center justify-items-center">
        {items.map((item, i) => {
          const isActive = i === active;
          const image = (
            <MediaImage
              assetId={item.assetId}
              alt={item.alt}
              width={item.width}
              height={item.height}
              sizes={
                item.width && item.height
                  ? `${Math.ceil((height * item.width) / item.height)}px`
                  : '200px'
              }
              loading={i === 0 ? 'eager' : 'lazy'}
              className="tix-header-image w-auto max-w-full object-contain"
            />
          );
          return (
            <div
              key={item.id}
              data-active={isActive ? 'true' : 'false'}
              aria-hidden={isActive ? undefined : true}
              inert={!isActive}
              className={cn(
                'col-start-1 row-start-1 flex max-w-full min-w-0 items-center transition-opacity duration-500 motion-reduce:transition-none',
                isActive ? 'opacity-100' : 'pointer-events-none opacity-0',
              )}
            >
              {item.href ? (
                <a
                  href={item.href}
                  target="_blank"
                  rel="noopener sponsored"
                  className="flex min-w-0 rounded-sm"
                >
                  {image}
                </a>
              ) : (
                image
              )}
            </div>
          );
        })}
      </div>
      {reduced && count > 1 && (
        <button
          type="button"
          onClick={() => step(1)}
          aria-label={nextLabel}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent"
        >
          <ChevronRight className="size-4" aria-hidden />
        </button>
      )}
    </section>
  );
}

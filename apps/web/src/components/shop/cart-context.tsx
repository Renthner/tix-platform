'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { CartView } from '@tix/core';
import { useLocale } from 'next-intl';
import { apiFetch } from '@/lib/api';

/** The reservation ran out while the visitor was on the page (seats are released). */
export interface CartExpiry {
  /** Slug of the last event in the cart (link back to it), null when unknown. */
  eventSlug: string | null;
}

interface CartContextValue {
  cart: CartView | null;
  /** Re-fetches the cart (after locking/releasing seats or changing tariffs). */
  refresh: () => Promise<CartView | null>;
  /** Set when the cart timer ran out with items in the cart; stays until dismissed. */
  expired: CartExpiry | null;
  dismissExpired: () => void;
}

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [cart, setCart] = useState<CartView | null>(null);
  const [expired, setExpired] = useState<CartExpiry | null>(null);
  const locale = useLocale();
  const lastEventSlug = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await apiFetch<CartView>(`/api/cart?locale=${locale}`);
      if (next.events.length > 0) lastEventSlug.current = next.events.at(-1)?.slug ?? null;
      setCart(next);
      // Items in the cart again: an older expiry notice is obsolete.
      if (next.itemCount > 0) setExpired(null);
      return next;
    } catch {
      return null;
    }
  }, [locale]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Drop the cart locally once it expired (server cleans up on next access).
  useEffect(() => {
    if (!cart?.expiresAt) return;
    const hadItems = cart.itemCount > 0;
    const timeout = setTimeout(
      () => {
        void refresh().then((next) => {
          // Still reserved (e.g. extended for the checkout meanwhile): no notice.
          if (hadItems && next && next.itemCount === 0) {
            setExpired({ eventSlug: lastEventSlug.current });
          }
        });
      },
      Math.max(0, cart.expiresAt - Date.now()) + 500,
    );
    return () => clearTimeout(timeout);
  }, [cart?.expiresAt, cart?.itemCount, refresh]);

  const dismissExpired = useCallback(() => setExpired(null), []);
  const value = useMemo(
    () => ({ cart, refresh, expired, dismissExpired }),
    [cart, refresh, expired, dismissExpired],
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used inside <CartProvider>');
  return ctx;
}

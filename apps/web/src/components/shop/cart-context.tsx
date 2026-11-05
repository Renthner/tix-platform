'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { CartView } from '@tix/core';
import { apiFetch } from '@/lib/api';

interface CartContextValue {
  cart: CartView | null;
  /** Re-fetches the cart (after locking/releasing seats or changing tariffs). */
  refresh: () => Promise<CartView | null>;
}

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [cart, setCart] = useState<CartView | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await apiFetch<CartView>('/api/cart');
      setCart(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Drop the cart locally once it expired (server cleans up on next access).
  useEffect(() => {
    if (!cart?.expiresAt) return;
    const timeout = setTimeout(
      () => void refresh(),
      Math.max(0, cart.expiresAt - Date.now()) + 500,
    );
    return () => clearTimeout(timeout);
  }, [cart?.expiresAt, refresh]);

  const value = useMemo(() => ({ cart, refresh }), [cart, refresh]);
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used inside <CartProvider>');
  return ctx;
}

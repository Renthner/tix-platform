'use client';

import { createContext, useContext, useEffect } from 'react';

/**
 * Set by a dialog host (e.g. the order page's action dialogs): a form inside reports while its
 * server action is running, so the dialog cannot be closed (Escape, overlay, X) mid-request.
 */
export const ActionPendingContext = createContext<((pending: boolean) => void) | null>(null);

/** Reports `pending` to the surrounding dialog host (no-op outside one); `false` on unmount. */
export function useReportActionPending(pending: boolean) {
  const report = useContext(ActionPendingContext);
  useEffect(() => {
    if (!report) return;
    report(pending);
    return () => report(false);
  }, [report, pending]);
}

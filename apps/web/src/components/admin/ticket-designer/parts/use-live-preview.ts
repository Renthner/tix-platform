'use client';

import { useLocale } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { Draft } from './types';

/** Server-rendered PDF preview of the current draft (same renderer as real tickets). */
export function useLivePreview(
  draft: Draft,
  draftRef: MutableRefObject<Draft>,
  initialEventId: string | null,
) {
  const locale = useLocale();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [autoPreview, setAutoPreview] = useState(true);
  const [previewEvent, setPreviewEvent] = useState<string>(initialEventId ?? '');
  const previewSeq = useRef(0);

  const refreshPreview = useCallback(async () => {
    const seq = (previewSeq.current += 1);
    setPreviewBusy(true);
    setPreviewError(false);
    try {
      const d = draftRef.current;
      const res = await fetch('/api/admin/ticket-templates/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pageWidthMm: d.pageWidthMm,
          pageHeightMm: d.pageHeightMm,
          backgroundAssetId: d.background?.id ?? null,
          layout: d.layout,
          eventId: previewEvent || null,
          locale: locale === 'de' ? 'de' : 'en',
        }),
      });
      if (!res.ok) throw new Error('preview');
      const blob = await res.blob();
      if (seq !== previewSeq.current) return;
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(blob);
      });
    } catch {
      if (seq === previewSeq.current) setPreviewError(true);
    } finally {
      if (seq === previewSeq.current) setPreviewBusy(false);
    }
  }, [locale, previewEvent, draftRef]);

  useEffect(() => {
    if (!autoPreview) return;
    const timer = setTimeout(() => void refreshPreview(), 900);
    return () => clearTimeout(timer);
  }, [draft, autoPreview, refreshPreview]);

  useEffect(
    () => () => {
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
    },
    [],
  );

  return {
    previewUrl,
    previewBusy,
    previewError,
    autoPreview,
    setAutoPreview,
    previewEvent,
    setPreviewEvent,
    refreshPreview,
  };
}

'use client';

import { Share2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

/**
 * Shares the page (Web Share API where the browser offers it, otherwise copies the link). The
 * link is the page address without query / hash, so access codes never leak into a shared URL.
 */
export function ShareButton({ title, className }: { title: string; className?: string }) {
  const t = useTranslations('shop.share');

  const share = async () => {
    const url = `${window.location.origin}${window.location.pathname}`;
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, url });
        return;
      } catch (err) {
        // The visitor closed the share sheet: nothing to do. Other errors fall back to copying.
        if (err instanceof DOMException && err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('copied'));
    } catch {
      toast.error(t('failed'));
    }
  };

  return (
    <button
      type="button"
      onClick={() => void share()}
      className={
        className ??
        'flex items-center gap-2 underline-offset-4 hover:text-foreground hover:underline'
      }
    >
      <Share2 className="size-4" aria-hidden />
      {t('button')}
    </button>
  );
}

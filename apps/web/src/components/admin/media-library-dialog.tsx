'use client';

import type { MediaVisibility } from '@tix/shared';
import { Images } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { formatBytes } from '@/lib/bytes';
import type { MediaListResponse } from '@/app/api/admin/media/route';
import type { MediaPickerAsset } from './media-picker';

type LibraryItem = MediaListResponse['items'][number];

/**
 * "Choose from library" action of the media picker: searchable, paginated grid of existing
 * assets that are allowed in the given context (server-filtered, validated again on save).
 */
export function MediaLibraryDialog({
  visibility,
  disabled,
  onSelect,
}: {
  visibility: MediaVisibility;
  disabled?: boolean;
  onSelect: (asset: MediaPickerAsset) => void;
}) {
  const t = useTranslations('admin.media.library');
  const tk = useTranslations('admin.mediaLibrary.kinds');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<MediaListResponse | null>(null);
  const [failed, setFailed] = useState(false);

  // Debounce the search input.
  useEffect(() => {
    const id = setTimeout(() => {
      setTerm(search.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ visibility, page: String(page) });
    if (term) params.set('q', term);
    setFailed(false);
    fetch(`/api/admin/media?${params}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        setData((await res.json()) as MediaListResponse);
      })
      .catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === 'AbortError')) setFailed(true);
      });
    return () => controller.abort();
  }, [open, visibility, term, page]);

  const lastPage = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const pick = (item: LibraryItem) => {
    onSelect({
      id: item.id,
      fileName: item.fileName,
      width: item.width,
      height: item.height,
      sizeBytes: item.sizeBytes,
    });
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          <Images className="size-4" aria-hidden />
          {t('open')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {visibility === 'public' ? t('descriptionPublic') : t('descriptionPrivate')}
          </DialogDescription>
        </DialogHeader>
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('search')}
          aria-label={t('search')}
        />
        {failed && (
          <p role="alert" className="text-sm text-destructive">
            {t('error')}
          </p>
        )}
        {data && data.items.length === 0 && !failed && (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        )}
        {data && data.items.length > 0 && (
          <ul className="grid max-h-[55vh] grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3 md:grid-cols-4">
            {data.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => pick(item)}
                  className="flex h-full w-full flex-col overflow-hidden rounded-lg border bg-card text-left hover:border-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="flex h-24 items-center justify-center bg-muted/40">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/media/${item.id}`}
                      alt=""
                      loading="lazy"
                      className="max-h-full max-w-full object-contain"
                    />
                  </span>
                  <span className="space-y-0.5 p-2 text-xs">
                    <span className="block font-medium break-all">{item.fileName}</span>
                    <span className="block text-muted-foreground">
                      {tk(item.kind)} · {formatBytes(item.sizeBytes)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {data && lastPage > 1 && (
          <div className="flex items-center justify-between text-sm">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              {t('previous')}
            </Button>
            <span className="text-muted-foreground">{t('page', { page, total: lastPage })}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page >= lastPage}
              onClick={() => setPage((p) => p + 1)}
            >
              {t('next')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

'use client';

import { ImagePlus, Trash2, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState, type DragEvent } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { isPublicMediaKind, type MediaAssetKind, type MediaVisibility } from '@tix/shared';
import { MediaLibraryDialog } from './media-library-dialog';

/** Subset of the upload response / stored asset the picker needs for its preview. */
export interface MediaPickerAsset {
  id: string;
  fileName: string;
  width: number | null;
  height: number | null;
  sizeBytes?: number;
}

const ACCEPT = 'image/png,image/jpeg,image/webp';
const ERROR_CODES = [
  'MEDIA_EMPTY',
  'MEDIA_TOO_LARGE',
  'MEDIA_UNSUPPORTED_TYPE',
  'MEDIA_DIMENSIONS',
  'FILE_REQUIRED',
  'KIND_INVALID',
  'FORBIDDEN',
] as const;

export interface MediaPickerProps {
  /** Name of the hidden input that carries the asset id ('' when none) into the surrounding form. */
  name: string;
  /** Media kind the upload is stored as (decides public / private delivery). */
  kind: MediaAssetKind;
  /**
   * Where the picked image ends up: `public` (shown in the shop - only public library assets are
   * offered) or `private` (admin / generators only - any library image). Defaults to the
   * visibility of `kind`.
   */
  visibility?: MediaVisibility;
  /** Currently stored asset (id + meta for the preview) or null. */
  initialAsset?: MediaPickerAsset | null;
  /** Fixed preview frame aspect ratio, width / height. Omit to show the image at its natural ratio (max. 18rem high) inside a neutral frame; the empty drop zone is 16 / 9. */
  aspectRatio?: number;
  /** Tailwind max-width class of the preview (default `max-w-sm`). */
  previewClassName?: string;
  /** Fit inside the frame (`contain`, default) or fill it (`cover`). */
  fit?: 'contain' | 'cover';
  /** Alt text of the preview image. */
  previewAlt?: string;
  disabled?: boolean;
  /** Called after a successful upload or removal. */
  onChange?: (asset: MediaPickerAsset | null) => void;
}

/**
 * Image upload field for admin forms: preview, drag & drop / file input (uploads immediately
 * to `POST /api/admin/media`), replace and remove. The selected asset id is written into a
 * hidden input, so it works inside any `<ActionForm>`; the form action stores the reference.
 */
export function MediaPicker({
  name,
  kind,
  visibility = isPublicMediaKind(kind) ? 'public' : 'private',
  initialAsset = null,
  aspectRatio,
  previewClassName = 'max-w-sm',
  fit = 'contain',
  previewAlt = '',
  disabled = false,
  onChange,
}: MediaPickerProps) {
  const t = useTranslations('admin.media');
  const inputId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [asset, setAsset] = useState<MediaPickerAsset | null>(initialAsset);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (files: FileList | File[] | null) => {
    const file = files?.[0];
    if (!file || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.set('kind', kind);
      body.set('file', file);
      const res = await fetch('/api/admin/media', { method: 'POST', body });
      const json = (await res.json().catch(() => null)) as
        { asset: MediaPickerAsset } | { error: { code: string } } | null;
      if (!res.ok || !json || 'error' in json) {
        const code = json && 'error' in json ? json.error.code : '';
        setError(
          (ERROR_CODES as readonly string[]).includes(code)
            ? t(`errors.${code as (typeof ERROR_CODES)[number]}`)
            : t('errors.generic'),
        );
      } else {
        setAsset(json.asset);
        onChange?.(json.asset);
      }
    } catch {
      setError(t('errors.generic'));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const remove = () => {
    setAsset(null);
    setError(null);
    onChange?.(null);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    void upload(e.dataTransfer.files);
  };

  return (
    <div className="space-y-2">
      <input type="hidden" name={name} value={asset?.id ?? ''} />
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        style={aspectRatio || !asset ? { aspectRatio: aspectRatio ?? 16 / 9 } : undefined}
        className={cn(
          'relative flex w-full items-center justify-center overflow-hidden rounded-md border border-dashed bg-muted/30',
          previewClassName,
          dragging && 'border-primary bg-primary/5',
          busy && 'opacity-60',
        )}
      >
        {asset ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/media/${asset.id}`}
            alt={previewAlt}
            width={asset.width ?? undefined}
            height={asset.height ?? undefined}
            className={cn(
              aspectRatio ? 'size-full' : 'h-auto max-h-72 w-full',
              fit === 'cover' ? 'object-cover' : 'object-contain',
            )}
          />
        ) : (
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => fileInput.current?.click()}
            className="flex size-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground hover:text-foreground"
          >
            <ImagePlus className="size-6" aria-hidden />
            {t('dropHint')}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          id={inputId}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          disabled={disabled || busy}
          onChange={(e) => void upload(e.target.files)}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || busy}
          onClick={() => fileInput.current?.click()}
        >
          <Upload className="size-4" aria-hidden />
          {busy ? t('uploading') : asset ? t('replace') : t('upload')}
        </Button>
        <MediaLibraryDialog
          visibility={visibility}
          disabled={disabled || busy}
          onSelect={(picked) => {
            setAsset(picked);
            setError(null);
            onChange?.(picked);
          }}
        />
        {asset && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || busy}
            onClick={remove}
          >
            <Trash2 className="size-4" aria-hidden />
            {t('remove')}
          </Button>
        )}
        {asset && (
          <span className="text-xs text-muted-foreground">
            {asset.fileName}
            {asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ''}
          </span>
        )}
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

'use client';

import { RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import type { DesignerEventOption } from './types';

/** Live PDF preview card (data source picker, auto toggle, iframe). */
export function PreviewCard({
  eventId,
  events,
  previewEvent,
  setPreviewEvent,
  autoPreview,
  setAutoPreview,
  previewUrl,
  previewBusy,
  previewError,
  refreshPreview,
}: {
  eventId: string | null;
  events: DesignerEventOption[];
  previewEvent: string;
  setPreviewEvent: (id: string) => void;
  autoPreview: boolean;
  setAutoPreview: (value: boolean) => void;
  previewUrl: string | null;
  previewBusy: boolean;
  previewError: boolean;
  refreshPreview: () => Promise<void>;
}) {
  const t = useTranslations('ticketDesigner');
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 pb-2">
        <CardTitle className="text-base">{t('preview.title')}</CardTitle>
        <div className="flex flex-wrap items-center gap-3">
          {!eventId && events.length > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t('preview.data')}</span>
              <select
                className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                value={previewEvent}
                onChange={(e) => setPreviewEvent(e.target.value)}
              >
                <option value="">{t('preview.sample')}</option>
                {events.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={autoPreview} onCheckedChange={setAutoPreview} />
            {t('preview.auto')}
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refreshPreview()}
            disabled={previewBusy}
          >
            <RefreshCw className={previewBusy ? 'size-4 animate-spin' : 'size-4'} />
            {t('preview.refresh')}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {previewError && <p className="mb-2 text-sm text-destructive">{t('preview.error')}</p>}
        <p className="mb-2 text-xs text-muted-foreground">{t('preview.hint')}</p>
        {previewUrl ? (
          <iframe
            title={t('preview.title')}
            src={`${previewUrl}#toolbar=0&navpanes=0`}
            className="h-[34rem] w-full rounded-md border bg-muted/30"
          />
        ) : (
          <div className="flex h-40 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
            {previewBusy ? t('preview.loading') : t('preview.empty')}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

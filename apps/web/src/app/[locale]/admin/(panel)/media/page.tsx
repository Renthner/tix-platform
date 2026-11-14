import {
  listMediaAssets,
  listUnusedMediaAssets,
  mediaAssetUsagesBatch,
  mediaSummary,
} from '@tix/core';
import { MEDIA_ASSET_KINDS, parsePage, type MediaAssetKind } from '@tix/shared';
import { Shapes } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { NativeSelect, PageHeader } from '@/components/admin/form-controls';
import {
  BulkDeleteDialog,
  MediaGrid,
  MediaUploadForm,
  SweepOrphansButton,
} from '@/components/admin/media-library';
import { formatBytes } from '@/lib/bytes';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import {
  bulkDeleteMediaAction,
  deleteMediaAction,
  renameMediaAction,
  sweepMediaOrphansAction,
} from '@/server/admin/media';

export async function generateMetadata() {
  const t = await getTranslations('admin.mediaLibrary');
  return { title: t('title') };
}

/** Generated documents are not part of the media library. */
const LIBRARY_KINDS = MEDIA_ASSET_KINDS.filter((k) => k !== 'DOCUMENT');
const PAGE_SIZE = 24;

type Search = {
  kind?: string;
  usage?: string;
  q?: string;
  sort?: string;
  dir?: string;
  page?: string;
};

export default async function MediaPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Search>;
}) {
  await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER']);
  const sp = await searchParams;
  const kind = (LIBRARY_KINDS as readonly string[]).includes(sp.kind ?? '')
    ? (sp.kind as MediaAssetKind)
    : undefined;
  const usage = sp.usage === 'used' || sp.usage === 'unused' ? sp.usage : undefined;
  const sort = sp.sort === 'size' ? 'size' : 'date';
  const dir = sp.dir === 'asc' ? 'asc' : 'desc';
  const search = sp.q?.trim().slice(0, 100) || undefined;
  const pageNo = parsePage(sp.page);

  const core = getCore();
  const [t, list, summary, unused] = await Promise.all([
    getTranslations('admin.mediaLibrary'),
    listMediaAssets(core, { kind, usage, search, sort, dir, page: pageNo, pageSize: PAGE_SIZE }),
    mediaSummary(core),
    listUnusedMediaAssets(core, { kind }),
  ]);
  const usages = await mediaAssetUsagesBatch(
    core,
    list.items.map((i) => i.id),
  );

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button asChild variant="outline">
            <Link href="/admin/symbols">
              <Shapes /> {t('toSymbols')}
            </Link>
          </Button>
        }
      />
      <div className="space-y-6 p-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <Stat label={t('summary.total')} value={String(summary.count)} />
          <Stat label={t('summary.totalSize')} value={formatBytes(summary.bytes)} />
          <Stat label={t('summary.variantSize')} value={formatBytes(summary.variantBytes)} />
          <Stat label={t('summary.unused')} value={String(summary.unusedCount)} />
          <Stat label={t('summary.unusedSize')} value={formatBytes(summary.unusedBytes)} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{t('uploadTitle')}</CardTitle>
            <CardDescription>{t('uploadDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <MediaUploadForm kinds={LIBRARY_KINDS} defaultKind={kind ?? 'EVENT_IMAGE'} />
          </CardContent>
        </Card>

        <form className="flex flex-wrap items-end gap-3" role="search">
          <div className="space-y-1">
            <label htmlFor="f-q" className="text-xs text-muted-foreground">
              {t('search')}
            </label>
            <Input id="f-q" name="q" defaultValue={search} placeholder={t('searchPlaceholder')} />
          </div>
          <div className="space-y-1">
            <label htmlFor="f-kind" className="text-xs text-muted-foreground">
              {t('kind')}
            </label>
            <NativeSelect id="f-kind" name="kind" defaultValue={kind ?? ''}>
              <option value="">{t('filterAll')}</option>
              {LIBRARY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`kinds.${k}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <label htmlFor="f-usage" className="text-xs text-muted-foreground">
              {t('usageFilter')}
            </label>
            <NativeSelect id="f-usage" name="usage" defaultValue={usage ?? ''}>
              <option value="">{t('filterAll')}</option>
              <option value="used">{t('filterUsed')}</option>
              <option value="unused">{t('filterUnused')}</option>
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <label htmlFor="f-sort" className="text-xs text-muted-foreground">
              {t('sort')}
            </label>
            <NativeSelect id="f-sort" name="sort" defaultValue={sort}>
              <option value="date">{t('sortDate')}</option>
              <option value="size">{t('sortSize')}</option>
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <label htmlFor="f-dir" className="text-xs text-muted-foreground">
              {t('direction')}
            </label>
            <NativeSelect id="f-dir" name="dir" defaultValue={dir}>
              <option value="desc">{t('dirDesc')}</option>
              <option value="asc">{t('dirAsc')}</option>
            </NativeSelect>
          </div>
          <Button type="submit">{t('apply')}</Button>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{t('results', { count: list.total })}</p>
          <div className="flex flex-wrap gap-2">
            <BulkDeleteDialog
              items={unused.items.map((i) => ({
                id: i.id,
                fileName: i.fileName,
                kind: i.kind,
                sizeBytes: i.sizeBytes,
              }))}
              total={unused.total}
              action={bulkDeleteMediaAction.bind(
                null,
                unused.items.map((i) => i.id),
              )}
            />
            <SweepOrphansButton action={sweepMediaOrphansAction} />
          </div>
        </div>

        <MediaGrid
          items={list.items.map((m) => ({
            id: m.id,
            kind: m.kind,
            fileName: m.fileName,
            width: m.width,
            height: m.height,
            sizeBytes: m.sizeBytes,
            sha256: m.sha256,
            createdAt: m.createdAt.toISOString(),
            uploadedByName: m.uploadedByName,
            usages: usages.get(m.id) ?? [],
            rename: renameMediaAction.bind(null, m.id),
            remove: deleteMediaAction.bind(null, m.id),
          }))}
        />

        <AdminPagination
          pathname="/admin/media"
          params={{ kind, usage, q: search, sort, dir }}
          page={list.page}
          pageSize={list.pageSize}
          total={list.total}
          className="justify-center"
        />
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}

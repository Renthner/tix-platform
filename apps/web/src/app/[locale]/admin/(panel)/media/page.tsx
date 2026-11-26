import {
  listMediaAssets,
  listUnusedMediaAssets,
  mediaAssetUsagesBatch,
  mediaSummary,
} from '@tix/core';
import { MEDIA_ASSET_KINDS, buildQuery, parsePage, type MediaAssetKind } from '@tix/shared';
import { Shapes } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { FilterSelect } from '@/components/admin/filter-select';
import {
  ListToolbar,
  MoreFilterField,
  type ActiveFilterChip,
} from '@/components/admin/list-toolbar';
import { AdminPageHeader } from '@/components/admin/page-header';
import { hubBreadcrumbs } from '@/server/admin/breadcrumbs';
import {
  BulkDeleteDialog,
  MediaGrid,
  MediaUploadForm,
  SweepOrphansButton,
} from '@/components/admin/media-library';
import { formatBytes } from '@/lib/bytes';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
  const [t, tl, list, summary, unused] = await Promise.all([
    getTranslations('admin.mediaLibrary'),
    getTranslations('admin.list'),
    listMediaAssets(core, { kind, usage, search, sort, dir, page: pageNo, pageSize: PAGE_SIZE }),
    mediaSummary(core),
    listUnusedMediaAssets(core, { kind }),
  ]);
  const usages = await mediaAssetUsagesBatch(
    core,
    list.items.map((i) => i.id),
  );

  // Active filters as removable chips; sorting stays when filters are reset.
  const base = '/admin/media';
  const listParams = {
    kind,
    usage,
    q: search,
    sort: sort === 'date' ? undefined : sort,
    dir: dir === 'desc' ? undefined : dir,
  };
  const without = (overrides: Record<string, string | undefined>) =>
    buildQuery(base, listParams, overrides);
  const chips: ActiveFilterChip[] = [];
  if (search) {
    chips.push({
      key: 'q',
      label: tl('searchChip', { value: search }),
      removeHref: without({ q: undefined }),
    });
  }
  if (kind) {
    chips.push({
      key: 'kind',
      label: `${t('kind')}: ${t(`kinds.${kind}`)}`,
      removeHref: without({ kind: undefined }),
    });
  }
  if (usage) {
    chips.push({
      key: 'usage',
      label: `${t('usageFilter')}: ${usage === 'used' ? t('filterUsed') : t('filterUnused')}`,
      removeHref: without({ usage: undefined }),
    });
  }
  const resetHref =
    chips.length > 0 ? buildQuery(base, { sort: listParams.sort, dir: listParams.dir }) : null;
  const moreActiveCount = [listParams.sort, listParams.dir].filter(Boolean).length;
  const wideSelect = '[&_select]:max-w-none [&_select]:w-full';

  return (
    <>
      <AdminPageHeader
        breadcrumbs={await hubBreadcrumbs('design')}
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

        <ListToolbar
          data-testid="media-toolbar"
          search={{ value: search, placeholder: t('searchPlaceholder'), label: t('search') }}
          filters={
            <>
              <FilterSelect
                name="kind"
                value={kind}
                ariaLabel={t('kind')}
                allLabel={`${t('kind')}: ${t('filterAll')}`}
                searchable={false}
                options={LIBRARY_KINDS.map((k) => ({ value: k, label: t(`kinds.${k}`) }))}
              />
              <FilterSelect
                name="usage"
                value={usage}
                ariaLabel={t('usageFilter')}
                allLabel={`${t('usageFilter')}: ${t('filterAll')}`}
                searchable={false}
                options={[
                  { value: 'used', label: t('filterUsed') },
                  { value: 'unused', label: t('filterUnused') },
                ]}
              />
            </>
          }
          moreActiveCount={moreActiveCount}
          moreFilters={
            <>
              <MoreFilterField label={t('sort')}>
                <FilterSelect
                  name="sort"
                  value={sort}
                  ariaLabel={t('sort')}
                  searchable={false}
                  className={wideSelect}
                  options={[
                    { value: 'date', label: t('sortDate') },
                    { value: 'size', label: t('sortSize') },
                  ]}
                />
              </MoreFilterField>
              <MoreFilterField label={t('direction')}>
                <FilterSelect
                  name="dir"
                  value={dir}
                  ariaLabel={t('direction')}
                  searchable={false}
                  className={wideSelect}
                  options={[
                    { value: 'desc', label: t('dirDesc') },
                    { value: 'asc', label: t('dirAsc') },
                  ]}
                />
              </MoreFilterField>
            </>
          }
          resetHref={resetHref}
          chips={chips}
          actions={
            <>
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
            </>
          }
        />

        <p className="text-sm text-muted-foreground">{t('results', { count: list.total })}</p>

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
          params={listParams}
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

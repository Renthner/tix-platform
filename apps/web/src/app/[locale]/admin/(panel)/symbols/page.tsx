import { listSymbols } from '@tix/core';
import { SYMBOL_KINDS, type SymbolKind } from '@tix/shared';
import { Images } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { AdminPageHeader } from '@/components/admin/page-header';
import { StatusTabs } from '@/components/admin/status-tabs';
import { hubBreadcrumbs } from '@/server/admin/breadcrumbs';
import { SymbolGrid, SymbolUploadForm } from '@/components/admin/symbol-library';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { symbolUsage } from '@/server/admin/queries';
import { deleteSymbolAction, renameSymbolAction, uploadSymbolAction } from '@/server/admin/symbols';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('admin.symbols');
  return { title: t('title') };
}

export default async function SymbolsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ kind?: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER']);
  const { kind: rawKind } = await searchParams;
  const kind = (SYMBOL_KINDS as readonly string[]).includes(rawKind ?? '')
    ? (rawKind as SymbolKind)
    : undefined;
  const [t, symbols, usage] = await Promise.all([
    getTranslations('admin.symbols'),
    listSymbols(getCore().db, kind),
    symbolUsage(),
  ]);

  return (
    <>
      <AdminPageHeader
        breadcrumbs={await hubBreadcrumbs('design')}
        title={t('title')}
        description={t('description')}
        actions={
          <Button asChild variant="outline">
            <Link href="/admin/media">
              <Images /> {t('toMedia')}
            </Link>
          </Button>
        }
      />
      <div className="space-y-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('uploadTitle')}</CardTitle>
            <CardDescription>{t('uploadDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <SymbolUploadForm action={uploadSymbolAction} defaultKind={kind ?? 'SEAT'} />
          </CardContent>
        </Card>
        <StatusTabs
          label={t('kind')}
          tabs={[undefined, ...SYMBOL_KINDS].map((k) => ({
            key: k ?? 'all',
            label: k ? t(`kinds.${k}`) : t('filterAll'),
            href: k ? `/admin/symbols?kind=${k}` : '/admin/symbols',
            active: kind === k,
          }))}
        />
        <SymbolGrid
          symbols={symbols.map((s) => ({
            id: s.id,
            name: s.name,
            kind: s.kind,
            viewBox: s.viewBox,
            markup: s.markup,
            colorize: s.colorize,
            builtin: s.builtinKey !== null,
            usage: usage.get(s.id) ?? 0,
            rename: renameSymbolAction.bind(null, s.id),
            remove: s.builtinKey === null ? deleteSymbolAction.bind(null, s.id) : null,
          }))}
        />
      </div>
    </>
  );
}

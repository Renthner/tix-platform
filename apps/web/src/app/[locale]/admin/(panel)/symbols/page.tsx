import { listSymbols } from '@tix/core';
import { SYMBOL_KINDS, type SymbolKind } from '@tix/shared';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/admin/form-controls';
import { SymbolGrid, SymbolUploadForm } from '@/components/admin/symbol-library';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { cn } from '@/lib/utils';
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
      <PageHeader title={t('title')} description={t('description')} />
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
        <div className="flex flex-wrap gap-2 text-sm">
          {[undefined, ...SYMBOL_KINDS].map((k) => (
            <Link
              key={k ?? 'all'}
              href={k ? `/admin/symbols?kind=${k}` : '/admin/symbols'}
              className={cn(
                'rounded-full border px-3 py-1',
                kind === k
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'hover:bg-accent',
              )}
            >
              {k ? t(`kinds.${k}`) : t('filterAll')}
            </Link>
          ))}
        </div>
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

import { getFormatter, getTranslations } from 'next-intl/server';
import { StatementUpload } from '@/components/admin/banking/statement-upload';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { requireAdmin } from '@/server/auth';
import { listImports, uploadTargets } from '@/server/admin/banking-queries';

const PAGE_SIZE = 50;

export default async function ImportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await resolveLocale(params);
  await requireAdmin(['FINANCE']);
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const accountId = /^[0-9a-f-]{36}$/i.test(sp.account ?? '') ? sp.account : undefined;
  const [t, format, accounts, result] = await Promise.all([
    getTranslations('banking'),
    getFormatter(),
    uploadTargets(),
    listImports(page, PAGE_SIZE),
  ]);
  const pages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const date = (iso: string | null) =>
    iso ? format.dateTime(new Date(`${iso}T12:00:00Z`), { dateStyle: 'short' }) : '';
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t('imports.title')}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('imports.description')}</p>
        </CardHeader>
        <CardContent>
          <StatementUpload
            accounts={accounts.map((a) => ({ id: a.id, name: a.name, iban: a.iban }))}
            defaultAccountId={accountId}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('imports.history')}</CardTitle>
        </CardHeader>
        <CardContent>
          {result.rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('imports.empty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('imports.columns.date')}</TableHead>
                  <TableHead>{t('imports.columns.file')}</TableHead>
                  <TableHead>{t('imports.columns.source')}</TableHead>
                  <TableHead>{t('imports.columns.period')}</TableHead>
                  <TableHead className="text-right">{t('imports.columns.transactions')}</TableHead>
                  <TableHead className="text-right">{t('imports.columns.imported')}</TableHead>
                  <TableHead className="text-right">{t('imports.columns.duplicates')}</TableHead>
                  <TableHead>{t('imports.columns.status')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.map(({ file, accountName }) => {
                  const errors = file.errors as { message?: string; warnings?: string[] } | null;
                  return (
                    <TableRow key={file.id}>
                      <TableCell className="whitespace-nowrap text-sm">
                        {format.dateTime(file.createdAt, {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </TableCell>
                      <TableCell className="max-w-72">
                        <a
                          href={`/api/admin/banking/imports/${file.id}`}
                          className="break-all hover:underline"
                          title={t('imports.download')}
                        >
                          {file.fileName}
                        </a>
                        <div className="text-xs text-muted-foreground">
                          {accountName} · {t(`format.${file.format}`)}
                        </div>
                        {errors?.message ? (
                          <div className="text-xs text-destructive">{errors.message}</div>
                        ) : null}
                        {errors?.warnings?.length ? (
                          <details className="text-xs text-muted-foreground">
                            <summary>
                              {t('imports.warnings', { count: errors.warnings.length })}
                            </summary>
                            <ul className="list-disc pl-5">
                              {errors.warnings.map((w, i) => (
                                <li key={i}>{w}</li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-sm">{t(`source.${file.source}`)}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">
                        {file.periodFrom
                          ? `${date(file.periodFrom)} – ${date(file.periodTo)}`
                          : '–'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {file.transactionCount}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {file.importedCount}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {file.duplicateCount}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            file.status === 'COMPLETED'
                              ? 'default'
                              : file.status === 'FAILED'
                                ? 'destructive'
                                : 'secondary'
                          }
                        >
                          {t(`importStatus.${file.status}`)}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {pages > 1 ? (
        <div className="flex items-center justify-end gap-2 text-sm">
          {page > 1 ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/admin/banking/imports?page=${page - 1}`}>
                {t('transactions.previous')}
              </Link>
            </Button>
          ) : null}
          <span className="text-muted-foreground">{t('transactions.page', { page, pages })}</span>
          {page < pages ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/admin/banking/imports?page=${page + 1}`}>{t('transactions.next')}</Link>
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

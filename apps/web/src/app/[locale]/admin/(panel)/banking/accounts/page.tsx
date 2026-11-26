import { formatIban } from '@tix/shared';
import { Landmark, Pencil, Plus, Upload } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { BankingPage } from '@/components/admin/banking/banking-page';
import { EmptyState } from '@/components/admin/empty-state';
import { RowActions } from '@/components/admin/row-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
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
import { listBankAccounts } from '@/server/admin/banking-queries';

export default async function BankAccountsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['FINANCE']);
  const [t, tb, tl, tc, accounts] = await Promise.all([
    getTranslations('banking.accounts'),
    getTranslations('banking'),
    getTranslations('admin.list'),
    getTranslations('common.actions'),
    listBankAccounts(),
  ]);
  const newButton = (
    <Button asChild>
      <Link href="/admin/banking/accounts/new">
        <Plus /> {t('new')}
      </Link>
    </Button>
  );
  return (
    <BankingPage title={t('title')} description={t('description')} actions={newButton}>
      <Card>
        <CardContent>
          {accounts.length === 0 ? (
            <EmptyState icon={Landmark} title={t('empty')} action={newButton} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.name')}</TableHead>
                  <TableHead>{t('columns.iban')}</TableHead>
                  <TableHead>{t('columns.holder')}</TableHead>
                  <TableHead>{t('columns.currency')}</TableHead>
                  <TableHead className="text-right">{t('columns.connections')}</TableHead>
                  <TableHead>{t('columns.status')}</TableHead>
                  <TableHead className="w-10">
                    <span className="sr-only">{tb('actionsMenu')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <Link
                        href={`/admin/banking/accounts/${a.id}`}
                        className="font-medium hover:underline"
                      >
                        {a.name}
                      </Link>
                      {a.bankName ? (
                        <div className="text-xs text-muted-foreground">{a.bankName}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{formatIban(a.iban)}</TableCell>
                    <TableCell>{a.accountHolder}</TableCell>
                    <TableCell>{a.currency}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.connections}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {a.isDefaultForBankTransfer ? <Badge>{t('default')}</Badge> : null}
                        {a.isActive ? null : <Badge variant="outline">{t('inactive')}</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <RowActions label={tl('rowActions', { name: a.name })}>
                        <DropdownMenuItem asChild>
                          <Link href={`/admin/banking/accounts/${a.id}`}>
                            <Pencil /> {tc('edit')}
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                          <Link href={`/admin/banking/imports?account=${a.id}`}>
                            <Upload /> {tb('connection.actions.uploadFiles')}
                          </Link>
                        </DropdownMenuItem>
                      </RowActions>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </BankingPage>
  );
}

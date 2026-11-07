import { formatIban } from '@tix/shared';
import { Plus } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
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
import { listBankAccounts } from '@/server/admin/banking-queries';

export default async function BankAccountsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['FINANCE']);
  const [t, accounts] = await Promise.all([
    getTranslations('banking.accounts'),
    listBankAccounts(),
  ]);
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>{t('title')}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <Button asChild>
          <Link href="/admin/banking/accounts/new">
            <Plus /> {t('new')}
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {accounts.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
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
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

import { listEmailTemplates, EMAIL_TEMPLATE_LOCALES } from '@tix/core';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/admin/form-controls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { resolveLocale } from '@/i18n/locale';
import { Link } from '@/i18n/navigation';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('emailTemplates');
  return { title: t('title') };
}

export default async function EmailTemplatesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['SUPER_ADMIN']);
  const [t, entries] = await Promise.all([
    getTranslations('emailTemplates'),
    listEmailTemplates(getCore().db),
  ]);

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="p-6">
        <Card>
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.template')}</TableHead>
                  {EMAIL_TEMPLATE_LOCALES.map((locale) => (
                    <TableHead key={locale}>
                      {locale === 'en' ? t('columns.english') : t('columns.german')}
                    </TableHead>
                  ))}
                  <TableHead>{t('columns.overrides')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.key}>
                    <TableCell className="max-w-sm align-top">
                      <div className="font-medium">{t(`keys.${entry.key}.name`)}</div>
                      <div className="text-xs text-muted-foreground">
                        {t(`keys.${entry.key}.description`)}
                      </div>
                    </TableCell>
                    {EMAIL_TEMPLATE_LOCALES.map((locale) => {
                      const info = entry.locales[locale];
                      return (
                        <TableCell key={locale} className="align-top">
                          <div className="flex flex-col items-start gap-2">
                            <Badge
                              variant={
                                !info.exists || !info.isActive
                                  ? 'destructive'
                                  : info.isDefault
                                    ? 'outline'
                                    : 'default'
                              }
                            >
                              {!info.exists
                                ? t('status.missing')
                                : !info.isActive
                                  ? t('status.inactive')
                                  : info.isDefault
                                    ? t('status.default')
                                    : t('status.customized')}
                            </Badge>
                            <Button asChild variant="outline" size="sm">
                              <Link href={`/admin/email-templates/${entry.key}/${locale}`}>
                                {t('edit')}
                              </Link>
                            </Button>
                          </div>
                        </TableCell>
                      );
                    })}
                    <TableCell className="align-top text-sm">
                      {entry.overrides.length === 0 ? (
                        <span className="text-muted-foreground">{t('noOverrides')}</span>
                      ) : (
                        <ul className="space-y-1">
                          {entry.overrides.map((o) => (
                            <li key={`${o.eventId}-${o.locale}`}>
                              <Link
                                className="hover:underline"
                                href={`/admin/email-templates/${entry.key}/${o.locale}?event=${o.eventId}`}
                              >
                                {o.eventTitle}{' '}
                                <span className="text-xs text-muted-foreground uppercase">
                                  {o.locale}
                                </span>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

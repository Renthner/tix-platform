import { listTicketTemplates } from '@tix/core';
import { Ticket } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { EmptyState } from '@/components/admin/empty-state';
import { AdminPageHeader } from '@/components/admin/page-header';
import { hubBreadcrumbs } from '@/server/admin/breadcrumbs';
import { TicketDesignImport } from '@/components/admin/ticket-designer/design-import';
import {
  CreateLibraryTemplateForm,
  TemplateRowActions,
} from '@/components/admin/ticket-designer/forms';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  const t = await getTranslations('ticketDesigner');
  return { title: t('title') };
}

export default async function TicketTemplatesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  await resolveLocale(params);
  await requireAdmin(['EVENT_MANAGER']);
  const [t, format, templates] = await Promise.all([
    getTranslations('ticketDesigner'),
    getFormatter(),
    listTicketTemplates(getCore().db),
  ]);

  return (
    <>
      <AdminPageHeader
        breadcrumbs={await hubBreadcrumbs('design')}
        title={t('title')}
        description={t('description')}
      />
      <div className="space-y-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('page.library')}</CardTitle>
          </CardHeader>
          <CardContent>
            {templates.length === 0 ? (
              <EmptyState size="sm" icon={Ticket} title={t('page.none')} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('page.columns.name')}</TableHead>
                    <TableHead>{t('page.columns.size')}</TableHead>
                    <TableHead>{t('page.columns.usage')}</TableHead>
                    <TableHead>{t('page.columns.updated')}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {templates.map((tpl) => (
                    <TableRow key={tpl.id}>
                      <TableCell className="font-medium">
                        <Link
                          className="hover:underline"
                          href={`/admin/ticket-templates/${tpl.id}`}
                        >
                          {tpl.name}
                        </Link>{' '}
                        {tpl.isDefault && <Badge variant="outline">{t('page.default')}</Badge>}
                        {tpl.description && (
                          <div className="text-xs font-normal text-muted-foreground">
                            {tpl.description}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap tabular-nums">
                        {tpl.pageWidthMm} × {tpl.pageHeightMm} mm
                      </TableCell>
                      <TableCell className="text-sm">
                        {t('page.usageCount', { count: tpl.usageCount })}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
                        {format.dateTime(tpl.updatedAt, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </TableCell>
                      <TableCell>
                        <TemplateRowActions id={tpl.id} isDefault={tpl.isDefault} global />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <p className="mt-4 text-xs text-muted-foreground">{t('page.builtinNote')}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('page.create.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <CreateLibraryTemplateForm
              options={templates.map((tpl) => ({
                id: tpl.id,
                name: tpl.name,
                eventOwned: false,
              }))}
            />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <TicketDesignImport />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

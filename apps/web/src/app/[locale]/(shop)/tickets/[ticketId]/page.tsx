import { getHolderTicketView } from '@tix/core';
import { Download } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TicketSelfServiceActions } from '@/components/shop/ticket-self-service';
import { resolveLocale } from '@/i18n/locale';
import { getCore } from '@/server/core';
import { clientIp, enforceRateLimit } from '@/server/http';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('checkout.order.holder');
  return { title: t('metaTitle'), robots: { index: false, follow: false } };
}

/** Ticket page of the recipient of a transferred ticket: only this ticket, never the order. */
export default async function HolderTicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; ticketId: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  await resolveLocale(params);
  const { ticketId } = await params;
  const { t: token } = await searchParams;
  await enforceRateLimit('holder-ticket', await clientIp(), 120, 10 * 60_000).catch(() =>
    notFound(),
  );
  const view = await getHolderTicketView(getCore(), token, ticketId);
  if (!view) notFound();
  const [t, format] = await Promise.all([getTranslations('checkout.order.holder'), getFormatter()]);
  const q = `?t=${encodeURIComponent(token!)}`;
  const tid = ticketId; // the token is bound to the linked ticket; routes follow re-issues for the same holder

  return (
    <div className="mx-auto max-w-xl space-y-6" data-slot="holder-ticket">
      <Card>
        <CardHeader>
          <CardTitle>{view.eventTitle}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {format.dateTime(view.startsAt, {
              dateStyle: 'full',
              timeStyle: 'short',
              timeZone: view.timeZone,
            })}
            {view.venue ? ` · ${view.venue}` : ''}
          </p>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {view.state !== 'VALID' ? (
            <p data-slot="holder-ticket-void" className="font-medium text-destructive">
              {view.state === 'TRANSFERRED' ? t('transferred') : t('void')}
            </p>
          ) : (
            <>
              <dl className="space-y-1">
                <div>
                  <dt className="inline text-muted-foreground">{t('seat')}: </dt>
                  <dd className="inline font-medium">{view.place}</dd>
                </div>
                {view.attendeeName && (
                  <div>
                    <dt className="inline text-muted-foreground">{t('name')}: </dt>
                    <dd className="inline font-medium">{view.attendeeName}</dd>
                  </div>
                )}
                <div>
                  <dt className="inline text-muted-foreground">{t('code')}: </dt>
                  <dd className="inline font-mono font-medium">{view.ticketCode}</dd>
                </div>
              </dl>
              <p className="text-muted-foreground">{t('intro')}</p>
              <div className="flex flex-wrap gap-2">
                <Button asChild>
                  <a href={`/api/tickets/${tid}/pdf${q}`} data-slot="holder-pdf">
                    <Download className="size-4" />
                    {t('pdf')}
                  </a>
                </Button>
                {view.wallet.apple && (
                  <Button asChild variant="outline">
                    <a href={`/api/tickets/${tid}/pkpass${q}`}>{t('apple')}</a>
                  </Button>
                )}
                {view.wallet.google && (
                  <Button asChild variant="outline">
                    <a href={`/api/tickets/${tid}/google${q}`}>{t('google')}</a>
                  </Button>
                )}
              </div>
              {view.transfer.block === null && (
                <div className="space-y-2 border-t pt-4" data-slot="holder-transfer">
                  {view.transfer.deadlineAt && (
                    <p className="text-muted-foreground">
                      {t('passOnUntil', {
                        date: format.dateTime(view.transfer.deadlineAt, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                          timeZone: view.timeZone,
                        }),
                      })}
                    </p>
                  )}
                  <TicketSelfServiceActions
                    token={token!}
                    ticketId={tid}
                    ticketCode={view.ticketCode}
                    attendeeName={null}
                    canChangeName={false}
                    canTransfer
                    apiBase={`/api/tickets/${tid}`}
                  />
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

import { getLocale, getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Door reports of one event: seating occupancy PDF and guest list (CSV / PDF). Plain GET forms –
 * the routes answer with attachments, so no client code is needed.
 */
export async function EventReports({ eventId }: { eventId: string }) {
  const t = await getTranslations('scanners.checkIn.reports');
  const locale = await getLocale();
  const base = `/api/admin/events/${eventId}/reports`;
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold">{t('title')}</h2>
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="font-medium">{t('occupancy.title')}</div>
            <p className="text-sm text-muted-foreground">{t('occupancy.description')}</p>
            <form method="get" action={`${base}/occupancy`} className="space-y-3">
              <input type="hidden" name="locale" value={locale} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="holders" value="1" className="size-4" />
                {t('occupancy.holders')}
              </label>
              <Button type="submit" variant="outline">
                {t('occupancy.download')}
              </Button>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="font-medium">{t('guestList.title')}</div>
            <p className="text-sm text-muted-foreground">{t('guestList.description')}</p>
            <form method="get" action={`${base}/guest-list`} className="space-y-3">
              <input type="hidden" name="locale" value={locale} />
              <label className="flex items-center gap-2 text-sm">
                {t('guestList.sort')}
                <select
                  name="sort"
                  defaultValue="name"
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                >
                  <option value="name">{t('guestList.sortName')}</option>
                  <option value="seat">{t('guestList.sortSeat')}</option>
                </select>
              </label>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" name="format" value="csv" variant="outline">
                  {t('guestList.csv')}
                </Button>
                <Button type="submit" name="format" value="pdf" variant="outline">
                  {t('guestList.pdf')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

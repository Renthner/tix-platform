import { getAdminTodoCounts } from '@tix/core';
import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import { getCore } from '@/server/core';

/**
 * To-do tiles of the dashboard: counts of open work with a deep link into the right list. Tiles
 * are filtered by role; a failing count never breaks the dashboard.
 */
export async function TodoTiles({
  finance,
  eventManager,
}: {
  finance: boolean;
  eventManager: boolean;
}) {
  if (!finance && !eventManager) return null;
  const counts = await getAdminTodoCounts(getCore()).catch(() => null);
  if (!counts) return null;
  const t = await getTranslations('admin.dashboard.todo');
  type TileKey =
    | 'bankReview'
    | 'overdueTransfers'
    | 'openRefunds'
    | 'openAdjustments'
    | 'waitlistPending'
    | 'expiringCodes';
  type Tile = { key: TileKey; n: number; href: string };
  const tiles: Tile[] = [
    ...(finance
      ? ([
          { key: 'bankReview', n: counts.bankReview, href: '/admin/banking/review' },
          { key: 'overdueTransfers', n: counts.overdueTransfers, href: '/admin/orders?overdue=1' },
          { key: 'openRefunds', n: counts.openRefunds, href: '/admin/refunds' },
          { key: 'openAdjustments', n: counts.openAdjustments, href: '/admin/refunds' },
        ] as Tile[])
      : []),
    ...(eventManager
      ? ([
          { key: 'waitlistPending', n: counts.waitlistPending, href: '/admin/events' },
          { key: 'expiringCodes', n: counts.expiringCodes, href: '/admin/events' },
        ] as Tile[])
      : []),
  ];
  return (
    <section aria-label={t('title')} data-testid="todo-tiles">
      <h2 className="mb-2 text-sm font-semibold">{t('title')}</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((tile) => (
          <Link
            key={tile.key}
            href={tile.href}
            className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Card
              className={cn(
                'h-full transition-colors hover:bg-accent',
                tile.n > 0 && 'border-warning-border',
              )}
            >
              <CardContent className="flex items-center justify-between gap-3">
                <span className="text-sm">{t(`tiles.${tile.key}`)}</span>
                <span className="text-2xl font-semibold tabular-nums">{tile.n}</span>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}

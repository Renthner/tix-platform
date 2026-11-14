import { buildQuery, pageCount, type QueryValue } from '@tix/shared';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

/**
 * Previous / next navigation with an optional page-size switcher for the paged admin lists. Pure
 * links (works without JavaScript); `params` are the list's current filters, kept on every link.
 * The page size is only written to the URL when it differs from `defaultPageSize`.
 */
export function AdminPagination({
  pathname,
  params,
  page,
  total,
  pageSize,
  summary,
  pageSizes,
  defaultPageSize = pageSize,
  pageParam = 'page',
  pageSizeParam = 'pageSize',
  className,
}: {
  pathname: string;
  params: Record<string, QueryValue>;
  page: number;
  total: number;
  pageSize: number;
  /** Text on the left, typically the total count. */
  summary?: ReactNode;
  /** Offers a "per page" switcher when given. */
  pageSizes?: readonly number[];
  defaultPageSize?: number;
  pageParam?: string;
  pageSizeParam?: string;
  className?: string;
}) {
  const t = useTranslations('common.pagination');
  const pages = pageCount(total, pageSize);
  const current = Math.min(page, pages);
  const base: Record<string, QueryValue> = {
    ...params,
    [pageSizeParam]: pageSize !== defaultPageSize ? pageSize : undefined,
  };
  const pageHref = (p: number) =>
    buildQuery(pathname, base, { [pageParam]: p > 1 ? p : undefined });
  const sizeHref = (size: number) =>
    buildQuery(pathname, params, {
      [pageSizeParam]: size !== defaultPageSize ? size : undefined,
      [pageParam]: undefined,
    });

  return (
    <nav
      aria-label={t('label')}
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground',
        className,
      )}
    >
      <span>{summary}</span>
      <div className="flex flex-wrap items-center gap-3">
        {pageSizes && pageSizes.length > 1 && (
          <div className="flex items-center gap-1" role="group" aria-label={t('perPage')}>
            <span>{t('perPage')}</span>
            {pageSizes.map((size) => (
              <Link
                key={size}
                href={sizeHref(size)}
                aria-current={size === pageSize ? 'true' : undefined}
                data-testid={`page-size-${size}`}
                className={cn(
                  'rounded-md border px-2 py-0.5 tabular-nums',
                  size === pageSize
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'hover:bg-accent',
                )}
              >
                {size}
              </Link>
            ))}
          </div>
        )}
        {pages > 1 && (
          <div className="flex items-center gap-2">
            {current > 1 && (
              <Button asChild variant="outline" size="sm">
                <Link href={pageHref(current - 1)} rel="prev">
                  {t('previous')}
                </Link>
              </Button>
            )}
            <span>{t('pageOf', { page: current, pages })}</span>
            {current < pages && (
              <Button asChild variant="outline" size="sm">
                <Link href={pageHref(current + 1)} rel="next">
                  {t('next')}
                </Link>
              </Button>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}

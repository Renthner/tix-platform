import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Two-column layout of an admin detail page: the main column and a narrow aside (stacked below
 * the main column on smaller screens). Server-friendly.
 */
export function DetailLayout({
  children,
  aside,
  asideFirstOnMobile = false,
  className,
}: {
  children: ReactNode;
  aside?: ReactNode;
  /** Stack the aside ABOVE the main column on small screens (e.g. quick links staff need first). */
  asideFirstOnMobile?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'grid gap-6 p-6',
        aside ? 'lg:grid-cols-[minmax(0,1fr)_20rem]' : undefined,
        className,
      )}
    >
      <div className="min-w-0 space-y-6">{children}</div>
      {aside && (
        <aside className={cn('min-w-0 space-y-6', asideFirstOnMobile && 'order-first lg:order-0')}>
          {aside}
        </aside>
      )}
    </div>
  );
}

/**
 * Card of a detail page with a consistent heading row: title (+ description) left, optional
 * actions right. `flush` drops the content padding (tables that bring their own).
 */
export function DetailSection({
  title,
  description,
  actions,
  children,
  className,
  contentClassName,
  ...rest
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
  'data-testid'?: string;
}) {
  return (
    <Card className={className} data-testid={rest['data-testid']}>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 space-y-1.5">
          <CardTitle role="heading" aria-level={2}>
            {title}
          </CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </CardHeader>
      {children !== undefined && children !== null && (
        <CardContent className={contentClassName}>{children}</CardContent>
      )}
    </Card>
  );
}

import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';

export interface Breadcrumb {
  label: string;
  href: string;
}

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Parent pages (hub, list); the h1 is the current page. */
  breadcrumbs?: readonly Breadcrumb[];
}

/**
 * Markup of the admin page header without translations (`breadcrumbsLabel` names the trail).
 * Use `AdminPageHeader`; the legacy `PageHeader` of form-controls renders this as well.
 */
export function PageHeaderLayout({
  title,
  description,
  actions,
  breadcrumbs,
  breadcrumbsLabel,
}: PageHeaderProps & { breadcrumbsLabel?: string }) {
  return (
    <div className="border-b px-6 py-5">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label={breadcrumbsLabel} className="mb-1.5">
          <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {breadcrumbs.map((crumb) => (
              <li key={crumb.href} className="flex items-center gap-1">
                <Link
                  href={crumb.href}
                  className="rounded-sm hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {crumb.label}
                </Link>
                <ChevronRight className="size-3" aria-hidden />
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

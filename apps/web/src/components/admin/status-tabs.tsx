import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

export interface StatusTab {
  key: string;
  label: string;
  /** Target URL (the list with this quick filter, other params kept). */
  href: string;
  active: boolean;
  /** Optional number shown after the label. */
  count?: number;
  'data-testid'?: string;
}

/**
 * Quick-filter tabs of a list (All / Open / Overdue …) as a segmented row of links. The current
 * tab carries `aria-current`. Server-friendly (plain links, URL params).
 */
export function StatusTabs({ label, tabs }: { label: string; tabs: readonly StatusTab[] }) {
  return (
    <nav aria-label={label} className="overflow-x-auto">
      <ul className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-1 text-sm">
        {tabs.map((tab) => (
          <li key={tab.key}>
            <Link
              href={tab.href}
              aria-current={tab.active ? 'page' : undefined}
              data-testid={tab['data-testid']}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1 whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                tab.active
                  ? 'bg-background font-medium text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span
                  className={cn(
                    'rounded-full px-1.5 text-xs tabular-nums',
                    tab.active ? 'bg-muted text-foreground' : 'bg-background text-foreground',
                  )}
                >
                  {tab.count}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

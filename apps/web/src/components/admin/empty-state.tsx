import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Placeholder for an empty list or section: icon, title, optional text and action. `size="sm"`
 * is the compact variant inside cards; `tone="success"` for "all done" states. Server-friendly.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  size = 'md',
  tone = 'default',
  className,
  ...rest
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  size?: 'sm' | 'md';
  tone?: 'default' | 'success';
  className?: string;
  'data-testid'?: string;
}) {
  const small = size === 'sm';
  return (
    <div
      data-testid={rest['data-testid']}
      className={cn(
        'flex flex-col items-center justify-center text-center',
        small ? 'gap-1.5 py-6' : 'gap-2 py-10',
        className,
      )}
    >
      {Icon && (
        <span
          aria-hidden
          className={cn(
            'flex items-center justify-center rounded-full',
            small ? 'mb-1 size-9' : 'mb-2 size-12',
            tone === 'success' ? 'bg-success-soft text-success' : 'bg-muted text-muted-foreground',
          )}
        >
          <Icon className={small ? 'size-4' : 'size-6'} />
        </span>
      )}
      <p className={cn('font-medium', small ? 'text-sm' : 'text-base')}>{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

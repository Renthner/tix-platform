import type { SetupChecklist } from '@tix/core';
import { CheckCircle2, ChevronDown, ChevronUp, Circle } from 'lucide-react';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import {
  dismissSetupChecklistAction,
  setSetupChecklistCollapsedAction,
} from '@/server/admin/setup-checklist';
import { SETUP_COLLAPSED_COOKIE } from '@/server/admin/setup-checklist-cookie';

/**
 * "First steps" card of the dashboard (server component; buttons are plain forms to server
 * actions). Collapsing is remembered per browser in a cookie and rendered server-side.
 * `compact` = narrow side-column variant (stacked header, step titles only, progress bar).
 */
export async function SetupChecklistCard({
  checklist,
  canDismiss,
  compact = false,
}: {
  checklist: SetupChecklist;
  /** Permanent hiding is a SUPER_ADMIN action (it changes a shop-wide setting). */
  canDismiss: boolean;
  compact?: boolean;
}) {
  const t = await getTranslations('admin.dashboard.setup');
  const collapsed = (await cookies()).get(SETUP_COLLAPSED_COOKIE)?.value === '1';
  const Chevron = collapsed ? ChevronDown : ChevronUp;
  const percent = checklist.total > 0 ? (checklist.doneCount / checklist.total) * 100 : 0;
  return (
    <Card data-testid="setup-checklist" className={compact ? 'gap-4' : undefined}>
      {/* CardHeader is a grid by default: flex puts the actions beside the text from `sm` up and
          below it (wrapping) on phones. */}
      <CardHeader
        className={cn(
          'flex flex-col gap-3',
          !compact && 'sm:flex-row sm:items-start sm:justify-between sm:gap-6',
        )}
      >
        <div className="w-full min-w-0 space-y-1">
          <CardTitle className={compact ? 'text-base' : undefined}>{t('title')}</CardTitle>
          {!collapsed && !compact && (
            <p className="text-sm text-muted-foreground">{t('description')}</p>
          )}
          <p className="text-sm font-medium">
            {t('progress', { done: checklist.doneCount, total: checklist.total })}
          </p>
          {compact && (
            <div
              role="progressbar"
              aria-label={t('title')}
              aria-valuemin={0}
              aria-valuemax={checklist.total}
              aria-valuenow={checklist.doneCount}
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-start gap-2 sm:flex-nowrap">
          <form action={setSetupChecklistCollapsedAction.bind(null, !collapsed)}>
            <Button type="submit" variant="ghost" size="sm" aria-expanded={!collapsed}>
              <Chevron className="size-4" aria-hidden />
              {t(collapsed ? 'expand' : 'collapse')}
            </Button>
          </form>
          {canDismiss && !collapsed && (
            <form action={dismissSetupChecklistAction}>
              <Button
                type="submit"
                variant="outline"
                size="sm"
                title={t('dismissHint')}
                aria-describedby="setup-dismiss-hint"
              >
                {t('dismiss')}
              </Button>
            </form>
          )}
        </div>
      </CardHeader>
      {canDismiss && !collapsed && (
        <p
          id="setup-dismiss-hint"
          className={cn(
            'px-6 text-xs text-muted-foreground',
            compact ? '-mt-2' : '-mt-3 sm:text-right',
          )}
        >
          {t('dismissHint')}
        </p>
      )}
      {!collapsed && (
        <CardContent>
          <ul className="divide-y">
            {checklist.steps.map((step) => (
              <li
                key={step.key}
                className={cn('flex items-start gap-3', compact ? 'py-2' : 'py-2.5')}
              >
                {step.done ? (
                  <CheckCircle2
                    className={cn('mt-0.5 shrink-0 text-success', compact ? 'size-4' : 'size-5')}
                    aria-hidden
                  />
                ) : (
                  <Circle
                    className={cn(
                      'mt-0.5 shrink-0 text-muted-foreground',
                      compact ? 'size-4' : 'size-5',
                    )}
                    aria-hidden
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className={cn('text-sm', compact ? undefined : 'font-medium')}>
                    {t(`steps.${step.key}.title`)}
                    <span className="sr-only"> – {t(step.done ? 'done' : 'open')}</span>
                  </div>
                  {!compact && (
                    <p className="text-sm text-muted-foreground">
                      {t(`steps.${step.key}.description`)}
                      {step.hint && ` ${t(`hints.${step.hint}`)}`}
                    </p>
                  )}
                </div>
                {!step.done &&
                  (compact ? (
                    <Link
                      href={step.href}
                      title={t(`steps.${step.key}.description`)}
                      className="shrink-0 text-xs font-medium underline-offset-4 hover:underline"
                    >
                      {t('go')}
                    </Link>
                  ) : (
                    <Button asChild variant="outline" size="sm">
                      <Link href={step.href}>{t('go')}</Link>
                    </Button>
                  ))}
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}

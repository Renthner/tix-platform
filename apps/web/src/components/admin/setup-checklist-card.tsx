import type { SetupChecklist } from '@tix/core';
import { CheckCircle2, ChevronDown, ChevronUp, Circle } from 'lucide-react';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import {
  dismissSetupChecklistAction,
  setSetupChecklistCollapsedAction,
} from '@/server/admin/setup-checklist';
import { SETUP_COLLAPSED_COOKIE } from '@/server/admin/setup-checklist-cookie';

/**
 * "First steps" card of the dashboard (server component; buttons are plain forms to server
 * actions). Collapsing is remembered per browser in a cookie and rendered server-side.
 */
export async function SetupChecklistCard({
  checklist,
  canDismiss,
}: {
  checklist: SetupChecklist;
  /** Permanent hiding is a SUPER_ADMIN action (it changes a shop-wide setting). */
  canDismiss: boolean;
}) {
  const t = await getTranslations('admin.dashboard.setup');
  const collapsed = (await cookies()).get(SETUP_COLLAPSED_COOKIE)?.value === '1';
  const Chevron = collapsed ? ChevronDown : ChevronUp;
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="space-y-1">
          <CardTitle>{t('title')}</CardTitle>
          {!collapsed && <p className="text-sm text-muted-foreground">{t('description')}</p>}
          <p className="text-sm font-medium">
            {t('progress', { done: checklist.doneCount, total: checklist.total })}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <form action={setSetupChecklistCollapsedAction.bind(null, !collapsed)}>
            <Button type="submit" variant="ghost" size="sm" aria-expanded={!collapsed}>
              <Chevron className="size-4" aria-hidden />
              {t(collapsed ? 'expand' : 'collapse')}
            </Button>
          </form>
          {canDismiss && !collapsed && (
            <form action={dismissSetupChecklistAction} className="flex flex-col items-end gap-1">
              <Button type="submit" variant="outline" size="sm">
                {t('dismiss')}
              </Button>
              <p className="max-w-56 text-right text-xs text-muted-foreground">
                {t('dismissHint')}
              </p>
            </form>
          )}
        </div>
      </CardHeader>
      {!collapsed && (
        <CardContent>
          <ul className="divide-y">
            {checklist.steps.map((step) => (
              <li key={step.key} className="flex items-start gap-3 py-2.5">
                {step.done ? (
                  <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-green-600" aria-hidden />
                ) : (
                  <Circle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {t(`steps.${step.key}.title`)}
                    <span className="sr-only"> – {t(step.done ? 'done' : 'open')}</span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t(`steps.${step.key}.description`)}
                    {step.hint && ` ${t(`hints.${step.hint}`)}`}
                  </p>
                </div>
                {!step.done && (
                  <Button asChild variant="outline" size="sm">
                    <Link href={step.href}>{t('go')}</Link>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}

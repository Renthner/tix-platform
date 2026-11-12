import type { SetupChecklist } from '@tix/core';
import { CheckCircle2, Circle } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { dismissSetupChecklistAction } from '@/server/admin/setup-checklist';

/** "First steps" card of the dashboard (server component; hide = plain form to a server action). */
export async function SetupChecklistCard({ checklist }: { checklist: SetupChecklist }) {
  const t = await getTranslations('admin.dashboard.setup');
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="space-y-1">
          <CardTitle>{t('title')}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
          <p className="text-sm font-medium">
            {t('progress', { done: checklist.doneCount, total: checklist.total })}
          </p>
        </div>
        <form action={dismissSetupChecklistAction}>
          <Button type="submit" variant="ghost" size="sm">
            {t('dismiss')}
          </Button>
        </form>
      </CardHeader>
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
    </Card>
  );
}

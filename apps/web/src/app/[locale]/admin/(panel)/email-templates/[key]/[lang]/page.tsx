import {
  EMAIL_TEMPLATE_LOCALES,
  getEditableEmailTemplate,
  isTemplateKey,
  isTemplateLocale,
  listEmailTemplates,
} from '@tix/core';
import { events } from '@tix/db';
import { emailTemplateVariables } from '@tix/shared';
import { asc, eq } from 'drizzle-orm';
import { ChevronLeft } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { ConfirmAction } from '@/components/admin/confirm-action';
import { EmailTemplateEditor } from '@/components/admin/email-template-editor';
import { EmailTemplateOverrideForm } from '@/components/admin/email-template-override-form';
import { PageHeader } from '@/components/admin/form-controls';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { resolveLocale } from '@/i18n/locale';
import { Link } from '@/i18n/navigation';
import {
  createEmailTemplateOverrideAction,
  deleteEmailTemplateOverrideAction,
  generateTemplateTextAction,
  previewEmailTemplateAction,
  resetEmailTemplateAction,
  saveEmailTemplateAction,
  sendEmailTemplateTestAction,
} from '@/server/admin/email-templates';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('emailTemplates');
  return { title: t('title') };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditEmailTemplatePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; key: string; lang: string }>;
  searchParams: Promise<{ event?: string }>;
}) {
  await resolveLocale(params);
  const session = await requireAdmin(['SUPER_ADMIN']);
  const { key, lang } = await params;
  if (!isTemplateKey(key) || !isTemplateLocale(lang)) notFound();
  const { event: eventParam } = await searchParams;
  const eventId = eventParam && UUID.test(eventParam) ? eventParam : null;

  const core = getCore();
  const [t, tl] = await Promise.all([
    getTranslations('emailTemplates'),
    getTranslations('common.locale'),
  ]);
  const [eventRow] = eventId
    ? await core.db.select({ title: events.title }).from(events).where(eq(events.id, eventId))
    : [];
  if (eventId && !eventRow) notFound();

  const editable = await getEditableEmailTemplate(core.db, key, lang, eventId);
  const variables = emailTemplateVariables(key);
  const hasEditor = !eventId || editable.row !== null;

  // Overrides of this key/language and events that can still get one (global view only).
  let overrideEvents: { id: string; title: string }[] = [];
  let overrides: { eventId: string; eventTitle: string }[] = [];
  if (!eventId) {
    const [overview, allEvents] = await Promise.all([
      listEmailTemplates(core.db),
      core.db
        .select({ id: events.id, title: events.title })
        .from(events)
        .orderBy(asc(events.title)),
    ]);
    overrides = (overview.find((o) => o.key === key)?.overrides ?? []).filter(
      (o) => o.locale === lang,
    );
    const taken = new Set(overrides.map((o) => o.eventId));
    overrideEvents = allEvents.filter((e) => !taken.has(e.id));
  }

  const name = t(`keys.${key}.name`);
  const localeLabel = (l: string) => tl(l as 'en' | 'de');

  return (
    <>
      <PageHeader
        title={name}
        description={
          eventRow
            ? `${t('page.overrideFor', { event: eventRow.title })} · ${localeLabel(lang)}`
            : `${t('page.global')} · ${localeLabel(lang)}`
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/email-templates">
              <ChevronLeft /> {t('page.back')}
            </Link>
          </Button>
        }
      />
      <div className="space-y-6 p-6">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('page.languages')}:</span>
          {EMAIL_TEMPLATE_LOCALES.map((l) => (
            <Button
              key={l}
              asChild
              size="sm"
              variant={l === lang ? 'default' : 'outline'}
              aria-current={l === lang}
            >
              <Link
                href={`/admin/email-templates/${key}/${l}${eventId ? `?event=${eventId}` : ''}`}
              >
                {localeLabel(l)}
              </Link>
            </Button>
          ))}
        </div>

        {eventId && <p className="text-sm text-muted-foreground">{t('page.overrideHint')}</p>}

        {hasEditor ? (
          <>
            <EmailTemplateEditor
              initial={{
                subject: editable.draft.subject,
                bodyHtml: editable.draft.bodyHtml,
                bodyText: editable.draft.bodyText ?? '',
                isActive: editable.draft.isActive,
              }}
              variables={variables}
              isDefault={editable.isDefault}
              adminEmail={session.email}
              save={saveEmailTemplateAction.bind(null, key, lang, eventId)}
              reset={resetEmailTemplateAction.bind(null, key, lang, eventId)}
              preview={previewEmailTemplateAction.bind(null, key, lang)}
              generateText={generateTemplateTextAction}
              sendTest={sendEmailTemplateTestAction.bind(null, key, lang)}
            />
            {eventId && (
              <ConfirmAction
                action={deleteEmailTemplateOverrideAction.bind(null, key, lang, eventId)}
                title={t('page.deleteOverrideTitle')}
                description={t('page.deleteOverrideDescription')}
                confirmLabel={t('page.deleteOverride')}
                size="default"
              >
                {t('page.deleteOverride')}
              </ConfirmAction>
            )}
          </>
        ) : (
          <Card>
            <CardContent className="space-y-4 pt-6">
              <p className="text-sm text-muted-foreground">{t('page.noOverrideYet')}</p>
              <EmailTemplateOverrideForm
                action={createEmailTemplateOverrideAction.bind(null, key, lang)}
                events={[{ id: eventId!, title: eventRow!.title }]}
              />
            </CardContent>
          </Card>
        )}

        {!eventId && (
          <Card>
            <CardHeader>
              <CardTitle>{t('page.overridesTitle')}</CardTitle>
              <CardDescription>{t('page.overridesDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {overrides.length > 0 && (
                <ul className="space-y-1 text-sm">
                  {overrides.map((o) => (
                    <li key={o.eventId}>
                      <Link
                        className="hover:underline"
                        href={`/admin/email-templates/${key}/${lang}?event=${o.eventId}`}
                      >
                        {o.eventTitle} – {t('page.openOverride')}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <EmailTemplateOverrideForm
                action={createEmailTemplateOverrideAction.bind(null, key, lang)}
                events={overrideEvents}
              />
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}

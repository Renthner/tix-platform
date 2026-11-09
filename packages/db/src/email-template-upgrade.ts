import { and, eq, isNull } from 'drizzle-orm';
import type { Executor } from './client';
import { defaultEmailTemplates } from './email-templates';
import {
  PREVIOUS_DEFAULT_FINGERPRINTS,
  emailTemplateFingerprint,
  templateSlot,
} from './email-template-history';
import { emailTemplates } from './schema';

/**
 * Moves global templates that are still byte-identical to an earlier shipped default to the
 * current default text. Admin-edited rows (any difference in subject / HTML / text) and
 * event overrides are never touched; `is_active` is kept. Idempotent.
 * Returns the upgraded `key|locale` slots.
 */
export async function upgradeUneditedEmailTemplates(
  db: Executor,
  history: Readonly<Record<string, readonly string[]>> = PREVIOUS_DEFAULT_FINGERPRINTS,
): Promise<string[]> {
  const upgraded: string[] = [];
  for (const target of defaultEmailTemplates()) {
    const slot = templateSlot(target.key, target.locale);
    const previous = history[slot];
    if (!previous?.length) continue;
    const [row] = await db
      .select()
      .from(emailTemplates)
      .where(
        and(
          eq(emailTemplates.key, target.key),
          eq(emailTemplates.locale, target.locale),
          isNull(emailTemplates.eventId),
        ),
      );
    if (!row || !previous.includes(emailTemplateFingerprint(row))) continue;
    // Guarded by the exact old content: a concurrent admin edit makes this a no-op.
    const changed = await db
      .update(emailTemplates)
      .set({
        subject: target.subject,
        bodyHtml: target.bodyHtml,
        bodyText: target.bodyText,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(emailTemplates.id, row.id),
          eq(emailTemplates.subject, row.subject),
          eq(emailTemplates.bodyHtml, row.bodyHtml),
        ),
      )
      .returning({ id: emailTemplates.id });
    if (changed.length > 0) upgraded.push(slot);
  }
  return upgraded;
}

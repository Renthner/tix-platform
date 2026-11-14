'use server';

import { getSetting, publishQueueUpdate, SHOP_TAGS } from '@tix/core';
import { events, queueAnnouncements, queueConfigs } from '@tix/db';
import {
  ANNOUNCEMENT_SEVERITIES,
  QUEUE_ADMISSION_ORDERS,
  QUEUE_MODES,
  mergeLocaleTranslations,
  translationLocales,
  type Translations,
} from '@tix/shared';
import { eq, inArray, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/lib/action-state';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { refreshShop } from './shop-refresh';
import { fieldError, flag, formError, success, text, zodFieldErrors } from './form';

const configSchema = z.object({
  mode: z.enum(QUEUE_MODES),
  activeSessionThreshold: z.coerce.number().int().min(1).max(1_000_000),
  admissionBatchSize: z.coerce.number().int().min(1).max(100_000),
  admissionIntervalSeconds: z.coerce.number().int().min(1).max(3_600),
  passTokenTtlSeconds: z.coerce.number().int().min(60).max(86_400),
  lobbyOpensMinutesBefore: z.coerce.number().int().min(0).max(10_080),
  admissionOrder: z.enum(QUEUE_ADMISSION_ORDERS),
  maxQueueSize: z.coerce.number().int().min(1).max(10_000_000).optional(),
  title: z.string().max(200).optional(),
  message: z.string().max(4_000).optional(),
});

async function eventExists(eventId: string): Promise<boolean> {
  const [row] = await getCore()
    .db.select({ id: events.id })
    .from(events)
    .where(eq(events.id, eventId));
  return Boolean(row);
}

/**
 * Saves the waiting-room configuration. `eventId = null` edits the global default.
 * For events, the switch `useGlobal` removes the event-specific row.
 */
export async function saveQueueConfigAction(
  eventId: string | null,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const { db } = getCore();
  if (eventId && !(await eventExists(eventId))) return formError('notFound');

  if (eventId && flag(fd, 'useGlobal')) {
    await db.delete(queueConfigs).where(eq(queueConfigs.eventId, eventId));
    await audit(db, session, 'queue.config.inherit', 'event', eventId);
    await refreshShop([SHOP_TAGS.queue]);
    return success('saved');
  }

  const parsed = configSchema.safeParse({
    mode: text(fd, 'mode'),
    activeSessionThreshold: text(fd, 'activeSessionThreshold'),
    admissionBatchSize: text(fd, 'admissionBatchSize'),
    admissionIntervalSeconds: text(fd, 'admissionIntervalSeconds'),
    passTokenTtlSeconds: text(fd, 'passTokenTtlSeconds'),
    lobbyOpensMinutesBefore: text(fd, 'lobbyOpensMinutesBefore'),
    admissionOrder: text(fd, 'admissionOrder'),
    maxQueueSize: text(fd, 'maxQueueSize'),
    title: text(fd, 'title'),
    message: text(fd, 'message'),
  });
  if (!parsed.success) return fieldError(zodFieldErrors(parsed.error));
  const values = {
    ...parsed.data,
    maxQueueSize: parsed.data.maxQueueSize ?? null,
    title: parsed.data.title ?? null,
    message: parsed.data.message ?? null,
    accessCodeBypassesQueue: flag(fd, 'accessCodeBypassesQueue'),
    isPaused: flag(fd, 'isPaused'),
    updatedByUserId: session.userId,
  };

  const [existing] = await db
    .select({ id: queueConfigs.id })
    .from(queueConfigs)
    .where(eventId ? eq(queueConfigs.eventId, eventId) : isNull(queueConfigs.eventId));
  if (existing) await db.update(queueConfigs).set(values).where(eq(queueConfigs.id, existing.id));
  else await db.insert(queueConfigs).values({ ...values, eventId });
  await audit(
    db,
    session,
    'queue.config.update',
    eventId ? 'event' : 'queue_config',
    eventId ?? existing?.id ?? null,
    values,
  );

  if (eventId) {
    await publishQueueUpdate(getCore(), {
      type: 'state',
      eventId,
      state: values.isPaused ? 'PAUSED' : 'OPEN',
    });
  }
  await refreshShop([SHOP_TAGS.queue]);
  return success('saved');
}

/** Clears waiting line, lobby, admissions and active shoppers of an event. */
export async function resetQueueAction(eventId: string, _prev: ActionState): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  if (!(await eventExists(eventId))) return formError('notFound');
  await getCore().queue.reset(eventId);
  await audit(getCore().db, session, 'queue.reset', 'event', eventId);
  revalidatePath('/', 'layout');
  return success('reset');
}

const announcementSchema = z.object({
  message: z.string().min(1).max(1_000),
  severity: z.enum(ANNOUNCEMENT_SEVERITIES),
  expiresInMinutes: z.coerce.number().int().min(1).max(10_080).optional(),
});

export async function createAnnouncementAction(
  eventId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  if (!(await eventExists(eventId))) return formError('notFound');
  const parsed = announcementSchema.safeParse({
    message: text(fd, 'message'),
    severity: text(fd, 'severity'),
    expiresInMinutes: text(fd, 'expiresInMinutes'),
  });
  if (!parsed.success) return fieldError(zodFieldErrors(parsed.error));
  const core = getCore();
  const now = new Date();
  const defaultLocale = (await getSetting(core, 'general')).defaultLocale;
  let translations: Translations = {};
  for (const locale of translationLocales(defaultLocale)) {
    const value = text(fd, `translation:${locale}`);
    if (value)
      translations = mergeLocaleTranslations(translations, locale, {
        message: value.slice(0, 1_000),
      });
  }
  const [row] = await core.db
    .insert(queueAnnouncements)
    .values({
      eventId,
      message: parsed.data.message,
      translations,
      severity: parsed.data.severity,
      publishedAt: now,
      expiresAt: parsed.data.expiresInMinutes
        ? new Date(now.getTime() + parsed.data.expiresInMinutes * 60_000)
        : null,
      createdByUserId: session.userId,
    })
    .returning({ id: queueAnnouncements.id });
  await publishQueueUpdate(core, {
    type: 'announcement',
    eventId,
    id: row!.id,
    message: parsed.data.message,
    translations,
    severity: parsed.data.severity,
    publishedAt: now.toISOString(),
  });
  await audit(core.db, session, 'queue.announcement', 'event', eventId, parsed.data);
  await refreshShop([SHOP_TAGS.queue]);
  return success('created');
}

/**
 * Edits a published announcement (text and translations). Active announcements are broadcast
 * again with the same id, so open waiting rooms replace the old text; others see it on next load.
 */
export async function updateAnnouncementAction(
  announcementId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  if (!z.uuid().safeParse(announcementId).success) return formError('notFound');
  const core = getCore();
  const message = text(fd, 'message');
  if (!message || message.length > 1_000)
    return fieldError({ message: message ? 'tooLong' : 'required' });
  const defaultLocale = (await getSetting(core, 'general')).defaultLocale;
  let translations: Translations = {};
  for (const locale of translationLocales(defaultLocale)) {
    const value = text(fd, `translation:${locale}`);
    if (value) {
      translations = mergeLocaleTranslations(translations, locale, {
        message: value.slice(0, 1_000),
      });
    }
  }
  const [row] = await core.db
    .update(queueAnnouncements)
    .set({ message, translations })
    .where(eq(queueAnnouncements.id, announcementId))
    .returning();
  if (!row) return formError('notFound');
  if (!row.expiresAt || row.expiresAt > new Date()) {
    // A global announcement (no event) is shown in every shop room: re-broadcast it to all
    // events that can have one open.
    const targets = row.eventId
      ? [row.eventId]
      : (
          await core.db
            .select({ id: events.id })
            .from(events)
            .where(inArray(events.status, ['PUBLISHED', 'POSTPONED']))
        ).map((e) => e.id);
    for (const eventId of targets) {
      await publishQueueUpdate(core, {
        type: 'announcement',
        eventId,
        id: row.id,
        message: row.message,
        translations: row.translations,
        severity: row.severity,
        publishedAt: row.publishedAt.toISOString(),
      });
    }
  }
  await audit(core.db, session, 'queue.announcement.update', 'queue_announcement', announcementId);
  await refreshShop([SHOP_TAGS.queue]);
  return success('saved');
}

/** Ends an announcement immediately (keeps it for history). */
export async function expireAnnouncementAction(
  announcementId: string,
  _prev: ActionState,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const { db } = getCore();
  const updated = await db
    .update(queueAnnouncements)
    .set({ expiresAt: new Date() })
    .where(eq(queueAnnouncements.id, announcementId))
    .returning({ eventId: queueAnnouncements.eventId });
  if (updated.length === 0) return formError('notFound');
  await audit(db, session, 'queue.announcement.expire', 'queue_announcement', announcementId);
  await refreshShop([SHOP_TAGS.queue]);
  return success('saved');
}

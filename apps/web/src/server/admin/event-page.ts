'use server';

import { symbolsByIds, eventTags } from '@tix/core';
import { events, withTransaction } from '@tix/db';
import {
  INFO_BOX_SIZES,
  MAX_EVENT_INFO_BOXES,
  normalizePageLayout,
  type EventInfoBox,
} from '@tix/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ActionState } from '@/lib/action-state';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { richTextToPlain, sanitizeRichText } from '@/server/rich-text';
import { audit } from './audit';
import { refreshShop } from './shop-refresh';
import { getEventWithVenue } from './queries';
import { formError, success, text } from './form';

const boxMetaSchema = z
  .array(
    z.object({
      id: z.uuid(),
      title: z.string().trim().max(120),
      symbolId: z.uuid().nullable(),
      textSize: z.enum(INFO_BOX_SIZES).default('M'),
      iconSize: z.enum(INFO_BOX_SIZES).default('M'),
    }),
  )
  .max(MAX_EVENT_INFO_BOXES);

/**
 * Saves the event page: block order (drag & drop) and info boxes. Box contents arrive as
 * `content:<id>` rich-text fields and are sanitised like the event description; unknown
 * symbols are dropped, boxes without title and text are removed.
 */
export async function updateEventPageAction(
  eventId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const row = await getEventWithVenue(eventId);
  if (!row) return formError('notFound');

  let layoutRaw: unknown;
  let boxesRaw: unknown;
  try {
    layoutRaw = JSON.parse(text(fd, 'layout') ?? '[]');
    boxesRaw = JSON.parse(text(fd, 'boxes') ?? '[]');
  } catch {
    return formError('generic');
  }
  const meta = boxMetaSchema.safeParse(boxesRaw);
  if (!meta.success) return formError('generic');

  const { db } = getCore();
  const known = new Set(
    (
      await symbolsByIds(
        db,
        meta.data.flatMap((b) => (b.symbolId ? [b.symbolId] : [])),
      )
    ).map((s) => s.id),
  );
  // Read-merge-write under the event row lock: a concurrent translation save (which locks the
  // same row) cannot be overwritten with a stale copy of the boxes.
  const { pageLayout, infoBoxes } = await withTransaction(db, async (tx) => {
    const [locked] = await tx
      .select({ infoBoxes: events.infoBoxes })
      .from(events)
      .where(eq(events.id, eventId))
      .for('update');
    if (!locked) return { pageLayout: null, infoBoxes: [] as EventInfoBox[] };
    // Translations of existing boxes survive a save of the base texts.
    const existing = new Map(locked.infoBoxes.map((b) => [b.id, b.translations]));
    const boxes: EventInfoBox[] = meta.data
      .map((b) => {
        const translations = existing.get(b.id);
        const html = sanitizeRichText(text(fd, `content:${b.id}`));
        return {
          id: b.id,
          title: b.title,
          symbolId: b.symbolId && known.has(b.symbolId) ? b.symbolId : null,
          content: richTextToPlain(html) !== '' ? html : '',
          textSize: b.textSize,
          iconSize: b.iconSize,
          ...(translations && Object.keys(translations).length ? { translations } : {}),
        };
      })
      .filter((b) => b.title !== '' || b.content !== '');
    // Rows of blocks side by side; removed / empty boxes drop out of the layout.
    const layout = normalizePageLayout(
      layoutRaw,
      boxes.map((b) => b.id),
    );
    await tx
      .update(events)
      .set({ pageLayout: layout, infoBoxes: boxes })
      .where(eq(events.id, eventId));
    return { pageLayout: layout, infoBoxes: boxes };
  });
  if (!pageLayout) return formError('notFound');

  await audit(db, session, 'event.page', 'event', eventId, {
    pageLayout,
    infoBoxes: infoBoxes.map((b) => ({ id: b.id, title: b.title, symbolId: b.symbolId })),
  });
  await refreshShop(eventTags(eventId));
  return success('saved');
}

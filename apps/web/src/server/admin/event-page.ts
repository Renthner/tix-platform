'use server';

import { symbolsByIds } from '@tix/core';
import { events } from '@tix/db';
import {
  INFO_BOX_SIZES,
  MAX_EVENT_INFO_BOXES,
  normalizePageLayout,
  type EventInfoBox,
} from '@tix/shared';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState } from '@/lib/action-state';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { richTextToPlain, sanitizeRichText } from '@/server/rich-text';
import { audit } from './audit';
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
  const infoBoxes: EventInfoBox[] = meta.data
    .map((b) => {
      const html = sanitizeRichText(text(fd, `content:${b.id}`));
      return {
        id: b.id,
        title: b.title,
        symbolId: b.symbolId && known.has(b.symbolId) ? b.symbolId : null,
        content: richTextToPlain(html) !== '' ? html : '',
        textSize: b.textSize,
        iconSize: b.iconSize,
      };
    })
    .filter((b) => b.title !== '' || b.content !== '');
  // Rows of blocks side by side; removed / empty boxes drop out of the layout.
  const pageLayout = normalizePageLayout(
    layoutRaw,
    infoBoxes.map((b) => b.id),
  );

  await db.update(events).set({ pageLayout, infoBoxes }).where(eq(events.id, eventId));
  await audit(db, session, 'event.page', 'event', eventId, {
    pageLayout,
    infoBoxes: infoBoxes.map((b) => ({ id: b.id, title: b.title, symbolId: b.symbolId })),
  });
  revalidatePath('/', 'layout');
  return success('saved');
}

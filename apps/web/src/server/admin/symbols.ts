'use server';

import { DomainError, createSymbol, forgetSeatMapVersion, publishSeatDelta } from '@tix/core';
import { events, seatMapElements, seatMaps, seats, svgSymbols, withTransaction } from '@tix/db';
import { SYMBOL_KINDS } from '@tix/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionState, FieldErrorCode } from '@/lib/action-state';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { fieldError, flag, formError, success, text, zodFieldErrors } from './form';

const MAX_SVG_BYTES = 200_000;

const SVG_ERRORS: Record<string, FieldErrorCode> = {
  SVG_TOO_LARGE: 'svgTooLarge',
  SVG_INVALID: 'svgInvalid',
  SVG_EMPTY: 'svgEmpty',
  SVG_TOO_COMPLEX: 'svgTooComplex',
};

const uploadSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(SYMBOL_KINDS),
});

export async function uploadSymbolAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const parsed = uploadSchema.safeParse({ name: text(fd, 'name'), kind: text(fd, 'kind') });
  const errors: Partial<Record<string, FieldErrorCode>> = parsed.success
    ? {}
    : zodFieldErrors(parsed.error);
  const file = fd.get('file');
  if (!(file instanceof File) || file.size === 0) errors.file = 'fileRequired';
  else if (file.size > MAX_SVG_BYTES) errors.file = 'svgTooLarge';
  else if (file.type && !['image/svg+xml', 'text/xml', 'application/xml', ''].includes(file.type))
    errors.file = 'svgInvalid';
  if (!parsed.success || Object.keys(errors).length > 0) return fieldError(errors);

  const core = getCore();
  try {
    const symbol = await createSymbol(core.db, {
      name: parsed.data.name,
      kind: parsed.data.kind,
      svg: await (file as File).text(),
      colorize: flag(fd, 'colorize'),
      createdByUserId: session.userId,
    });
    await audit(core.db, session, 'symbol.create', 'svg_symbol', symbol.id, {
      name: symbol.name,
      kind: symbol.kind,
      colorize: symbol.colorize,
    });
  } catch (err) {
    if (err instanceof DomainError && SVG_ERRORS[err.code])
      return fieldError({ file: SVG_ERRORS[err.code] });
    throw err;
  }
  revalidatePath('/', 'layout');
  return success('created');
}

export async function renameSymbolAction(
  symbolId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const name = z.string().min(1).max(120).safeParse(text(fd, 'name'));
  if (!name.success) return fieldError({ name: zodFieldErrors(name.error)._ ?? 'required' });
  const { db } = getCore();
  const updated = await db
    .update(svgSymbols)
    .set({ name: name.data })
    .where(eq(svgSymbols.id, symbolId))
    .returning({ id: svgSymbols.id });
  if (updated.length === 0) return formError('notFound');
  await audit(db, session, 'symbol.rename', 'svg_symbol', symbolId, { name: name.data });
  revalidatePath('/', 'layout');
  return success('saved');
}

/**
 * Deletes an uploaded symbol. Seats fall back to the default shape (FK SET NULL); references
 * in element styles and seat-map defaults are removed and the affected plans get a new version
 * so editors and the public seating chart reload. Built-in symbols cannot be deleted.
 */
export async function deleteSymbolAction(
  symbolId: string,
  _prev: ActionState,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const core = getCore();
  const [symbol] = await core.db.select().from(svgSymbols).where(eq(svgSymbols.id, symbolId));
  if (!symbol) return formError('notFound');
  if (symbol.builtinKey) return formError('builtinSymbol');

  const touched = await withTransaction(core.db, async (tx) => {
    const [seatMapsOfSeats, mapsOfElements, mapsWithDefault] = await Promise.all([
      tx.selectDistinct({ id: seats.seatMapId }).from(seats).where(eq(seats.symbolId, symbolId)),
      tx
        .selectDistinct({ id: seatMapElements.seatMapId })
        .from(seatMapElements)
        .where(sql`${seatMapElements.style}->>'symbolId' = ${symbolId}`),
      tx
        .select({ id: seatMaps.id })
        .from(seatMaps)
        .where(sql`${seatMaps.settings}->>'defaultSeatSymbolId' = ${symbolId}`),
    ]);
    const mapIds = [
      ...new Set([...seatMapsOfSeats, ...mapsOfElements, ...mapsWithDefault].map((m) => m.id)),
    ];

    await tx
      .update(seatMapElements)
      .set({ style: sql`${seatMapElements.style} - 'symbolId'` })
      .where(sql`${seatMapElements.style}->>'symbolId' = ${symbolId}`);
    await tx
      .update(seatMaps)
      .set({ settings: sql`${seatMaps.settings} - 'defaultSeatSymbolId'` })
      .where(sql`${seatMaps.settings}->>'defaultSeatSymbolId' = ${symbolId}`);
    await tx.delete(svgSymbols).where(eq(svgSymbols.id, symbolId));

    let bumped: { id: string; version: number }[] = [];
    if (mapIds.length > 0) {
      bumped = await tx
        .update(seatMaps)
        .set({ version: sql`${seatMaps.version} + 1` })
        .where(inArray(seatMaps.id, mapIds))
        .returning({ id: seatMaps.id, version: seatMaps.version });
    }
    await audit(tx, session, 'symbol.delete', 'svg_symbol', symbolId, {
      name: symbol.name,
      seatMaps: mapIds.length,
    });
    return bumped;
  });

  if (touched.length > 0) {
    for (const map of touched) forgetSeatMapVersion(map.id);
    const affectedEvents = await core.db
      .select({ id: events.id, seatMapId: events.seatMapId })
      .from(events)
      .where(
        inArray(
          events.seatMapId,
          touched.map((m) => m.id),
        ),
      );
    const versionOf = new Map(touched.map((m) => [m.id, m.version]));
    for (const event of affectedEvents) {
      await publishSeatDelta(core, {
        eventId: event.id,
        seats: [],
        version: versionOf.get(event.seatMapId!),
      });
    }
  }
  revalidatePath('/', 'layout');
  return success('deleted');
}

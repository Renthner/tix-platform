import { priceCategories, priceCategoryTicketTypes, ticketTypes, type Transaction } from '@tix/db';
import { and, eq } from 'drizzle-orm';

export interface PriceCategoryUpdateValues {
  name: string;
  description: string | null;
  color: string;
  maxTicketsPerOrder: number | null;
  sortOrder: number;
  basePrice: number;
  isActive: boolean;
  bestAvailableEnabled: boolean;
}

/**
 * Updates a price category inside the caller's transaction (event row already locked).
 *
 * Narrow auto-activation: categories created by plan replace / plan import / event import carry a
 * price of 0 and are inactive. When such a category (inactive AND old price 0) gets a price above 0,
 * it becomes sellable at once: set active and offered in every tariff of the event (missing matrix
 * rows only, existing rows are never touched). Deliberately deactivated categories that already had
 * a price are left alone.
 *
 * Returns `null` when the category does not exist, else whether it was auto-activated.
 */
export async function updatePriceCategoryTx(
  tx: Transaction,
  eventId: string,
  categoryId: string,
  values: PriceCategoryUpdateValues,
): Promise<{ activated: boolean; values: PriceCategoryUpdateValues } | null> {
  const [before] = await tx
    .select({ basePrice: priceCategories.basePrice, isActive: priceCategories.isActive })
    .from(priceCategories)
    .where(and(eq(priceCategories.id, categoryId), eq(priceCategories.eventId, eventId)))
    .for('update');
  if (!before) return null;

  const activated = !before.isActive && before.basePrice === 0 && values.basePrice > 0;
  const next = activated ? { ...values, isActive: true } : values;
  await tx
    .update(priceCategories)
    .set(next)
    .where(and(eq(priceCategories.id, categoryId), eq(priceCategories.eventId, eventId)));

  if (activated) {
    const types = await tx
      .select({ id: ticketTypes.id })
      .from(ticketTypes)
      .where(eq(ticketTypes.eventId, eventId));
    if (types.length > 0) {
      await tx
        .insert(priceCategoryTicketTypes)
        .values(types.map((t) => ({ priceCategoryId: categoryId, ticketTypeId: t.id })))
        .onConflictDoNothing();
    }
  }
  return { activated, values: next };
}

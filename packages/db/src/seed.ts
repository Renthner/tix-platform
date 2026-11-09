import {
  BUILTIN_SYMBOLS,
  DEFAULT_TICKET_PAGE_MM,
  PUBLIC_SETTING_KEYS,
  defaultSetting,
  defaultTicketLayout,
} from '@tix/shared';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from './client';
import { defaultEmailTemplates } from './email-templates';
import { upgradeUneditedEmailTemplates } from './email-template-upgrade';
import {
  emailTemplates,
  queueConfigs,
  svgSymbols,
  systemSettings,
  taxRates,
  ticketTemplates,
} from './schema';

/**
 * Idempotent bootstrap of reference data. Safe to run on every deployment:
 *  - settings: inserts missing keys with their registry defaults, never overwrites,
 *  - tax rates: only when the table is empty (admins may rename/delete them later),
 *  - global waiting-room config: only when absent,
 *  - e-mail templates: missing key/locale defaults inserted; rows still equal to an earlier
 *    shipped default are upgraded; admin edits are never overwritten.
 * All values are initial defaults and fully editable in the Admin Portal afterwards.
 */
export async function seedReferenceData(
  db: Database,
  log: (message: string) => void = console.log,
): Promise<void> {
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(systemSettings)
      .values(PUBLIC_SETTING_KEYS.map((key) => ({ key, value: defaultSetting(key) })))
      .onConflictDoNothing({ target: systemSettings.key })
      .returning({ key: systemSettings.key });
    log(
      `[seed] settings: ${inserted.length} inserted, ${PUBLIC_SETTING_KEYS.length - inserted.length} kept`,
    );

    const [taxCount] = await tx.select({ n: count() }).from(taxRates);
    if (taxCount?.n === 0) {
      await tx.insert(taxRates).values([
        {
          name: 'USt. 7 % (Eintrittsberechtigungen)',
          rateBasisPoints: 700,
          isDefault: true,
          sortOrder: 10,
        },
        { name: 'USt. 19 %', rateBasisPoints: 1900, sortOrder: 20 },
        {
          name: 'Kleinunternehmer (§ 19 UStG)',
          rateBasisPoints: 0,
          invoiceNote: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
          sortOrder: 30,
        },
        {
          name: 'Steuerfrei (§ 4 Nr. 20 UStG)',
          rateBasisPoints: 0,
          invoiceNote: 'Steuerfreie Leistung gemäß § 4 Nr. 20 UStG.',
          sortOrder: 40,
        },
      ]);
      log('[seed] tax rates: 4 defaults inserted');
    } else {
      log(`[seed] tax rates: ${taxCount?.n ?? 0} present, skipped`);
    }

    const existingQueue = await tx
      .select({ id: queueConfigs.id })
      .from(queueConfigs)
      .where(isNull(queueConfigs.eventId))
      .limit(1);
    if (existingQueue.length === 0) {
      await tx.insert(queueConfigs).values({
        eventId: null,
        mode: 'OFF',
        activeSessionThreshold: 250,
        admissionBatchSize: 50,
        admissionIntervalSeconds: 30,
        passTokenTtlSeconds: 900,
        lobbyOpensMinutesBefore: 60,
        admissionOrder: 'RANDOMIZED',
        accessCodeBypassesQueue: true,
      });
      log('[seed] global queue config inserted');
    } else {
      log('[seed] global queue config present, skipped');
    }

    const templates = defaultEmailTemplates();
    const insertedTemplates = await tx
      .insert(emailTemplates)
      .values(templates.map((t) => ({ ...t, eventId: null })))
      // (key, event_id, locale) is unique NULLS NOT DISTINCT – existing rows stay untouched.
      .onConflictDoNothing()
      .returning({ id: emailTemplates.id });
    log(
      `[seed] e-mail templates: ${insertedTemplates.length} inserted, ${templates.length - insertedTemplates.length} kept`,
    );
    // Rows that still hold a previous shipped default (never edited) follow the new default.
    const upgradedTemplates = await upgradeUneditedEmailTemplates(tx);
    if (upgradedTemplates.length > 0) {
      log(`[seed] e-mail templates upgraded to the new default: ${upgradedTemplates.join(', ')}`);
    }

    // Built-in ticket design as the global default – insert-only: only when no default exists
    // (the unique index on the default flag makes the insert a no-op otherwise).
    const insertedTicketTemplate = await tx
      .insert(ticketTemplates)
      .values({
        eventId: null,
        name: 'Standard',
        description: null,
        pageWidthMm: DEFAULT_TICKET_PAGE_MM.width,
        pageHeightMm: DEFAULT_TICKET_PAGE_MM.height,
        layout: defaultTicketLayout(),
        isDefault: true,
      })
      .onConflictDoNothing()
      .returning({ id: ticketTemplates.id });
    // A design that still holds the previous shipped name/description (never renamed) follows.
    await tx
      .update(ticketTemplates)
      .set({ name: 'Standard', description: null })
      .where(
        and(
          isNull(ticketTemplates.eventId),
          eq(ticketTemplates.isDefault, true),
          eq(ticketTemplates.name, 'Standard ticket'),
          eq(ticketTemplates.description, 'Cover band, event data and QR code'),
        ),
      );
    log(
      `[seed] default ticket design: ${insertedTicketTemplate.length > 0 ? 'inserted' : 'present, skipped'}`,
    );

    const symbols = await tx
      .insert(svgSymbols)
      .values(
        BUILTIN_SYMBOLS.map((s) => ({
          name: s.name,
          kind: s.kind,
          viewBox: s.viewBox,
          markup: s.markup,
          colorize: true,
          builtinKey: s.key,
        })),
      )
      // Built-ins follow the code: artwork updates are applied on deploy (the admin-chosen
      // name is kept). Unchanged rows are not touched.
      .onConflictDoUpdate({
        target: svgSymbols.builtinKey,
        targetWhere: sql`${svgSymbols.builtinKey} IS NOT NULL`,
        set: {
          kind: sql`excluded.kind`,
          viewBox: sql`excluded.view_box`,
          markup: sql`excluded.markup`,
          updatedAt: sql`now()`,
        },
        setWhere: sql`${svgSymbols.markup} IS DISTINCT FROM excluded.markup OR ${svgSymbols.viewBox} IS DISTINCT FROM excluded.view_box`,
      })
      .returning({ id: svgSymbols.id });
    log(`[seed] symbols: ${symbols.length} built-in symbols inserted or updated`);
    if (symbols.length > 0) {
      // New artwork must reach the shop: bump the version of every plan using a changed
      // symbol (the public snapshot cache is keyed by plan version).
      // (ids are uuids generated by the DB – passed as one text[] parameter)
      const ids = sql.param(`{${symbols.map((row) => row.id).join(',')}}`);
      await tx.execute(sql`
        UPDATE seat_maps SET version = version + 1, updated_at = now()
        WHERE id IN (
          SELECT seat_map_id FROM seats WHERE symbol_id::text = ANY(${ids}::text[])
          UNION SELECT seat_map_id FROM seat_map_elements WHERE style->>'symbolId' = ANY(${ids}::text[])
          UNION SELECT id FROM seat_maps WHERE settings->>'defaultSeatSymbolId' = ANY(${ids}::text[])
        )`);
    }
  });
}

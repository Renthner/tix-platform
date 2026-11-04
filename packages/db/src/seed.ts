import { PUBLIC_SETTING_KEYS, defaultSetting } from '@tix/shared';
import { count, isNull } from 'drizzle-orm';
import type { Database } from './client';
import { queueConfigs, systemSettings, taxRates } from './schema';

/**
 * Idempotent bootstrap of reference data. Safe to run on every deployment:
 *  - settings: inserts missing keys with their registry defaults, never overwrites,
 *  - tax rates: only when the table is empty (admins may rename/delete them later),
 *  - global waiting-room config: only when absent.
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
  });
}

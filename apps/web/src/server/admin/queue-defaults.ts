import 'server-only';
import type { QueueConfigValues } from '@/components/admin/queue-forms';
import { getQueueConfigRow } from './queries';

/** Form values of a queue config row, falling back to the global row, then to built-in defaults. */
export async function queueFormValues(
  eventId: string | null,
): Promise<{ values: QueueConfigValues; hasOwnRow: boolean }> {
  const own = await getQueueConfigRow(eventId);
  const source = own ?? (eventId ? await getQueueConfigRow(null) : null);
  const values: QueueConfigValues = source
    ? {
        mode: source.mode,
        activeSessionThreshold: source.activeSessionThreshold,
        admissionBatchSize: source.admissionBatchSize,
        admissionIntervalSeconds: source.admissionIntervalSeconds,
        passTokenTtlSeconds: source.passTokenTtlSeconds,
        lobbyOpensMinutesBefore: source.lobbyOpensMinutesBefore,
        admissionOrder: source.admissionOrder,
        accessCodeBypassesQueue: source.accessCodeBypassesQueue,
        maxQueueSize: source.maxQueueSize,
        isPaused: source.isPaused,
        title: source.title,
        message: source.message,
      }
    : {
        mode: 'OFF',
        activeSessionThreshold: 250,
        admissionBatchSize: 50,
        admissionIntervalSeconds: 30,
        passTokenTtlSeconds: 900,
        lobbyOpensMinutesBefore: 60,
        admissionOrder: 'RANDOMIZED',
        accessCodeBypassesQueue: true,
        maxQueueSize: null,
        isPaused: false,
        title: null,
        message: null,
      };
  return { values, hasOwnRow: own !== null };
}

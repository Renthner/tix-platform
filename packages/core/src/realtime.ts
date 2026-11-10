import type { AnnouncementSeverity, SeatDeltaMessage, Translations } from '@tix/shared';
import type { CoreContext } from './context';

/**
 * Fan-out messages published to Redis Pub/Sub and delivered to browsers by the realtime
 * service (Socket.io). Publishers never talk to sockets directly, so web, worker and any
 * number of realtime instances scale independently.
 */

export type QueueBroadcast =
  | { type: 'cursor'; eventId: string; cursor: number; waiting: number; at: number }
  | { type: 'state'; eventId: string; state: 'OPEN' | 'PAUSED' | 'DRAWN' }
  | {
      type: 'announcement';
      eventId: string;
      id: string;
      message: string;
      /** Translations of `message`; clients resolve them for their locale. */
      translations?: Translations;
      severity: AnnouncementSeverity;
      publishedAt: string;
    };

export type SessionMessage = { type: 'admitted'; eventId: string; claimWithinSeconds: number };

type Publisher = Pick<CoreContext, 'publisher' | 'channels'>;

export async function publishSeatDelta(ctx: Publisher, message: SeatDeltaMessage): Promise<void> {
  if (message.seats.length === 0 && !message.ga && message.version === undefined) return;
  await ctx.publisher.publish(ctx.channels.seatUpdates(message.eventId), JSON.stringify(message));
}

export async function publishQueueUpdate(ctx: Publisher, message: QueueBroadcast): Promise<void> {
  await ctx.publisher.publish(ctx.channels.queueUpdates(message.eventId), JSON.stringify(message));
}

export async function publishSessionMessage(
  ctx: Publisher,
  sessionId: string,
  message: SessionMessage,
): Promise<void> {
  await ctx.publisher.publish(ctx.channels.sessionMessages(sessionId), JSON.stringify(message));
}

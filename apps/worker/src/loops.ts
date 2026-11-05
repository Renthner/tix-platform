import { sweepExpiredLocks, tickWaitingRooms, type CoreContext } from '@tix/core';
import type { Logger } from './logger';

/**
 * High-frequency loops (seat lock sweeper, waiting-room ticker). They run every second,
 * which is too frequent for BullMQ repeatable jobs, so they run in-process under a Redis
 * leader lock: with several worker replicas exactly one executes them, and another takes
 * over within LEASE_MS if the leader dies.
 */

const TICK_MS = 1_000;
const LEASE_MS = 5_000;

const RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') and 1 or 0
`;

export interface Loops {
  stop(): Promise<void>;
  isLeader(): boolean;
}

export function startLoops(ctx: CoreContext, workerId: string, logger: Logger): Loops {
  const lockKey = ctx.keys.mutex('worker-loops');
  let leader = false;
  let running = true;
  let current: Promise<void> = Promise.resolve();

  const iteration = async () => {
    try {
      const acquired = (await ctx.redis.eval(RENEW, 1, lockKey, workerId, LEASE_MS)) === 1;
      if (acquired !== leader) logger.info({ leader: acquired }, 'loop leadership changed');
      leader = acquired;
      if (!leader) return;
      const released = await sweepExpiredLocks(ctx);
      if (released > 0) logger.debug({ released }, 'expired seat locks released');
      await tickWaitingRooms(ctx);
    } catch (err) {
      logger.error({ err }, 'loop iteration failed');
    }
  };

  const schedule = () => {
    if (!running) return;
    current = iteration().finally(() => {
      if (running) setTimeout(schedule, TICK_MS);
    });
  };
  schedule();

  return {
    isLeader: () => leader,
    async stop() {
      running = false;
      await current;
      if (leader) {
        await ctx.redis.eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
          1,
          lockKey,
          workerId,
        );
      }
    },
  };
}

import {
  createMaintenanceProbe,
  reapExpiredLoadTest,
  sweepExpiredLocks,
  tickWaitingRooms,
  type CoreContext,
} from '@tix/core';
import type { Logger } from './logger';

/**
 * High-frequency loops (seat lock sweeper, waiting-room ticker). They run every second,
 * which is too frequent for BullMQ repeatable jobs, so they run in-process under a Redis
 * leader lock: with several worker replicas exactly one executes them, and another takes
 * over within LEASE_MS if the leader dies.
 */

const TICK_MS = 1_000;
/** Renewed at the start and after every step, so the lease cannot expire between steps (a single step that outlasts 15 s still can lose it). */
const LEASE_MS = 15_000;

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
  const maintenance = createMaintenanceProbe(ctx);

  const renew = async (): Promise<boolean> =>
    (await ctx.redis.eval(RENEW, 1, lockKey, workerId, LEASE_MS)) === 1;

  const iteration = async () => {
    try {
      const acquired = await renew();
      if (acquired !== leader) logger.info({ leader: acquired }, 'loop leadership changed');
      leader = acquired;
      if (!leader) return;
      // The database is being replaced (restore): the sweepers must not touch it.
      if (await maintenance()) return;
      // Each step is followed by a lease renewal; a lost lease aborts the remaining steps so two
      // workers never run the loops at once.
      const stillLeader = async (): Promise<boolean> => {
        if (await renew()) return true;
        leader = false;
        logger.warn('loop leadership lost mid-iteration: aborting remaining steps');
        return false;
      };
      const released = await sweepExpiredLocks(ctx);
      if (released > 0) logger.debug({ released }, 'expired seat locks released');
      if (!(await stillLeader())) return;
      await tickWaitingRooms(ctx);
      if (!(await stillLeader())) return;
      // Load test mode: exactly-once "expired" audit entry once the time is up (one Redis GET).
      await reapExpiredLoadTest(ctx);
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

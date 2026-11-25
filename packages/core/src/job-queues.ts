import { QUEUE_NAMES, type QueueName, type Redis } from '@tix/redis';
import { Queue, type JobsOptions } from 'bullmq';

/** BullMQ job states in which a job will still run. */
export const LIVE_JOB_STATES: ReadonlySet<string> = new Set([
  'waiting',
  'delayed',
  'active',
  'prioritized',
  'waiting-children',
]);

/**
 * BullMQ producers for all queues (web and worker enqueue through this; the worker owns the
 * consumers). Queues are created lazily and share one BullMQ connection.
 */
export class JobQueues {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(
    private readonly connection: Redis,
    private readonly prefix?: string,
  ) {}

  queue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.connection,
        ...(this.prefix ? { prefix: this.prefix } : {}),
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: { age: 7 * 24 * 3600, count: 10_000 },
          removeOnFail: { age: 30 * 24 * 3600 },
        },
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  async add<T extends object>(
    name: QueueName,
    jobName: string,
    data: T,
    options?: JobsOptions,
  ): Promise<string> {
    const job = await this.queue(name).add(jobName, data, options);
    return job.id ?? '';
  }

  /**
   * Adds a job under a fixed id unless a job with that id will still run (waiting / delayed /
   * active …). A finished (completed / failed) job with the id is removed first, so a resume or a
   * sweeper re-queue really queues work instead of being swallowed by BullMQ's id dedupe.
   * Returns false when a live job already exists.
   */
  async addUnlessLive<T extends object>(
    name: QueueName,
    jobName: string,
    data: T,
    options: JobsOptions & { jobId: string },
  ): Promise<boolean> {
    const queue = this.queue(name);
    const existing = await queue.getJob(options.jobId);
    if (existing) {
      if (LIVE_JOB_STATES.has(await existing.getState())) return false;
      try {
        await existing.remove();
      } catch {
        // Removing failed – usually picked up by a worker in the meantime (locked, live again),
        // but it may also have finished or been removed concurrently. Look again.
        const again = await queue.getJob(options.jobId);
        if (again) {
          if (LIVE_JOB_STATES.has(await again.getState())) return false;
          try {
            await again.remove();
          } catch {
            return false;
          }
        }
      }
    }
    await queue.add(jobName, data, options);
    return true;
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
  }
}

export { QUEUE_NAMES };

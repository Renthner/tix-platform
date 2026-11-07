import { QUEUE_NAMES, type QueueName, type Redis } from '@tix/redis';
import { Queue, type JobsOptions } from 'bullmq';

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

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
  }
}

export { QUEUE_NAMES };

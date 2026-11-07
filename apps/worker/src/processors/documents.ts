import { DomainError, processPaidOrder, renderInvoicePdf } from '@tix/core';
import { QUEUE_NAMES } from '@tix/redis';
import { UnrecoverableError, type Job } from 'bullmq';
import type { ProcessorRegistration, WorkerDeps } from './index';

export const DOCUMENT_JOBS = {
  /** `{ orderId }` – queued by `recordPayment` once an order is PAID (jobId order-paid-<id>). */
  orderPaid: 'order-paid',
  /** `{ invoiceId }` – renders and archives the invoice PDF. */
  renderInvoice: 'render-invoice',
} as const;

function stringField(job: Job, field: string): string {
  const value = (job.data as Record<string, unknown>)[field];
  if (typeof value !== 'string') throw new UnrecoverableError(`Job without ${field}`);
  return value;
}

export function createDocumentsProcessor(deps: WorkerDeps) {
  return async (job: Job): Promise<unknown> => {
    try {
      switch (job.name) {
        case DOCUMENT_JOBS.orderPaid: {
          const orderId = stringField(job, 'orderId');
          const result = await processPaidOrder(deps.core, orderId);
          if (result.invoiceError) {
            deps.logger.error(
              { orderId, error: result.invoiceError },
              'invoice could not be issued – payment confirmation sent without invoice',
            );
          }
          deps.logger.info({ orderId, ...result }, 'paid order fulfilled');
          return result;
        }
        case DOCUMENT_JOBS.renderInvoice: {
          const invoiceId = stringField(job, 'invoiceId');
          const result = await renderInvoicePdf(deps.core, invoiceId);
          deps.logger.info({ invoiceId, ...result }, 'invoice PDF stored');
          return result;
        }
        default:
          deps.logger.warn({ job: job.name }, 'unknown documents job');
          return null;
      }
    } catch (err) {
      // Not-found and similar business errors will not heal by retrying.
      if (err instanceof DomainError && err.status < 500) {
        throw new UnrecoverableError(`${err.code}: ${err.message}`);
      }
      throw err;
    }
  };
}

export function documentsRegistration(deps: WorkerDeps): ProcessorRegistration {
  return {
    queue: QUEUE_NAMES.documents,
    concurrency: 2,
    processor: createDocumentsProcessor(deps),
  };
}

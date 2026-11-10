import type { OrderAdminView } from '@tix/core';
import { getFormatter, getTranslations } from 'next-intl/server';

type Data = Record<string, unknown>;

interface Entry {
  key: string;
  at: Date;
  title: string;
  lines: string[];
  meta: string;
  failed?: boolean;
}

const asData = (value: unknown): Data =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {};
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * Order history + e-mails of the order as one chronological timeline (newest first).
 * Every entry type renders what happened from its stored `data`; unknown types and data that was
 * erased by a privacy request (null values) degrade to the plain type label.
 */
export async function OrderTimeline({ view }: { view: OrderAdminView }) {
  const [t, tStatus, tMethod, tChannel, tKeys, format] = await Promise.all([
    getTranslations('orders.admin.history'),
    getTranslations('orders.status'),
    getTranslations('orders.method'),
    getTranslations('orders.channel'),
    getTranslations('emailTemplates.keys'),
    getFormatter(),
  ]);
  const { order } = view;
  // Dynamic keys: next-intl's typed keys do not cover runtime strings.
  const tr = (key: string, values?: Record<string, string | number>) =>
    (t as unknown as (k: string, v?: Record<string, string | number>) => string)(key, values);
  const has = (key: string) => (t as unknown as { has: (k: string) => boolean }).has(key);
  const dateTime = (d: Date | string) =>
    format.dateTime(new Date(d), { dateStyle: 'medium', timeStyle: 'short' });
  const money = (cents: number) =>
    format.number(cents / 100, { style: 'currency', currency: order.currency });
  const moneyOf = (value: unknown) => {
    const n = num(value);
    return n === null ? null : money(n);
  };
  const method = (value: unknown) => {
    const m = str(value);
    if (!m) return null;
    return ['PAYPAL', 'BANK_TRANSFER', 'CASH', 'CARD', 'COMPLIMENTARY'].includes(m)
      ? tMethod(m as 'PAYPAL')
      : m;
  };
  const templateName = (key: string | null) =>
    key
      ? tKeys.has(`${key}.name` as never)
        ? tKeys(`${key}.name` as never)
        : key
      : tr('email.unknownTemplate');

  const itemLabels = new Map<string, string>();
  for (const event of view.events) {
    for (const item of event.items) {
      itemLabels.set(
        item.id,
        item.kind === 'SEAT'
          ? tr('place', {
              section: item.sectionLabel,
              row: item.rowLabel ?? '–',
              seat: item.seatLabel ?? '–',
            })
          : tr('placeStanding', { section: item.sectionLabel }),
      );
    }
  }
  const place = (value: unknown): string => {
    const p = asData(value);
    const section = str(p.sectionLabel) ?? '–';
    const row = str(p.rowLabel);
    const seat = str(p.seatLabel) ?? '–';
    return row ? tr('place', { section, row, seat }) : tr('placeNoRow', { section, seat });
  };
  const items = (value: unknown): string | null => {
    const labels = list(value)
      .map((id) => (typeof id === 'string' ? itemLabels.get(id) : undefined))
      .filter((l): l is string => Boolean(l));
    return labels.length > 0 ? labels.join('; ') : null;
  };

  const detail = (type: string, d: Data, toStatus: string | null): string[] => {
    const lines: (string | null)[] = [];
    const reason = str(d.reason);
    const amountVia = () => {
      const amount = moneyOf(d.amount);
      const m = method(d.method);
      return amount ? (m ? tr('detail.amountVia', { amount, method: m }) : amount) : null;
    };
    switch (type) {
      case 'created': {
        const count = num(d.items);
        lines.push(
          [
            method(d.method),
            moneyOf(d.totalGross),
            count === null ? null : tr('detail.tickets', { count }),
          ]
            .filter(Boolean)
            .join(' · ') || null,
        );
        const reference = str(d.paymentReference);
        if (reference) lines.push(tr('detail.reference', { reference }));
        break;
      }
      case 'status_changed':
        lines.push(amountVia());
        if (reason) lines.push(tr('detail.reason', { reason }));
        {
          const labels = toStatus === 'PAID' ? null : items(d.orderItemIds);
          if (labels) lines.push(tr('detail.items', { items: labels }));
        }
        break;
      case 'payment_received':
        lines.push(amountVia());
        if (d.overpayment === true) lines.push(tr('detail.overpayment'));
        break;
      case 'payment_partial': {
        lines.push(amountVia());
        const open = moneyOf(d.outstanding);
        if (open) lines.push(tr('detail.outstanding', { amount: open }));
        break;
      }
      case 'shortfall_written_off': {
        lines.push(amountVia());
        const shortfall = moneyOf(d.shortfall);
        if (shortfall) lines.push(tr('detail.shortfall', { amount: shortfall }));
        break;
      }
      case 'payment_failed': {
        const provider = str(d.provider);
        const event = str(d.event);
        lines.push([provider, event].filter(Boolean).join(' · ') || null);
        break;
      }
      case 'reminder_sent': {
        const count = num(d.reminderCount);
        if (count !== null) lines.push(tr('detail.reminder', { count }));
        break;
      }
      case 'keep_reserved_changed':
        lines.push(tr(d.keepReserved === true ? 'detail.keepOn' : 'detail.keepOff'));
        if (reason) lines.push(tr('detail.reason', { reason }));
        break;
      case 'email_resent': {
        const template = str(d.template);
        if (template) lines.push(tr('detail.template', { template: templateName(template) }));
        break;
      }
      case 'tickets_resent': {
        const count = num(d.tickets);
        if (count !== null) lines.push(tr('detail.tickets', { count }));
        break;
      }
      case 'late_payment_refunded': {
        const amount = moneyOf(d.amount);
        if (amount) lines.push(amount);
        const failure = str(d.failure);
        if (failure) lines.push(tr('detail.error', { message: failure }));
        break;
      }
      case 'external_refund_notice': {
        const amount = asData(d.amount).value;
        const value = typeof amount === 'string' || typeof amount === 'number' ? amount : null;
        if (value !== null) {
          lines.push(`${value} ${str(asData(d.amount).currency_code) ?? order.currency}`);
        }
        break;
      }
      case 'invoice_issued':
      case 'credit_note_issued': {
        const number = str(d.invoiceNumber);
        const total = moneyOf(d.totalGross);
        lines.push([number, total].filter(Boolean).join(' · ') || null);
        break;
      }
      case 'credit_note_missing': {
        const code = str(d.code);
        if (code) lines.push(tr('detail.code', { code }));
        break;
      }
      case 'paid_order_cancelled': {
        const labels = items(d.orderItemIds);
        if (labels) lines.push(tr('detail.cancelled', { items: labels }));
        const credit = moneyOf(d.creditTotal);
        if (credit) lines.push(tr('detail.credit', { amount: credit }));
        const refund = moneyOf(d.refundTotal);
        if (refund) lines.push(tr('detail.refundTotal', { amount: refund }));
        if (typeof d.refundFees === 'boolean') {
          lines.push(tr(d.refundFees ? 'detail.feesRefunded' : 'detail.feesKept'));
        }
        const note = str(d.creditNote);
        if (note) lines.push(tr('detail.creditNote', { number: note }));
        if (reason) lines.push(tr('detail.reason', { reason }));
        break;
      }
      case 'refund_completed': {
        const amount = moneyOf(d.amount);
        const kind =
          d.kind === 'AUTOMATIC' || d.kind === 'MANUAL' ? tr(`refundKinds.${d.kind}`) : null;
        lines.push([amount, kind].filter(Boolean).join(' · ') || null);
        const note = str(d.note);
        if (note) lines.push(tr('detail.note', { note }));
        break;
      }
      case 'overpayment_refund_requested':
        lines.push(moneyOf(d.amount));
        break;
      case 'refund_failed': {
        const message = str(d.message);
        if (message) lines.push(tr('detail.error', { message }));
        break;
      }
      case 'bank_allocation_reversed': {
        const amount = moneyOf(d.amount);
        if (amount) lines.push(tr('detail.reversed', { amount }));
        if (reason) lines.push(tr('detail.reason', { reason }));
        if (d.reopened === true) lines.push(tr('detail.reopened'));
        const voided = num(d.ticketsVoided);
        if (voided) lines.push(tr('detail.ticketsVoided', { count: voided }));
        const note = str(d.creditNote);
        if (note) lines.push(tr('detail.creditNote', { number: note }));
        break;
      }
      case 'box_office_sale': {
        const channel = str(d.channel);
        const count = num(d.items);
        lines.push(
          [
            channel && ['ONLINE', 'BOX_OFFICE', 'ADMIN'].includes(channel)
              ? tChannel(channel as 'ONLINE')
              : channel,
            method(d.payment),
            moneyOf(d.totalGross),
            count === null ? null : tr('detail.tickets', { count }),
          ]
            .filter(Boolean)
            .join(' · ') || null,
        );
        const overrides = list(d.priceOverrides).length;
        if (overrides > 0) lines.push(tr('detail.priceOverrides', { count: overrides }));
        const blocked = list(d.blockedSeatsSold).length;
        if (blocked > 0) lines.push(tr('detail.blockedSold', { count: blocked }));
        if (reason) lines.push(tr('detail.reason', { reason }));
        break;
      }
      case 'seats_changed': {
        for (const change of list(d.changes)) {
          const c = asData(change);
          lines.push(
            `${place(c.from)} → ${place(c.to)}${c.blockedSeat ? ` (${tr('detail.blockedSeat')})` : ''}`,
          );
        }
        if (reason) lines.push(tr('detail.reason', { reason }));
        if (typeof d.notify === 'boolean') {
          lines.push(tr(d.notify ? 'detail.notified' : 'detail.notNotified'));
        }
        break;
      }
      case 'invoice_correction_needed': {
        const code = str(d.code);
        if (code) lines.push(tr('detail.code', { code }));
        break;
      }
      case 'invoice_corrected': {
        const creditNote = str(d.creditNote);
        if (creditNote) lines.push(tr('detail.creditNote', { number: creditNote }));
        const invoice = str(d.invoice);
        if (invoice) lines.push(tr('detail.invoiceNumber', { number: invoice }));
        break;
      }
      case 'adjustment_proposed':
      case 'adjustment_paid':
      case 'adjustment_cancelled':
      case 'adjustment_confirmed':
      case 'adjustment_reminder_sent': {
        if (d.settledByCredit === true) lines.push(tr('detail.settledByCredit'));
        else lines.push(type === 'adjustment_paid' ? amountVia() : moneyOf(d.amount));
        {
          const credited = moneyOf(type === 'adjustment_paid' ? d.creditUsed : d.creditApplied);
          if (credited && (num(d.creditUsed) ?? num(d.creditApplied) ?? 0) > 0) {
            lines.push(tr('detail.creditUsed', { amount: credited }));
          }
        }
        for (const item of list(d.items)) {
          const i = asData(item);
          const from = moneyOf(i.fromPriceGross);
          const to = moneyOf(i.toPriceGross);
          lines.push(
            tr('detail.tariffChange', {
              from: str(i.fromName) ?? '–',
              to: str(i.toName) ?? '–',
              prices: from && to ? `${from} → ${to}` : '–',
            }),
          );
        }
        const reference = str(d.reference);
        if (reference) lines.push(tr('detail.reference', { reference }));
        if (type === 'adjustment_confirmed' && d.viaPayment === true) {
          lines.push(tr('detail.confirmedByPayment'));
        }
        if (type === 'adjustment_proposed' && typeof d.notify === 'boolean') {
          lines.push(tr(d.notify ? 'detail.notified' : 'detail.notNotified'));
        }
        if (type === 'adjustment_reminder_sent' && d.mailed === false) {
          lines.push(tr('detail.notMailed'));
        }
        const creditNote = str(d.creditNote);
        if (creditNote) lines.push(tr('detail.creditNote', { number: creditNote }));
        const invoice = str(d.invoice);
        if (invoice) lines.push(tr('detail.invoiceNumber', { number: invoice }));
        const reissued = num(d.ticketsReissued);
        if (reissued) lines.push(tr('detail.ticketsReissued', { count: reissued }));
        if (reason) lines.push(tr('detail.reason', { reason }));
        break;
      }
      case 'note_changed': {
        const note = str(d.note);
        lines.push(note ? tr('detail.note', { note }) : tr('detail.noteRemoved'));
        break;
      }
      default:
        if (reason) lines.push(tr('detail.reason', { reason }));
    }
    return lines.filter((l): l is string => Boolean(l));
  };

  const entries: Entry[] = [];
  for (const h of view.history) {
    const typeKey = `types.${h.type}`;
    const status = h.toStatus ? ` → ${tStatus(h.toStatus)}` : '';
    entries.push({
      key: `h-${h.id}`,
      at: new Date(h.createdAt),
      title: `${has(typeKey) ? tr(typeKey) : h.type}${status}`,
      lines: detail(h.type, asData(h.data), h.toStatus),
      meta: h.actorName ?? tr(`actors.${h.actorType}`),
    });
  }
  for (const m of view.emails) {
    const lines = [
      tr('email.to', { email: m.toEmail }),
      tr('email.subject', { subject: m.subject }),
    ];
    if (m.status === 'SENT') {
      lines.push(tr('email.sent', { time: dateTime(m.sentAt ?? m.createdAt) }));
    } else if (m.status === 'FAILED') {
      lines.push(
        tr('email.failed', { attempts: m.attempts, error: m.lastError ?? tr('email.noError') }),
      );
    } else {
      lines.push(tr(m.status === 'SENDING' ? 'email.sending' : 'email.queued'));
      if (m.lastError) lines.push(tr('email.retryError', { error: m.lastError }));
    }
    if (m.attachments.length > 0) {
      lines.push(
        tr('email.attachments', {
          files: m.attachments
            .map((a) =>
              a.kind === 'file' ? (a.name ?? '') : tr(`email.attachmentKinds.${a.kind}`),
            )
            .filter(Boolean)
            .join(', '),
        }),
      );
    }
    entries.push({
      key: `m-${m.id}`,
      at: new Date(m.createdAt),
      title: tr('email.title', { template: templateName(m.templateKey) }),
      lines,
      meta: tr('email.meta'),
      failed: m.status === 'FAILED',
    });
  }
  entries.sort((a, b) => b.at.getTime() - a.at.getTime());

  return (
    <ol className="space-y-3 text-sm">
      {entries.map((e) => (
        <li key={e.key} className="flex gap-3">
          <span className="w-36 shrink-0 text-xs text-muted-foreground">{dateTime(e.at)}</span>
          <div className="min-w-0">
            <div className={e.failed ? 'text-destructive' : undefined}>{e.title}</div>
            {e.lines.map((line, i) => (
              <div key={i} className="break-words text-xs">
                {line}
              </div>
            ))}
            <div className="text-xs text-muted-foreground">{e.meta}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

import type { OrderEventModel, OrderItemLine, OrderTotalsModel } from '@tix/core';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export interface OrderItemsLabels {
  title: string;
  total: string;
  /** Place text of an item (section, row, seat / standing). */
  place: (item: OrderItemLine) => string;
  eventDate: (event: OrderEventModel) => string;
  tax: (tax: OrderTotalsModel['taxes'][number]) => React.ReactNode;
  // Shop
  discount?: (codes: string) => string;
  refundedItem?: string;
  paid?: string;
  refunded?: string;
  // Admin
  columns?: { place: string; category: string; tariff: string; status: string; price: string };
  itemStatus?: (item: OrderItemLine) => string;
}

/**
 * Items of an order per event, followed by the totals block (fees, discount, total, VAT, paid /
 * refunded). Audience variants differ in layout only (shop: list, admin: table) – the numbers come
 * from the shared view model.
 */
export function OrderItemsCard({
  audience,
  events,
  totals,
  money,
  labels,
}: {
  audience: 'shop' | 'admin';
  events: OrderEventModel[];
  totals: OrderTotalsModel;
  money: (cents: number) => string;
  labels: OrderItemsLabels;
}) {
  const shop = audience === 'shop';
  return (
    <Card>
      <CardHeader>
        <CardTitle>{labels.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {events.map((event) =>
          shop ? (
            <div key={event.eventId} className="space-y-2">
              <div>
                <div className="font-medium">{event.title}</div>
                <div className="text-sm text-muted-foreground">
                  {labels.eventDate(event)} · {event.venueName}
                </div>
              </div>
              <ul className="divide-y text-sm">
                {event.items.map((item) => (
                  <li key={item.id} className="flex justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className={item.struck ? 'line-through' : undefined}>
                        {labels.place(item)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {item.categoryName} · {item.ticketTypeName}
                        {item.refunded && ` · ${labels.refundedItem}`}
                      </div>
                    </div>
                    <span className="tabular-nums">{money(item.price)}</span>
                  </li>
                ))}
                {event.fees.map((fee) => (
                  <li
                    key={fee.id}
                    className="flex justify-between gap-3 py-2 text-muted-foreground"
                  >
                    <span>
                      {fee.name}
                      {fee.quantity > 1 && ` (${fee.quantity}×)`}
                    </span>
                    <span className="tabular-nums">{money(fee.totalGross)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div key={event.eventId} className="space-y-2">
              <div className="font-medium">
                {event.title}{' '}
                <span className="font-normal text-muted-foreground">
                  · {labels.eventDate(event)}
                </span>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{labels.columns?.place}</TableHead>
                    <TableHead>{labels.columns?.category}</TableHead>
                    <TableHead>{labels.columns?.tariff}</TableHead>
                    <TableHead>{labels.columns?.status}</TableHead>
                    <TableHead className="text-right">{labels.columns?.price}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {event.items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>{labels.place(item)}</TableCell>
                      <TableCell>{item.categoryName}</TableCell>
                      <TableCell>{item.ticketTypeName}</TableCell>
                      <TableCell>{labels.itemStatus?.(item)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {item.strikePrice !== null && (
                          <span className="mr-2 text-xs text-muted-foreground line-through">
                            {money(item.strikePrice)}
                          </span>
                        )}
                        {money(item.price)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ),
        )}
        <div className="space-y-1 border-t pt-3 text-sm">
          {totals.discount && (
            <div className="flex justify-between text-success" data-testid="order-discount">
              <span>{labels.discount?.(totals.discount.codes)}</span>
              <span className="tabular-nums">−{money(totals.discount.amount)}</span>
            </div>
          )}
          {totals.fees.map((fee) => (
            <div key={fee.id} className="flex justify-between text-muted-foreground">
              <span>
                {fee.name}
                {!shop && fee.quantity > 1 && ` (${fee.quantity}×)`}
              </span>
              <span className="tabular-nums">{money(fee.totalGross)}</span>
            </div>
          ))}
          <div
            className={
              shop
                ? 'flex justify-between text-base font-semibold'
                : 'flex justify-between font-semibold'
            }
          >
            <span>{labels.total}</span>
            <span className="tabular-nums">{money(totals.total)}</span>
          </div>
          {totals.taxes.map((tax) => (
            <div
              key={tax.rateBasisPoints}
              className="flex justify-between text-xs text-muted-foreground"
            >
              <span>{labels.tax(tax)}</span>
              <span className="tabular-nums">
                {shop ? money(tax.tax) : `${money(tax.net)} + ${money(tax.tax)}`}
              </span>
            </div>
          ))}
          {totals.paid !== null && (
            <div className="flex justify-between text-muted-foreground">
              <span>{labels.paid}</span>
              <span className="tabular-nums">{money(totals.paid)}</span>
            </div>
          )}
          {totals.refunded !== null && (
            <div className="flex justify-between text-muted-foreground">
              <span>{labels.refunded}</span>
              <span className="tabular-nums">−{money(totals.refunded)}</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

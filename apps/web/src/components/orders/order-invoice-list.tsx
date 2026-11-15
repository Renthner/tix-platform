import type { OrderInvoiceLine } from '@tix/core';
import { Download } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/** Invoice / credit note downloads of an order (shop and admin; the label text is audience specific). */
export function OrderInvoiceList({
  title,
  invoices,
  label,
}: {
  title: string;
  invoices: OrderInvoiceLine[];
  /** Link content after the download icon. */
  label: (invoice: OrderInvoiceLine) => React.ReactNode;
}) {
  if (invoices.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2 text-sm">
          {invoices.map((invoice) => (
            <li key={invoice.id}>
              <a href={invoice.href} className="inline-flex items-center gap-2 hover:underline">
                <Download className="size-4" />
                {label(invoice)}
              </a>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

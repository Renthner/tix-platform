'use client';

import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';
import type { TicketDesignerProps } from './designer';

const TicketDesigner = dynamic(() => import('./designer').then((m) => m.TicketDesigner), {
  ssr: false,
  loading: () => <Skeleton className="m-6 h-[40rem]" />,
});

/** Client-only wrapper (Konva needs the browser). */
export function TicketDesignerLoader(props: TicketDesignerProps) {
  return <TicketDesigner {...props} />;
}

'use client';

import dynamic from 'next/dynamic';
import type { SeatMapEditorProps } from './types';

// Konva needs `window` – the editor is rendered on the client only.
const SeatMapEditor = dynamic(() => import('./seat-map-editor').then((m) => m.SeatMapEditor), {
  ssr: false,
  loading: () => <div className="p-8 text-sm text-muted-foreground">…</div>,
});

export function SeatMapEditorLoader(props: SeatMapEditorProps) {
  return <SeatMapEditor {...props} />;
}

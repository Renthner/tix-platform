'use client';

import type { ReactNode } from 'react';
import { selectionCount, soleKind } from './model';
import { BulkPanel } from './panels/bulk-panel';
import { ElementPanel, EntrancePanel } from './panels/element-panel';
import { PlanPanel } from './panels/plan-panel';
import { RowPanel } from './panels/row-panel';
import { SeatPanel } from './panels/seat-panel';
import { SectionPanel } from './panels/section-panel';
import type { PanelProps } from './panels/types';

/** Properties panel of the seat map editor: dispatches on the current selection. */
export function PropertiesPanel(props: PanelProps) {
  const { doc, selection } = props;
  const kind = soleKind(selection);
  const count = selectionCount(selection);
  const single = kind && selection[kind].size === 1 ? [...selection[kind]][0]! : null;

  let content: ReactNode;
  if (count === 0) {
    content = <PlanPanel {...props} />;
  } else if (kind === 'sections' && single) {
    const section = doc.sections.find((s) => s.id === single);
    content = section ? <SectionPanel {...props} section={section} /> : null;
  } else if (kind === 'rows' && single) {
    const row = doc.rows.find((r) => r.id === single);
    content = row ? <RowPanel {...props} row={row} /> : null;
  } else if (kind === 'seats' && single) {
    const seat = doc.seats.find((s) => s.id === single);
    content = seat ? <SeatPanel {...props} seat={seat} /> : null;
  } else if (kind === 'elements' && single) {
    const element = doc.elements.find((e) => e.id === single);
    content = element ? <ElementPanel {...props} element={element} /> : null;
  } else if (kind === 'entrances' && single) {
    const entrance = doc.entrances.find((e) => e.id === single);
    content = entrance ? <EntrancePanel {...props} entrance={entrance} /> : null;
  } else {
    content = <BulkPanel {...props} />;
  }
  return <div className="flex flex-col">{content}</div>;
}

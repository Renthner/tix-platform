'use client';

import { Copy, Download } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { EventDuplicateDialog } from '@/components/admin/event-duplicate-dialog';
import { RowActions } from '@/components/admin/row-actions';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import type { ActionState } from '@/lib/action-state';

/**
 * "⋯" menu of an event list row: export and duplicate. The duplicate dialog lives outside the
 * menu (controlled), so it stays mounted when the menu closes.
 */
export function EventRowActions({
  duplicateAction,
  title,
  startsAt,
  exportHref,
}: {
  duplicateAction: (state: ActionState, fd: FormData) => Promise<ActionState>;
  title: string;
  /** Start as datetime-local value in the event's time zone. */
  startsAt: string;
  exportHref: string;
}) {
  const t = useTranslations('admin.events');
  const tl = useTranslations('admin.list');
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  // Set when the menu closes because the dialog opens: the focus then goes to the dialog.
  const openingDialog = useRef(false);
  return (
    <>
      <RowActions
        label={tl('rowActions', { name: title })}
        data-testid="event-row-actions"
        onCloseAutoFocus={(e) => {
          if (openingDialog.current) e.preventDefault();
          openingDialog.current = false;
        }}
      >
        <DropdownMenuItem
          onSelect={() => {
            openingDialog.current = true;
            setDuplicateOpen(true);
          }}
        >
          <Copy /> {t('duplicate.button')}
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={exportHref} download title={t('transfer.exportTitle')}>
            <Download /> {t('transfer.export')}
          </a>
        </DropdownMenuItem>
      </RowActions>
      <EventDuplicateDialog
        action={duplicateAction}
        title={title}
        startsAt={startsAt}
        open={duplicateOpen}
        onOpenChange={setDuplicateOpen}
      />
    </>
  );
}

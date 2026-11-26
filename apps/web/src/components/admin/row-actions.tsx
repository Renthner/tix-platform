'use client';

import { MoreHorizontal } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * "⋯" menu for the secondary actions of a list row. Children are `DropdownMenuItem`s. Items that
 * open a dialog must keep the dialog outside this menu (controlled state, see
 * `EventRowActions`) and may pass `onCloseAutoFocus` to keep the focus in the dialog.
 */
export function RowActions({
  label,
  children,
  onCloseAutoFocus,
  ...rest
}: {
  /** Accessible name of the trigger, e.g. "Actions for Demo Concert". */
  label: string;
  children: ReactNode;
  onCloseAutoFocus?: ComponentProps<typeof DropdownMenuContent>['onCloseAutoFocus'];
  'data-testid'?: string;
}) {
  return (
    // Not modal: a modal menu that closes while a dialog opens can leave the page inert.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={label}
          title={label}
          data-testid={rest['data-testid']}
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={onCloseAutoFocus}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

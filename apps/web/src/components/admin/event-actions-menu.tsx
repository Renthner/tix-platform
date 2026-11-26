'use client';

import { ChevronDown, Copy, Download, ExternalLink, FlaskConical } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { EventDuplicateDialog } from '@/components/admin/event-duplicate-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Link } from '@/i18n/navigation';
import type { ActionState } from '@/lib/action-state';

/**
 * "Actions" menu of the event header: duplicate (dialog), export, test / view in the shop. The
 * duplicate dialog lives outside the menu (controlled), so it stays mounted when the menu closes.
 */
export function EventActionsMenu({
  duplicateAction,
  title,
  startsAt,
  exportHref,
  testShopHref,
  viewShopHref,
}: {
  duplicateAction: (state: ActionState, fd: FormData) => Promise<ActionState>;
  title: string;
  /** Start as datetime-local value in the event's time zone. */
  startsAt: string;
  exportHref: string;
  /** Shop page for a super-admin test purchase; null hides the entry. */
  testShopHref: string | null;
  /** Public shop page of a published event; null hides the entry. */
  viewShopHref: string | null;
}) {
  const t = useTranslations('admin.events');
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  // Set when the menu closes because the dialog opens: focus then goes to the dialog, not back to
  // the menu button.
  const openingDialog = useRef(false);
  return (
    <>
      {/* Not modal: a modal menu that closes while the dialog opens can leave the page inert. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" data-testid="event-actions">
            {t('actions')} <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
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
          {(testShopHref || viewShopHref) && <DropdownMenuSeparator />}
          {testShopHref && (
            <DropdownMenuItem asChild>
              <Link href={testShopHref} target="_blank" rel="noopener">
                <FlaskConical /> {t('testInShop')}
              </Link>
            </DropdownMenuItem>
          )}
          {viewShopHref && (
            <DropdownMenuItem asChild>
              <Link href={viewShopHref} target="_blank" rel="noopener">
                <ExternalLink /> {t('viewInShop')}
              </Link>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
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

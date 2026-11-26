'use client';

import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Link } from '@/i18n/navigation';
import type { BankingActionState } from '@/lib/banking-action-state';
import { BankingConfirm } from './account-form';

type Action = (state: BankingActionState, fd: FormData) => Promise<BankingActionState>;

export interface BankingMenuLink {
  key: string;
  label: string;
  href: string;
  /** Plain `<a>` (file downloads, API routes) instead of a client-side link. */
  external?: boolean;
}

export interface BankingMenuDialog {
  key: string;
  label: string;
  action: Action;
  title: string;
  description?: string;
  confirmLabel: string;
  /** Shown last, in red, after a separator. */
  destructive?: boolean;
}

/**
 * "Actions" menu of a banking detail page header: links first, then confirm dialogs (destructive
 * ones last). The dialogs live outside the non-modal menu (controlled), so they stay mounted when
 * the menu closes and stay locked while their action runs.
 */
export function BankingActionsMenu({
  links = [],
  dialogs = [],
}: {
  links?: readonly BankingMenuLink[];
  dialogs?: readonly BankingMenuDialog[];
}) {
  const t = useTranslations('banking');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openingDialog = useRef(false);
  const regular = dialogs.filter((d) => !d.destructive);
  const destructive = dialogs.filter((d) => d.destructive);
  const item = (d: BankingMenuDialog) => (
    <DropdownMenuItem
      key={d.key}
      variant={d.destructive ? 'destructive' : 'default'}
      onSelect={() => {
        openingDialog.current = true;
        setOpenKey(d.key);
      }}
    >
      {d.label}
    </DropdownMenuItem>
  );
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button ref={triggerRef} type="button" variant="outline" data-testid="banking-actions">
            {t('actionsMenu')} <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(e) => {
            if (openingDialog.current) e.preventDefault();
            openingDialog.current = false;
          }}
        >
          {links.map((l) => (
            <DropdownMenuItem key={l.key} asChild>
              {l.external ? <a href={l.href}>{l.label}</a> : <Link href={l.href}>{l.label}</Link>}
            </DropdownMenuItem>
          ))}
          {regular.map(item)}
          {destructive.length > 0 && (links.length > 0 || regular.length > 0) ? (
            <DropdownMenuSeparator />
          ) : null}
          {destructive.map(item)}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialogs.map((d) => (
        <BankingConfirm
          key={d.key}
          action={d.action}
          title={d.title}
          description={d.description}
          confirmLabel={d.confirmLabel}
          variant={d.destructive ? 'destructive' : 'default'}
          open={openKey === d.key}
          onOpenChange={(open) => setOpenKey(open ? d.key : null)}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            triggerRef.current?.focus();
          }}
        />
      ))}
    </>
  );
}

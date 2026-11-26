'use client';

import { useTranslations } from 'next-intl';
import type { ComponentProps, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Controlled confirmation dialog – the in-page replacement for `window.confirm`. Use it where the
 * confirmed step is a client callback (editor flows, transitions); for server actions bound to a
 * button prefer `ConfirmAction`. Focus moves to the cancel button, so Enter never confirms a
 * destructive step by accident; Escape and the overlay cancel.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  variant = 'destructive',
  onConfirm,
  onCancel,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  variant?: ComponentProps<typeof Button>['variant'];
  onConfirm: () => void;
  /** Runs when the dialog is dismissed without confirming. */
  onCancel?: () => void;
  /** Passed to the dialog content, e.g. to move the focus somewhere when the trigger is gone. */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const t = useTranslations('common');
  const cancel = () => {
    onOpenChange(false);
    onCancel?.();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else cancel();
      }}
    >
      <DialogContent
        data-testid="confirm-dialog"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector<HTMLElement>('[data-cancel]')?.focus();
        }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>{title ?? t('confirm.title')}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" data-cancel onClick={cancel}>
            {cancelLabel ?? t('actions.cancel')}
          </Button>
          <Button
            type="button"
            variant={variant}
            data-testid="confirm-dialog-confirm"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {confirmLabel ?? t('actions.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

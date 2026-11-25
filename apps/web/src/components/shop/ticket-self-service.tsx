'use client';

import { Loader2, Pencil, Send } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useRouter } from '@/i18n/navigation';
import { apiFetch, errorMessage } from '@/lib/api';

interface Props {
  /** Order page only; the holder page and the admin screens pass `apiBase`. */
  orderId?: string;
  token: string | null;
  ticketId: string;
  /** Code shown in the dialog titles. */
  ticketCode: string;
  attendeeName: string | null;
  canChangeName: boolean;
  canTransfer: boolean;
  /** Admin screens post to the admin API (no policy, no order token). */
  apiBase?: string;
  /** Admin: the recipient field also accepts the buyer's address (hands the ticket back). */
  admin?: boolean;
}

/** Per-ticket self-service on the order page: change the attendee name / hand the ticket over. */
export function TicketSelfServiceActions({
  orderId,
  token,
  ticketId,
  ticketCode,
  attendeeName,
  canChangeName,
  canTransfer,
  apiBase,
  admin = false,
}: Props) {
  const t = useTranslations('checkout.order.selfService');
  const tErr = useTranslations('common.errors');
  const router = useRouter();
  const base = apiBase ?? `/api/orders/${orderId}/tickets/${ticketId}`;

  const [nameOpen, setNameOpen] = useState(false);
  const [name, setName] = useState(attendeeName ?? '');
  const [transferOpen, setTransferOpen] = useState(false);
  const [recipientName, setRecipientName] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [recipientEmailRepeat, setRecipientEmailRepeat] = useState('');
  const emailsMatch =
    recipientEmail.trim().toLowerCase() === recipientEmailRepeat.trim().toLowerCase();
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<'name' | 'transfer' | null>(null);

  const saveName = async () => {
    setPending('name');
    try {
      await apiFetch(`${base}/name`, { method: 'POST', json: { t: token ?? undefined, name } });
      toast.success(t('nameSaved'));
      setNameOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(tErr, err));
    } finally {
      setPending(null);
    }
  };

  const transfer = async () => {
    setPending('transfer');
    try {
      await apiFetch(`${base}/transfer`, {
        method: 'POST',
        json: {
          t: token ?? undefined,
          recipientName,
          recipientEmail,
          ...(message.trim() ? { message } : {}),
        },
      });
      toast.success(t('transferred'));
      setTransferOpen(false);
      setRecipientName('');
      setRecipientEmail('');
      setRecipientEmailRepeat('');
      setMessage('');
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(tErr, err));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex items-center gap-2" data-slot="ticket-self-service">
      {canChangeName && (
        <Dialog open={nameOpen} onOpenChange={setNameOpen}>
          <DialogTrigger asChild>
            <Button variant="ghost" size="sm" data-slot="ticket-change-name">
              <Pencil className="size-4" />
              {t('changeName')}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void saveName();
              }}
              className="space-y-4"
            >
              <DialogHeader>
                <DialogTitle>{t('nameTitle', { code: ticketCode })}</DialogTitle>
                <DialogDescription>{t('nameText')}</DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor={`name-${ticketId}`}>{t('nameLabel')}</Label>
                <Input
                  id={`name-${ticketId}`}
                  name="attendeeName"
                  value={name}
                  maxLength={120}
                  required
                  autoComplete="off"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    {t('cancel')}
                  </Button>
                </DialogClose>
                <Button type="submit" disabled={pending !== null || name.trim() === ''}>
                  {pending === 'name' && <Loader2 className="size-4 animate-spin" />}
                  {t('save')}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
      {canTransfer && (
        <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
          <DialogTrigger asChild>
            <Button variant="ghost" size="sm" data-slot="ticket-transfer">
              <Send className="size-4" />
              {t('transfer')}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void transfer();
              }}
              className="space-y-4"
            >
              <DialogHeader>
                <DialogTitle>{t('transferTitle', { code: ticketCode })}</DialogTitle>
                <DialogDescription>{t('transferText')}</DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor={`rn-${ticketId}`}>{t('recipientName')}</Label>
                <Input
                  id={`rn-${ticketId}`}
                  name="recipientName"
                  value={recipientName}
                  maxLength={120}
                  required
                  autoComplete="off"
                  onChange={(e) => setRecipientName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`re-${ticketId}`}>{t('recipientEmail')}</Label>
                <Input
                  id={`re-${ticketId}`}
                  name="recipientEmail"
                  type="email"
                  value={recipientEmail}
                  maxLength={254}
                  required
                  autoComplete="off"
                  onChange={(e) => setRecipientEmail(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`rr-${ticketId}`}>{t('recipientEmailRepeat')}</Label>
                <Input
                  id={`rr-${ticketId}`}
                  name="recipientEmailRepeat"
                  type="email"
                  value={recipientEmailRepeat}
                  maxLength={254}
                  required
                  autoComplete="off"
                  aria-invalid={recipientEmailRepeat !== '' && !emailsMatch ? true : undefined}
                  aria-describedby={`rrn-${ticketId}`}
                  // Typing the address again is the point: no pasting it over.
                  onPaste={(e) => e.preventDefault()}
                  onChange={(e) => setRecipientEmailRepeat(e.target.value)}
                />
                <p
                  id={`rrn-${ticketId}`}
                  className="text-xs text-destructive"
                  role={recipientEmailRepeat !== '' && !emailsMatch ? 'alert' : undefined}
                >
                  {recipientEmailRepeat !== '' && !emailsMatch ? t('recipientEmailMismatch') : ''}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`rm-${ticketId}`}>{t('message')}</Label>
                <Textarea
                  id={`rm-${ticketId}`}
                  name="message"
                  value={message}
                  maxLength={500}
                  rows={3}
                  onChange={(e) => setMessage(e.target.value)}
                />
              </div>
              <p className="text-xs text-muted-foreground">{t('transferWarning')}</p>
              {admin && <p className="text-xs text-muted-foreground">{t('handBackHint')}</p>}
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    {t('cancel')}
                  </Button>
                </DialogClose>
                <Button
                  type="submit"
                  disabled={
                    pending !== null ||
                    recipientName.trim() === '' ||
                    recipientEmail.trim() === '' ||
                    !emailsMatch
                  }
                >
                  {pending === 'transfer' && <Loader2 className="size-4 animate-spin" />}
                  {t('transferConfirm')}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/** Admin: send the recipient's ticket e-mail of a transferred ticket again. */
export function ResendHolderMailButton({ apiBase }: { apiBase: string }) {
  const t = useTranslations('checkout.order.selfService');
  const tErr = useTranslations('common.errors');
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      data-slot="ticket-resend-holder"
      onClick={async () => {
        setPending(true);
        try {
          await apiFetch(`${apiBase}/resend-holder`, { method: 'POST', json: {} });
          toast.success(t('resent'));
        } catch (err) {
          toast.error(errorMessage(tErr, err));
        } finally {
          setPending(false);
        }
      }}
    >
      {pending && <Loader2 className="size-4 animate-spin" />}
      {t('resend')}
    </Button>
  );
}

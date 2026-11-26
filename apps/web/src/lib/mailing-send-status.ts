/**
 * Whether the event mailing ("Communication" tab) can be sent, and why not. Pure so the rule is
 * unit-tested: the send button is disabled while a send runs (double submission), while the
 * recipient count is unknown or failed, without recipients, and without subject/body.
 */
export type MailingSendBlock = 'SENDING' | 'COUNTING' | 'COUNT_FAILED' | 'NO_RECIPIENTS' | 'EMPTY';

export function mailingSendBlock(input: {
  subject: string;
  body: string;
  /** null = still counting. */
  count: number | null;
  countFailed: boolean;
  sending: boolean;
}): MailingSendBlock | null {
  if (input.sending) return 'SENDING';
  if (input.countFailed) return 'COUNT_FAILED';
  if (input.count === null) return 'COUNTING';
  if (input.count <= 0) return 'NO_RECIPIENTS';
  if (input.subject.trim() === '' || input.body.trim() === '') return 'EMPTY';
  return null;
}

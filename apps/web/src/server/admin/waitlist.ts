'use server';

import { evaluateWaitlistEvent, getEventById, removeWaitlistEntries } from '@tix/core';
import { revalidatePath } from 'next/cache';
import type { ActionState } from '@/lib/action-state';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { formError, success } from './form';

/** "Notify now": notifies every confirmed entry whose wish can be served right now. */
export async function notifyWaitlistNowAction(
  eventId: string,
  _prev: ActionState,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const core = getCore();
  const event = await getEventById(core, eventId).catch(() => null);
  if (!event) return formError('notFound');
  const result = await evaluateWaitlistEvent(core, event, { force: true });
  await audit(core.db, session, 'waitlist.notify', 'event', eventId, result);
  revalidatePath('/admin/events/[id]/sales', 'page');
  return success('saved');
}

/** Removes one entry; `notify=on` also sends the "removed" e-mail. */
export async function removeWaitlistEntryAction(
  eventId: string,
  entryId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(['EVENT_MANAGER']);
  const core = getCore();
  const removed = await removeWaitlistEntries(core, eventId, [entryId], {
    notify: fd.get('notify') === 'on',
  });
  if (removed === 0) return formError('notFound');
  // The entry id only: the e-mail address is personal data and stays out of the audit trail.
  await audit(core.db, session, 'waitlist.remove', 'event', eventId, { entryId });
  revalidatePath('/admin/events/[id]/sales', 'page');
  return success('deleted');
}

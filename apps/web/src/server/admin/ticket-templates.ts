'use server';

import {
  DomainError,
  assignCategoryTicketTemplate,
  assignEventTicketTemplate,
  createTicketTemplate,
  deleteTicketTemplate,
  duplicateTicketTemplate,
  getTicketTemplate,
  setDefaultTicketTemplate,
  updateTicketTemplate,
} from '@tix/core';
import {
  DEFAULT_TICKET_PAGE_MM,
  defaultTicketLayout,
  ticketTemplateInputSchema,
  type TicketTemplateInput,
} from '@tix/shared';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { redirect } from '@/i18n/navigation';
import type { ActionState } from '@/lib/action-state';
import { requireAdmin } from '@/server/auth';
import { getCore } from '@/server/core';
import { audit } from './audit';
import { fieldError, formError, success, text, zodFieldErrors } from './form';

/** Ticket designer actions (EVENT_MANAGER). Every mutation is audited. */

const ROLES = ['EVENT_MANAGER'] as const;
const uuid = z.uuid();

export type DesignerSaveResult =
  { status: 'saved'; version: number; at: number } | { status: 'error'; code: string; at: number };

function refresh(): void {
  revalidatePath('/', 'layout');
}

function failure(err: unknown): ActionState {
  if (err instanceof DomainError && err.status === 404) return formError('notFound');
  if (err instanceof DomainError) return formError('generic');
  console.error('[admin/ticket-templates] action failed', err);
  return formError('generic');
}

/** Saves the designer's draft (page size, background, layout). Called directly by the editor. */
export async function saveTicketTemplateAction(
  id: string,
  input: TicketTemplateInput,
): Promise<DesignerSaveResult> {
  const session = await requireAdmin(ROLES);
  const fail = (code: string): DesignerSaveResult => ({ status: 'error', code, at: Date.now() });
  if (!uuid.safeParse(id).success) return fail('NOT_FOUND');
  const parsed = ticketTemplateInputSchema.safeParse(input);
  if (!parsed.success) return fail('VALIDATION_FAILED');
  try {
    const core = getCore();
    const row = await updateTicketTemplate(core, { id, input: parsed.data });
    await audit(core.db, session, 'ticketTemplate.save', 'ticket_template', id, {
      version: row.version,
    });
    refresh();
    return { status: 'saved', version: row.version, at: Date.now() };
  } catch (err) {
    if (err instanceof DomainError) return fail(err.code);
    console.error('[admin/ticket-templates] save failed', err);
    return fail('INTERNAL_ERROR');
  }
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  basedOn: z.uuid().optional(),
});

async function newTemplate(
  userId: string,
  eventId: string | null,
  data: z.infer<typeof createSchema>,
) {
  const core = getCore();
  if (data.basedOn) {
    return duplicateTicketTemplate(core, {
      id: data.basedOn,
      eventId,
      name: data.name,
      userId,
    });
  }
  return createTicketTemplate(core, {
    userId,
    eventId,
    input: {
      name: data.name,
      pageWidthMm: DEFAULT_TICKET_PAGE_MM.width,
      pageHeightMm: DEFAULT_TICKET_PAGE_MM.height,
      layout: defaultTicketLayout(),
    },
  });
}

export async function createLibraryTemplateAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(ROLES);
  const parsed = createSchema.safeParse({ name: text(fd, 'name'), basedOn: text(fd, 'basedOn') });
  if (!parsed.success) return fieldError(zodFieldErrors(parsed.error));
  let id: string;
  try {
    const row = await newTemplate(session.userId, null, parsed.data);
    id = row.id;
    await audit(getCore().db, session, 'ticketTemplate.create', 'ticket_template', id, {
      name: row.name,
      basedOn: parsed.data.basedOn ?? null,
    });
  } catch (err) {
    return failure(err);
  }
  refresh();
  redirect({ href: `/admin/ticket-templates/${id}`, locale: await getLocale() });
  return success('created');
}

/** Creates an event-specific template and (optionally) assigns it to the event or a category. */
export async function createEventTemplateAction(
  eventId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(ROLES);
  if (!uuid.safeParse(eventId).success) return formError('notFound');
  const parsed = createSchema.safeParse({ name: text(fd, 'name'), basedOn: text(fd, 'basedOn') });
  if (!parsed.success) return fieldError(zodFieldErrors(parsed.error));
  const assignTo = text(fd, 'assignTo') ?? 'event';
  if (assignTo !== 'event' && assignTo !== 'none' && !uuid.safeParse(assignTo).success) {
    return fieldError({ assignTo: 'invalid' });
  }
  let id: string;
  try {
    const core = getCore();
    const row = await newTemplate(session.userId, eventId, parsed.data);
    id = row.id;
    if (assignTo === 'event') await assignEventTicketTemplate(core, eventId, id);
    else if (assignTo !== 'none') {
      await assignCategoryTicketTemplate(core, { eventId, categoryId: assignTo, templateId: id });
    }
    await audit(core.db, session, 'ticketTemplate.create', 'ticket_template', id, {
      name: row.name,
      eventId,
      assignTo,
    });
  } catch (err) {
    return failure(err);
  }
  refresh();
  redirect({ href: `/admin/ticket-templates/${id}`, locale: await getLocale() });
  return success('created');
}

export async function duplicateTicketTemplateAction(
  id: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(ROLES);
  if (!uuid.safeParse(id).success) return formError('notFound');
  const name = z.string().trim().min(1).max(120).safeParse(text(fd, 'name'));
  try {
    const core = getCore();
    const source = await getTicketTemplate(core.db, id);
    if (!source) return formError('notFound');
    const copy = await duplicateTicketTemplate(core, {
      id,
      eventId: source.eventId,
      name: name.success ? name.data : undefined,
      userId: session.userId,
    });
    await audit(core.db, session, 'ticketTemplate.duplicate', 'ticket_template', copy.id, {
      from: id,
    });
    refresh();
    return success('created');
  } catch (err) {
    return failure(err);
  }
}

export async function deleteTicketTemplateAction(
  id: string,
  _prev: ActionState,
  _fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(ROLES);
  if (!uuid.safeParse(id).success) return formError('notFound');
  try {
    const core = getCore();
    await deleteTicketTemplate(core, id);
    await audit(core.db, session, 'ticketTemplate.delete', 'ticket_template', id);
    refresh();
    return success('deleted');
  } catch (err) {
    if (err instanceof DomainError && err.code === 'TEMPLATE_IS_DEFAULT') return formError('inUse');
    return failure(err);
  }
}

export async function setDefaultTicketTemplateAction(
  id: string,
  _prev: ActionState,
  _fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(ROLES);
  if (!uuid.safeParse(id).success) return formError('notFound');
  try {
    const core = getCore();
    await setDefaultTicketTemplate(core, id);
    await audit(core.db, session, 'ticketTemplate.set_default', 'ticket_template', id);
    refresh();
    return success('saved');
  } catch (err) {
    return failure(err);
  }
}

/** Event template assignment ('' = use the global default). */
export async function assignEventTemplateAction(
  eventId: string,
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(ROLES);
  const templateId = text(fd, 'templateId') ?? null;
  if (!uuid.safeParse(eventId).success || (templateId && !uuid.safeParse(templateId).success)) {
    return formError('notFound');
  }
  try {
    const core = getCore();
    await assignEventTicketTemplate(core, eventId, templateId);
    await audit(core.db, session, 'event.ticket_template', 'event', eventId, { templateId });
    refresh();
    return success('saved');
  } catch (err) {
    return failure(err);
  }
}

/** Category overrides: one select per category named `cat:<categoryId>` ('' = inherit). */
export async function assignCategoryTemplatesAction(
  eventId: string,
  categoryIds: string[],
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const session = await requireAdmin(ROLES);
  if (!uuid.safeParse(eventId).success) return formError('notFound');
  try {
    const core = getCore();
    const changes: Record<string, string | null> = {};
    for (const categoryId of categoryIds) {
      if (!uuid.safeParse(categoryId).success) continue;
      const templateId = text(fd, `cat:${categoryId}`) ?? null;
      if (templateId && !uuid.safeParse(templateId).success) return formError('notFound');
      await assignCategoryTicketTemplate(core, { eventId, categoryId, templateId });
      changes[categoryId] = templateId;
    }
    await audit(core.db, session, 'event.category_ticket_templates', 'event', eventId, changes);
    refresh();
    return success('saved');
  } catch (err) {
    return failure(err);
  }
}

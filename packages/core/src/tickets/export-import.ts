import { createHash } from 'node:crypto';
import { events, priceCategories } from '@tix/db';
import {
  TICKET_DESIGN_FILE_FORMAT,
  TICKET_DESIGN_FILE_MAX_BYTES,
  TICKET_DESIGN_FILE_MIN_VERSION,
  TICKET_DESIGN_FILE_VERSION,
  fileLayoutToLayout,
  ticketDesignFileSchema,
  ticketLayoutSchema,
  type PlanImage,
  type TicketDesignFile,
} from '@tix/shared';
import { and, eq } from 'drizzle-orm';
import { DomainError, requireCapability, type CoreContext } from '../context';
import { findMediaAssetByHash, getMediaAsset, loadMediaBytes, uploadMediaAsset } from '../media';
import { deleteMediaAsset } from '../media-admin';
import {
  assignCategoryTicketTemplate,
  assignEventTicketTemplate,
  createTicketTemplate,
  deleteTicketTemplate,
  getTicketTemplate,
} from './template-admin';

/**
 * Ticket design export / import (`*.tixticket.json`, see `ticketDesignFileSchema`).
 *
 * Export is deterministic (images are keyed "img1", "img2" … in element order). Import always
 * creates a NEW template (library or event-owned); the file never carries ids and nothing in it
 * is trusted: the whole file is re-validated and images go through the normal upload pipeline.
 */

async function exportImage(ctx: CoreContext, assetId: string): Promise<PlanImage> {
  const asset = await getMediaAsset(ctx, assetId);
  if (!asset) throw new DomainError('MEDIA_NOT_FOUND', 'An image of the design is missing', 409);
  const bytes = await loadMediaBytes(ctx, assetId);
  return {
    fileName: asset.fileName,
    contentType: asset.mimeType as PlanImage['contentType'],
    width: asset.width,
    height: asset.height,
    dataBase64: Buffer.from(bytes.bytes).toString('base64'),
  };
}

/** Builds the export file of a template (no event / category / order references). */
export async function exportTicketTemplate(
  ctx: CoreContext,
  templateId: string,
  options: { appVersion?: string } = {},
): Promise<TicketDesignFile> {
  requireCapability(ctx, 'storage');
  const row = await getTicketTemplate(ctx.db, templateId);
  if (!row) throw new DomainError('TEMPLATE_NOT_FOUND', 'Ticket template not found', 404);
  const layout = ticketLayoutSchema.parse(row.layout);

  const images: (PlanImage & { key: string })[] = [];
  const imageKey = new Map<string, string>();
  const elements = [];
  for (const el of layout.elements) {
    if (el.kind !== 'image') {
      elements.push(el);
      continue;
    }
    let key = imageKey.get(el.assetId);
    if (!key) {
      key = `img${images.length + 1}`;
      imageKey.set(el.assetId, key);
      images.push({ key, ...(await exportImage(ctx, el.assetId)) });
    }
    const { assetId: _assetId, ...rest } = el;
    elements.push({ ...rest, imageKey: key });
  }
  const background = row.backgroundAssetId ? await exportImage(ctx, row.backgroundAssetId) : null;

  return ticketDesignFileSchema.parse({
    format: TICKET_DESIGN_FILE_FORMAT,
    version: TICKET_DESIGN_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    source: { appVersion: options.appVersion ?? 'unknown' },
    template: {
      name: row.name,
      description: row.description,
      pageWidthMm: row.pageWidthMm,
      pageHeightMm: row.pageHeightMm,
      layout: { ...layout, elements },
    },
    images,
    background,
  });
}

/** Parses and validates the text of an uploaded design file. */
export function parseTicketDesignFile(text: string | Uint8Array): TicketDesignFile {
  const size = typeof text === 'string' ? Buffer.byteLength(text) : text.byteLength;
  if (size > TICKET_DESIGN_FILE_MAX_BYTES) {
    throw new DomainError('TICKET_DESIGN_FILE_TOO_LARGE', 'The design file is too large', 413);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(typeof text === 'string' ? text : Buffer.from(text).toString('utf8'));
  } catch {
    throw new DomainError('TICKET_DESIGN_FILE_INVALID', 'The file is not a ticket design', 422);
  }
  const head = raw as { format?: unknown; version?: unknown } | null;
  if (!head || typeof head !== 'object' || head.format !== TICKET_DESIGN_FILE_FORMAT) {
    throw new DomainError('TICKET_DESIGN_FILE_INVALID', 'The file is not a ticket design', 422);
  }
  if (
    typeof head.version !== 'number' ||
    head.version < TICKET_DESIGN_FILE_MIN_VERSION ||
    head.version > TICKET_DESIGN_FILE_VERSION
  ) {
    throw new DomainError(
      'TICKET_DESIGN_VERSION_UNSUPPORTED',
      'This design file version is not supported',
      422,
    );
  }
  const parsed = ticketDesignFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DomainError('TICKET_DESIGN_FILE_INVALID', 'The ticket design file is invalid', 422, {
      issues: parsed.error.issues
        .slice(0, 20)
        .map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

export interface ImportTicketTemplateResult {
  templateId: string;
  images: number;
}

/** Imports a design file as a new template; never touches existing templates. */
export async function importTicketTemplate(
  ctx: CoreContext,
  input: {
    file: unknown;
    /** Event-owned template when set, library template otherwise. */
    eventId?: string | null;
    name?: string;
    userId: string | null;
    /**
     * Event imports only: use the new template for the whole event (`event`), for one price
     * category of the event (its id) or not at all (`none`, default). Validated BEFORE anything
     * is stored; if the assignment still fails the template and its images are removed again.
     */
    assignTo?: 'event' | 'none' | string;
  },
): Promise<ImportTicketTemplateResult> {
  requireCapability(ctx, 'storage');
  const file = ticketDesignFileSchema.parse(input.file);
  if (input.eventId) {
    const [event] = await ctx.db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, input.eventId));
    if (!event) throw new DomainError('EVENT_NOT_FOUND', 'Event not found', 404);
  }
  const categoryId =
    input.eventId && input.assignTo && input.assignTo !== 'event' && input.assignTo !== 'none'
      ? input.assignTo
      : null;
  if (input.eventId && categoryId) {
    const [category] = await ctx.db
      .select({ id: priceCategories.id })
      .from(priceCategories)
      .where(and(eq(priceCategories.id, categoryId), eq(priceCategories.eventId, input.eventId)));
    if (!category) throw new DomainError('CATEGORY_NOT_FOUND', 'Category not found', 404);
  }

  // Images go through the normal upload pipeline (type, size, dimensions). Assets this import
  // created are removed again if anything later fails.
  const created: string[] = [];
  const upload = async (image: PlanImage): Promise<string> => {
    const bytes = new Uint8Array(Buffer.from(image.dataBase64, 'base64'));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const existing = await findMediaAssetByHash(ctx.db, 'TICKET_BACKGROUND', sha256);
    const row = await uploadMediaAsset(ctx, {
      kind: 'TICKET_BACKGROUND',
      bytes,
      fileName: image.fileName,
      declaredMime: image.contentType,
      userId: input.userId,
    });
    if (!existing) created.push(row.id);
    return row.id;
  };

  try {
    const used = new Set(
      file.template.layout.elements.flatMap((el) => (el.kind === 'image' ? [el.imageKey] : [])),
    );
    const imageIds = new Map<string, string>();
    for (const image of file.images) {
      if (used.has(image.key)) imageIds.set(image.key, await upload(image));
    }
    const backgroundAssetId = file.background ? await upload(file.background) : null;
    const name = (input.name ?? file.template.name).trim().slice(0, 120) || file.template.name;
    const row = await createTicketTemplate(ctx, {
      userId: input.userId,
      eventId: input.eventId ?? null,
      input: {
        name,
        description: file.template.description,
        pageWidthMm: file.template.pageWidthMm,
        pageHeightMm: file.template.pageHeightMm,
        backgroundAssetId,
        layout: fileLayoutToLayout(file.template.layout, imageIds),
      },
    });
    if (input.eventId && (input.assignTo === 'event' || categoryId)) {
      try {
        if (categoryId) {
          await assignCategoryTicketTemplate(ctx, {
            eventId: input.eventId,
            categoryId,
            templateId: row.id,
          });
        } else {
          await assignEventTicketTemplate(ctx, input.eventId, row.id);
        }
      } catch (err) {
        await deleteTicketTemplate(ctx, row.id).catch(() => {});
        throw err;
      }
    }
    return { templateId: row.id, images: imageIds.size + (backgroundAssetId ? 1 : 0) };
  } catch (err) {
    for (const id of created) await deleteMediaAsset(ctx, id).catch(() => {});
    throw err;
  }
}

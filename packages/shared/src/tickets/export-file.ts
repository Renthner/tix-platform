import { z } from 'zod';
import { planImageSchema } from '../seating/export-file';
import {
  coverElementSchema,
  imageElementSchema,
  shapeElementSchema,
  textElementSchema,
  ticketQrSchema,
  type TicketLayout,
} from '../schemas/ticket-template';

/**
 * Portable ticket design file (`*.tixticket.json`): page size, layout (fields, QR, shapes,
 * images) and the images themselves, but no database ids, events, categories or orders.
 * Image elements and the background refer to the embedded images by short local keys; the
 * importer stores the images as new private media assets and maps the keys to their ids.
 */

export const TICKET_DESIGN_FILE_FORMAT = 'tix-ticket-design';
export const TICKET_DESIGN_FILE_VERSION = 1;
export const TICKET_DESIGN_FILE_MIN_VERSION = 1;
export const TICKET_DESIGN_FILE_EXTENSION = '.tixticket.json';
/** Hard cap of an uploaded design file (JSON text with base64 images). */
export const TICKET_DESIGN_FILE_MAX_BYTES = 40 * 1024 * 1024;

const key = z.string().min(1).max(40);

const fileImageElementSchema = imageElementSchema.omit({ assetId: true }).extend({ imageKey: key });

export const ticketDesignLayoutSchema = z.object({
  version: z.literal(1),
  qr: ticketQrSchema,
  elements: z
    .array(
      z.discriminatedUnion('kind', [
        textElementSchema,
        fileImageElementSchema,
        coverElementSchema,
        shapeElementSchema,
      ]),
    )
    .max(200),
});

export const ticketDesignFileSchema = z
  .object({
    format: z.literal(TICKET_DESIGN_FILE_FORMAT),
    version: z.literal(TICKET_DESIGN_FILE_VERSION),
    exportedAt: z.string().max(40),
    source: z.object({ appVersion: z.string().max(40) }),
    template: z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(500).nullable().default(null),
      pageWidthMm: z.number().min(20).max(2000),
      pageHeightMm: z.number().min(20).max(2000),
      layout: ticketDesignLayoutSchema,
    }),
    /** Images of IMAGE elements, referenced by `imageKey`. */
    images: z.array(planImageSchema.extend({ key })).max(30).default([]),
    background: planImageSchema.nullable().default(null),
  })
  .superRefine((file, ctx) => {
    const keys = file.images.map((i) => i.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: 'custom', path: ['images'], message: 'Duplicate key' });
    }
    const known = new Set(keys);
    file.template.layout.elements.forEach((el, i) => {
      if (el.kind === 'image' && !known.has(el.imageKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['template', 'layout', 'elements', i, 'imageKey'],
          message: 'Unknown image',
        });
      }
    });
  });
export type TicketDesignFile = z.infer<typeof ticketDesignFileSchema>;
export type TicketDesignFileLayout = z.infer<typeof ticketDesignLayoutSchema>;

/** Layout of the file with the image keys swapped for real asset ids (`imageIds`: key → id). */
export function fileLayoutToLayout(
  layout: TicketDesignFileLayout,
  imageIds: ReadonlyMap<string, string>,
): TicketLayout {
  return {
    ...layout,
    elements: layout.elements.map((el) => {
      if (el.kind !== 'image') return el;
      const { imageKey, ...rest } = el;
      return { ...rest, assetId: imageIds.get(imageKey)! };
    }),
  };
}

export interface TicketDesignFileSummary {
  name: string;
  description: string | null;
  exportedAt: string;
  pageWidthMm: number;
  pageHeightMm: number;
  elements: number;
  images: number;
  hasBackground: boolean;
}

export function summarizeTicketDesignFile(file: TicketDesignFile): TicketDesignFileSummary {
  return {
    name: file.template.name,
    description: file.template.description,
    exportedAt: file.exportedAt,
    pageWidthMm: file.template.pageWidthMm,
    pageHeightMm: file.template.pageHeightMm,
    elements: file.template.layout.elements.length,
    images: file.images.length,
    hasBackground: file.background !== null,
  };
}

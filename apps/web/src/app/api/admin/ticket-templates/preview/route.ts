import { renderTicketPreviewPdf } from '@tix/core';
import { ticketTemplateInputSchema } from '@tix/shared';
import { z } from 'zod';
import { adminForApi } from '@/server/auth';
import { getCore } from '@/server/core';
import { apiError, handle, parseBody } from '@/server/http';
import { pdfResponse } from '@/server/pdf-response';

export const dynamic = 'force-dynamic';

const bodySchema = ticketTemplateInputSchema
  .pick({
    pageWidthMm: true,
    pageHeightMm: true,
    backgroundAssetId: true,
    layout: true,
  })
  .extend({
    /** Use this event's title / date / venue / cover instead of sample data. */
    eventId: z.uuid().nullish(),
    locale: z.enum(['en', 'de']).default('en'),
  });

/**
 * POST – live preview of an unsaved ticket design as an inline PDF (sample data or the data of
 * an event). The QR code carries a placeholder, never a valid signature.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const session = await adminForApi(['EVENT_MANAGER']);
    if (!session) return apiError('FORBIDDEN', 'Not allowed', 403);
    const origin = request.headers.get('origin');
    if (origin && new URL(origin).host !== request.headers.get('host')) {
      return apiError('FORBIDDEN', 'Cross-site request', 403);
    }
    const body = await parseBody(request, bodySchema);
    const bytes = await renderTicketPreviewPdf(
      getCore(),
      {
        pageWidthMm: body.pageWidthMm,
        pageHeightMm: body.pageHeightMm,
        backgroundAssetId: body.backgroundAssetId ?? null,
        layout: body.layout,
      },
      { eventId: body.eventId ?? null, locale: body.locale },
    );
    return pdfResponse({ bytes, fileName: 'ticket-preview.pdf' }, 'inline');
  });
}

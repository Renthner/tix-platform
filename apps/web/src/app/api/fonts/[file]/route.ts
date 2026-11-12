import { loadBundledFontBytes } from '@tix/core';
import { apiError, handle } from '@/server/http';

export const dynamic = 'force-dynamic';

const FILES = ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf'] as const;

/**
 * GET – the bundled Noto Sans (SIL OFL 1.1) that the PDFs embed, so the ticket designer preview
 * wraps text exactly like the PDF. Public, fixed allow-list, served from the same file lookup the
 * PDF renderer uses (packages/core/assets/fonts, also in the standalone output). The designer
 * requests a versioned URL (`?v=`), hence the long cache lifetime.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  return handle(async () => {
    const file = (await params).file;
    if (!(FILES as readonly string[]).includes(file))
      return apiError('NOT_FOUND', 'Not found', 404);
    const bytes = await loadBundledFontBytes();
    if (!bytes) return apiError('NOT_FOUND', 'Not found', 404);
    const body = file === 'NotoSans-Bold.ttf' ? bytes.bold : bytes.regular;
    return new Response(Buffer.from(body), {
      headers: {
        'content-type': 'font/ttf',
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
      },
    });
  });
}

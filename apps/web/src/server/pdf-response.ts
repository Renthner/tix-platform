import 'server-only';

/** PDF download response; `inline` shows it in the browser (preview) instead of saving. */
export function pdfResponse(
  pdf: { bytes: Uint8Array; fileName: string },
  disposition: 'attachment' | 'inline' = 'attachment',
): Response {
  return new Response(Buffer.from(pdf.bytes), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `${disposition}; filename="${pdf.fileName.replace(/[^\w.-]/g, '_')}"`,
      'cache-control': 'private, no-store',
    },
  });
}

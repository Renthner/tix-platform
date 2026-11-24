import { DomainError } from '../context';

/**
 * Reads a request body as text but aborts as soon as more than `maxBytes` arrive (a lying or
 * missing Content-Length cannot make the server buffer an unbounded body). Throws 413.
 */
export async function readBodyText(request: Request, maxBytes: number): Promise<string> {
  const tooLarge = () => new DomainError('PAYLOAD_TOO_LARGE', 'Request body is too large', 413);
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch {
      // Aborted / reset connection or a broken stream: a client error, not a server fault.
      throw new DomainError('INVALID_BODY', 'The request body could not be read', 400);
    }
    const { done, value } = chunk;
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

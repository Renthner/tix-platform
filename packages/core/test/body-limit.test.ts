import { describe, expect, it } from 'vitest';
import { readBodyText } from '../src/http/body-limit';

const req = (body: ReadableStream<Uint8Array> | string) =>
  new Request('http://x.test/', {
    method: 'POST',
    body,
    ...(typeof body === 'string' ? {} : { duplex: 'half' }),
  } as RequestInit);

describe('readBodyText', () => {
  it('reads a body within the limit', async () => {
    expect(await readBodyText(req('hello'), 100)).toBe('hello');
  });

  it('rejects an oversize body with 413', async () => {
    await expect(readBodyText(req('x'.repeat(50)), 10)).rejects.toMatchObject({ status: 413 });
  });

  it('maps a failing stream to INVALID_BODY 400', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('connection reset');
      },
    });
    await expect(readBodyText(req(stream), 100)).rejects.toMatchObject({
      code: 'INVALID_BODY',
      status: 400,
    });
  });
});

describe('readBodyText limits', () => {
  it('rejects a declared Content-Length above the limit before reading', async () => {
    const r = new Request('http://x.test/', {
      method: 'POST',
      body: 'x',
      headers: { 'content-length': '9999' },
    });
    await expect(readBodyText(r, 10)).rejects.toMatchObject({ status: 413 });
  });

  it('aborts a streamed body without Content-Length once the limit is exceeded', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(8));
        if (pulled > 1000) controller.close();
      },
    });
    await expect(readBodyText(req(stream), 20)).rejects.toMatchObject({ status: 413 });
    expect(pulled).toBeLessThan(50);
  });

  it('returns an empty string for a request without body', async () => {
    expect(await readBodyText(new Request('http://x.test/'), 10)).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import { classifyMailError } from '../src/email/error-kind';

const err = (props: Record<string, unknown>, message = 'x') =>
  Object.assign(new Error(message), props);

describe('classifyMailError', () => {
  it.each([
    [{ code: 'EAUTH', responseCode: 535 }, 'auth'],
    [{ responseCode: 535 }, 'auth'],
    [{ code: 'ECONNECTION' }, 'connection'],
    [{ code: 'ECONNREFUSED' }, 'connection'],
    [{ code: 'ETIMEDOUT' }, 'timeout'],
    [{ code: 'ECONNRESET' }, 'timeout'],
    [{ code: 'EDNS' }, 'dns'],
    [{ code: 'ENOTFOUND' }, 'dns'],
    [{ code: 'EENVELOPE', responseCode: 550 }, 'recipientRejected'],
    [{ code: 'EENVELOPE' }, 'recipientRejected'],
    [{ code: 'ETLS' }, 'tls'],
    [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'tls'],
    [{ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, 'tls'],
    [{ code: 'ESOCKET' }, 'connection'],
    [{ responseCode: 554 }, 'other'],
    [{}, 'other'],
  ] as const)('maps %j to %s', (props, kind) => {
    expect(classifyMailError(err({ ...props }))).toBe(kind);
  });

  it('detects TLS problems reported as socket errors by their message', () => {
    expect(
      classifyMailError(
        err(
          { code: 'ESOCKET' },
          'error:0A00010B:SSL routines:ssl3_get_record:wrong version number',
        ),
      ),
    ).toBe('tls');
    expect(classifyMailError(err({}, 'self-signed certificate in certificate chain'))).toBe('tls');
  });

  it('looks through wrapped causes', () => {
    const wrapped = new Error('outer', { cause: err({ code: 'EAUTH' }) });
    expect(classifyMailError(wrapped)).toBe('auth');
  });

  it('survives non-error values and cause cycles', () => {
    expect(classifyMailError('boom')).toBe('other');
    expect(classifyMailError(undefined)).toBe('other');
    const a: Error & { cause?: unknown } = new Error('a');
    a.cause = a;
    expect(classifyMailError(a)).toBe('other');
  });
});

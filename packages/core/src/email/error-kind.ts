/**
 * Coarse classification of an SMTP delivery error (nodemailer), so the admin UI can show an
 * actionable explanation in the admin language next to the raw technical detail.
 */
export const MAIL_ERROR_KINDS = [
  'auth',
  'connection',
  'timeout',
  'dns',
  'tls',
  'recipientRejected',
  'other',
] as const;
export type MailErrorKind = (typeof MAIL_ERROR_KINDS)[number];

interface ErrorLike {
  code?: unknown;
  responseCode?: unknown;
  command?: unknown;
  message?: unknown;
  cause?: unknown;
}

const TLS_CODE =
  /^(ETLS|ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT|UNABLE_TO_|HOSTNAME_MISMATCH)/;
const TLS_MESSAGE =
  /certificate|wrong version number|ssl routines|tls|self[- ]signed|unable to verify|handshake/i;

/** The error itself followed by its `cause` chain (bounded, cycle-safe). */
function chain(err: unknown): ErrorLike[] {
  const out: ErrorLike[] = [];
  let current: unknown = err;
  while (current && typeof current === 'object' && out.length < 5 && !out.includes(current)) {
    out.push(current as ErrorLike);
    current = (current as ErrorLike).cause;
  }
  return out;
}

function classifyOne(e: ErrorLike): MailErrorKind | null {
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : '';
  const responseCode = typeof e.responseCode === 'number' ? e.responseCode : null;
  const command = typeof e.command === 'string' ? e.command : '';

  if (code === 'EAUTH' || responseCode === 535 || responseCode === 534 || responseCode === 530) {
    return 'auth';
  }
  if (code === 'EENVELOPE' || command === 'RCPT TO') return 'recipientRejected';
  if (TLS_CODE.test(code) || (!code && TLS_MESSAGE.test(message))) return 'tls';
  if (code === 'EDNS' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'ECONNRESET') return 'timeout';
  if (
    code === 'ECONNECTION' ||
    code === 'ESOCKET' ||
    code === 'ECONNREFUSED' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'EPIPE'
  ) {
    return TLS_MESSAGE.test(message) ? 'tls' : 'connection';
  }
  return null;
}

/** Maps a nodemailer (or wrapped) error to a {@link MailErrorKind}; `other` if unknown. */
export function classifyMailError(err: unknown): MailErrorKind {
  for (const e of chain(err)) {
    const kind = classifyOne(e);
    if (kind) return kind;
  }
  return 'other';
}

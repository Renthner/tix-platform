import { createHash } from 'node:crypto';
import { createTransport, type Transporter } from 'nodemailer';
import type { CoreContext } from '../context';
import { getSecretSetting, getSetting } from '../settings';

/** SMTP is not (completely) configured in the Admin Portal. */
export class EmailConfigurationError extends Error {
  override name = 'EmailConfigurationError';
}

export interface MailSender {
  transporter: Transporter;
  from: { name: string; address: string };
  replyTo?: string;
  bcc?: string;
}

let cached: { fingerprint: string; transporter: Transporter } | null = null;

/**
 * Pooled SMTP transport built from the `smtp` settings and the encrypted `smtp.credentials`.
 * The transport is reused until the configuration changes (settings are cached ~10 s).
 */
export async function smtpSender(ctx: CoreContext): Promise<MailSender> {
  const [smtp, general] = await Promise.all([getSetting(ctx, 'smtp'), getSetting(ctx, 'general')]);
  if (!smtp.host || !smtp.fromEmail) {
    throw new EmailConfigurationError(
      'SMTP is not configured (host and sender address are required)',
    );
  }
  const credentials = smtp.username ? await getSecretSetting(ctx, 'smtp.credentials') : null;
  if (smtp.username && !credentials) {
    throw new EmailConfigurationError('SMTP user name is set but no password is stored');
  }
  const options = {
    host: smtp.host,
    port: smtp.port,
    // TLS = implicit TLS (465); STARTTLS = plain connect + mandatory upgrade (587).
    secure: smtp.security === 'TLS',
    requireTLS: smtp.security === 'STARTTLS',
    ignoreTLS: smtp.security === 'NONE',
    auth:
      smtp.username && credentials
        ? { user: smtp.username, pass: credentials.password }
        : undefined,
    pool: true,
    maxConnections: 3,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  } as const;
  const fingerprint = createHash('sha256').update(JSON.stringify(options)).digest('hex');
  if (cached?.fingerprint !== fingerprint) {
    cached?.transporter.close();
    cached = { fingerprint, transporter: createTransport(options) };
  }
  return {
    transporter: cached.transporter,
    from: { name: smtp.fromName ?? general.shopName, address: smtp.fromEmail },
    replyTo: smtp.replyTo ?? general.supportEmail,
    bcc: smtp.bccAddress,
  };
}

/** Closes the pooled SMTP connection (process shutdown). */
export function closeSmtpTransport(): void {
  cached?.transporter.close();
  cached = null;
}

/**
 * True for errors that will not go away by retrying (recipient rejected by the server).
 * Authentication / connection problems are retried – the admin may fix the settings.
 */
export function isPermanentSmtpError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; responseCode?: unknown; command?: unknown };
  if (e.code === 'EENVELOPE') return true;
  return (
    typeof e.responseCode === 'number' &&
    e.responseCode >= 550 &&
    e.responseCode <= 553 &&
    e.command === 'RCPT TO'
  );
}

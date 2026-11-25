import { imapStoredConfigSchema, type BankStatementFormat, type ImapConfig } from '@tix/shared';
import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import type { CoreContext } from '../../context';
import { EndpointNotAllowedError } from '../../backup/endpoint-guard';
import { assertMailHostAllowed } from '../../network/host-guard';
import {
  BankSyncError,
  patchConnectionState,
  type BankAccountRow,
  type BankConnectionRow,
} from '../connections';
import { importStatementFile, type StatementImportResult } from '../importer';
import { detectStatementFormat, expandStatementFiles } from '../parsers';
import { decodeText } from '../text';
import {
  classifyMail,
  isTrustedMailAuth,
  parseAuthenticationResults,
  parseAuthenticationResultsHeader,
  senderAllowed,
} from './imap-policy';

/**
 * IMAP mailbox watcher: searches recent mails (sender allow-list, subject filter), imports
 * statement attachments (camt / MT940 / CSV, also inside ZIP archives) and marks processed
 * mails – moved to `processedMailbox` or tagged with the `$TixImported` keyword (\Seen when
 * the server does not allow custom keywords). File-level SHA-256 dedupe makes re-processing
 * harmless.
 */

export const IMAP_PROCESSED_KEYWORD = '$TixImported';
export const IMAP_SKIPPED_KEYWORD = '$TixSkipped';
const MAX_MESSAGES_PER_RUN = 50;
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

export interface ImapSyncResult {
  messages: number;
  imports: StatementImportResult[];
}

export {
  senderAllowed,
  classifyMail,
  isTrustedMailAuth,
  parseAuthenticationResults,
  parseAuthenticationResultsHeader,
};

/** Stored configs may predate the mandatory allow-list: such a connection must not import. */
export function parseStoredImapConfig(raw: unknown): ImapConfig {
  return imapStoredConfigSchema.parse(raw);
}

export function assertImapAllowlist(config: Pick<ImapConfig, 'senderAllowlist'>): void {
  if (config.senderAllowlist.length === 0) {
    throw new BankSyncError(
      'IMAP_ALLOWLIST_REQUIRED',
      'No accepted senders configured: add at least one sender address or @domain to this connection before it imports mail',
    );
  }
}

function fromAddress(from: AddressObject | AddressObject[] | undefined): string | null {
  const first = Array.isArray(from) ? from[0] : from;
  return first?.value?.[0]?.address ?? null;
}

/** SSRF guard right before connecting (DNS may have changed since the settings were saved). */
async function assertImapHostAllowed(host: string): Promise<void> {
  try {
    await assertMailHostAllowed(host);
  } catch (err) {
    if (err instanceof EndpointNotAllowedError) {
      throw new BankSyncError('IMAP_CONNECT', `IMAP host not allowed: ${err.message}`);
    }
    throw err;
  }
}

export function createImapClient(config: ImapConfig, password: string): ImapFlow {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.username, pass: password },
    logger: false,
    disableAutoIdle: true,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
  });
}

export async function syncImap(
  ctx: CoreContext,
  params: {
    connection: Pick<BankConnectionRow, 'id' | 'config'>;
    account: Pick<BankAccountRow, 'id' | 'iban' | 'currency'>;
    password: string;
  },
): Promise<ImapSyncResult> {
  const config = parseStoredImapConfig(params.connection.config);
  assertImapAllowlist(config);
  await assertImapHostAllowed(config.host);
  const client = createImapClient(config, params.password);
  try {
    await client.connect();
  } catch (err) {
    throw new BankSyncError('IMAP_CONNECT', `IMAP login failed: ${(err as Error).message}`);
  }
  const imports: StatementImportResult[] = [];
  let messages = 0;
  try {
    const lock = await client.getMailboxLock(config.mailbox);
    try {
      const mailbox = client.mailbox;
      const permanent = mailbox ? mailbox.permanentFlags : undefined;
      const keyword =
        !permanent || permanent.has('\\*') || permanent.has(IMAP_PROCESSED_KEYWORD)
          ? IMAP_PROCESSED_KEYWORD
          : '\\Seen';
      const since = new Date(Date.now() - config.lookbackDays * 24 * 3600 * 1000);
      // Skipped mails (foreign sender, wrong subject, oversize) get their own keyword so that
      // they drop out of the search and cannot fill the per-run window forever.
      const query =
        keyword === '\\Seen'
          ? { since, seen: false }
          : { since, unKeyword: IMAP_PROCESSED_KEYWORD, not: { keyword: IMAP_SKIPPED_KEYWORD } };
      // \Seen fallback (server without custom keywords): skipped mails are NOT flagged – marking
      // foreign mails as read would be a side effect on mail that is none of our business.
      // Consequence: they stay in the search and count against the per-run window (50 mails)
      // until they leave the lookback period; use a dedicated mailbox or a server with keywords.
      const skipKeyword = keyword === '\\Seen' ? null : IMAP_SKIPPED_KEYWORD;
      const found = await client.search(
        config.subjectFilter ? { ...query, subject: config.subjectFilter } : query,
        {
          uid: true,
        },
      );
      const uids = (found || []).slice(0, MAX_MESSAGES_PER_RUN);
      const skipInput = {
        maxBytes: MAX_MESSAGE_BYTES,
        allowlist: config.senderAllowlist,
        subjectFilter: config.subjectFilter,
      };
      for (const uid of uids) {
        const skip = async () => {
          if (!skipKeyword) return;
          try {
            await client.messageFlagsAdd(String(uid), [skipKeyword], { uid: true });
          } catch {
            /* flagging is best effort; the per-run window just advances next time */
          }
        };
        // Size first: oversize mails are never downloaded.
        const head = await client.fetchOne(String(uid), { size: true }, { uid: true });
        if (!head) continue;
        if (
          classifyMail({ ...skipInput, size: head.size, from: null, subject: null }) === 'OVERSIZE'
        ) {
          await skip();
          continue;
        }
        const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!message || !message.source) continue;
        const mail = await simpleParser(message.source);
        const from = fromAddress(mail.from);
        if (classifyMail({ ...skipInput, size: head.size, from, subject: mail.subject }) !== null) {
          await skip();
          continue;
        }
        const trusted = isTrustedMailAuth({
          authenticationResults: mail.headers.get('authentication-results') as
            string | string[] | undefined,
          from,
          allowlist: config.senderAllowlist,
          trustedAuthservId: config.trustedAuthservId,
        });
        messages += 1;
        for (const attachment of mail.attachments) {
          const fileName = (attachment.filename ?? 'attachment').replace(/[\\/]/g, '_');
          const bytes = new Uint8Array(attachment.content);
          let accepted = false;
          try {
            accepted = expandStatementFiles({ fileName, bytes }).some((file) => {
              const format: BankStatementFormat | null = detectStatementFormat(
                decodeText(file.bytes, 'auto'),
                file.fileName,
              );
              return format !== null && config.attachmentFormats.includes(format);
            });
          } catch {
            accepted = false;
          }
          if (!accepted) continue;
          imports.push(
            ...(await importStatementFile(ctx, {
              account: params.account,
              connectionId: params.connection.id,
              source: 'IMAP',
              fileName,
              bytes,
              csvProfile: config.csvProfile,
              trusted,
            })),
          );
        }
        if (config.processedMailbox) {
          await client.messageMove(String(uid), config.processedMailbox, { uid: true });
        } else {
          await client.messageFlagsAdd(String(uid), [keyword], { uid: true });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
  await patchConnectionState(ctx, params.connection.id, {
    lastCheckedAt: new Date().toISOString(),
  });
  return { messages, imports };
}

/** Connection test for the Admin Portal (login + mailbox exists). */
export async function testImapConnection(
  config: ImapConfig,
  password: string,
): Promise<{ messages: number }> {
  await assertImapHostAllowed(config.host);
  const client = createImapClient(config, password);
  try {
    await client.connect();
    const status = await client.status(config.mailbox, { messages: true });
    if (!status) throw new BankSyncError('IMAP_MAILBOX', `Mailbox "${config.mailbox}" not found`);
    return { messages: status.messages ?? 0 };
  } finally {
    await client.logout().catch(() => client.close());
  }
}

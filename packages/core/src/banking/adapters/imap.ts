import { imapConfigSchema, type BankStatementFormat, type ImapConfig } from '@tix/shared';
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

/**
 * IMAP mailbox watcher: searches recent mails (sender allow-list, subject filter), imports
 * statement attachments (camt / MT940 / CSV, also inside ZIP archives) and marks processed
 * mails – moved to `processedMailbox` or tagged with the `$TixImported` keyword (\Seen when
 * the server does not allow custom keywords). File-level SHA-256 dedupe makes re-processing
 * harmless.
 */

export const IMAP_PROCESSED_KEYWORD = '$TixImported';
const MAX_MESSAGES_PER_RUN = 50;
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

export interface ImapSyncResult {
  messages: number;
  imports: StatementImportResult[];
}

/** `name@example.org` or `@example.org` entries; empty list = any sender. */
export function senderAllowed(from: string | null, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  if (!from) return false;
  const address = from.trim().toLowerCase();
  return allowlist.some((entry) => {
    const e = entry.trim().toLowerCase();
    return e.startsWith('@') ? address.endsWith(e) : address === e;
  });
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
  const config = imapConfigSchema.parse(params.connection.config);
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
      const query =
        keyword === '\\Seen'
          ? { since, seen: false }
          : { since, unKeyword: IMAP_PROCESSED_KEYWORD };
      const found = await client.search(
        config.subjectFilter ? { ...query, subject: config.subjectFilter } : query,
        {
          uid: true,
        },
      );
      const uids = (found || []).slice(0, MAX_MESSAGES_PER_RUN);
      for (const uid of uids) {
        const message = await client.fetchOne(
          String(uid),
          { source: true, size: true },
          { uid: true },
        );
        if (!message || !message.source || (message.size ?? 0) > MAX_MESSAGE_BYTES) continue;
        const mail = await simpleParser(message.source);
        if (!senderAllowed(fromAddress(mail.from), config.senderAllowlist)) continue;
        if (
          config.subjectFilter &&
          !(mail.subject ?? '').toLowerCase().includes(config.subjectFilter.toLowerCase())
        ) {
          continue;
        }
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

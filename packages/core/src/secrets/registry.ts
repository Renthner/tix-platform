import { TOTP_SECRET_CONTEXT } from '../admin-users';
import { connectionSecretContext } from '../banking/connections';
import { EMAIL_VARIABLES_CONTEXT } from '../email/request';
import { scannerLanAad } from '../scanner/manifest';
import { settingSecretContext } from '../settings';
import { signingKeyAad } from '../tickets/keys';

/**
 * Registry of EVERY place in PostgreSQL that holds a secret-box envelope (`v1.<keyId>.…`).
 *
 * The generic re-encryption (`reEncryptSecrets`) walks exactly these entries to move values that
 * were encrypted with an additional / foreign key to this system's primary key. A value that is
 * missing here would keep depending on the foreign key forever, so tests fail when something is
 * not registered (`secrets-registry.test.ts`: every `*_encrypted` column of the Drizzle schema and
 * every `encrypt(` call site in the sources must be known; the integration test additionally
 * sweeps the live schema for envelope-shaped values).
 *
 * HOW TO ADD ONE: when you store a new secret-box value,
 *  1. add an entry below (table, primary key column(s), value column [+ jsonb key], the SAME
 *     context string your code passes to `encrypt` / `decrypt` – export the helper instead of
 *     copying the string),
 *  2. add the call site file to `ENCRYPT_CALL_SITES` (same file), and
 *  3. put a fixture row for it into the "all artefacts" case of
 *     `backup-source-keys.integration.test.ts`.
 * Values that live only in Redis (staged source keys, bank TAN responses) are not part of a backup
 * and must not be registered; list their call site in `TRANSIENT_ENCRYPT_CALL_SITES`.
 */
export interface SecretColumn {
  /** Stable id, `<table>.<column>` (+ `->>jsonKey` for a key inside a jsonb column). */
  id: string;
  table: string;
  /** Primary key column(s), compared as text for keyset paging. */
  primaryKey: readonly string[];
  /** TEXT column holding the envelope, or the jsonb column when `jsonKey` is set. */
  column: string;
  /** The envelope is a JSON string stored under this top-level key of the jsonb column. */
  jsonKey?: string;
  /** Context (AAD) the value was encrypted with, built from the primary key text(s) of the row. */
  context: (pk: readonly string[]) => string;
}

export const SECRET_COLUMNS: readonly SecretColumn[] = [
  {
    id: 'system_settings.encrypted_value',
    table: 'system_settings',
    primaryKey: ['key'],
    column: 'encrypted_value',
    context: ([key]) => settingSecretContext(key!),
  },
  {
    id: 'bank_connections.credentials_encrypted',
    table: 'bank_connections',
    primaryKey: ['id'],
    column: 'credentials_encrypted',
    context: ([id]) => connectionSecretContext(id!),
  },
  {
    id: 'event_signing_keys.private_key_encrypted',
    table: 'event_signing_keys',
    primaryKey: ['id'],
    column: 'private_key_encrypted',
    context: ([id]) => signingKeyAad(id!),
  },
  {
    id: 'event_scanner_secrets.lan_secret_encrypted',
    table: 'event_scanner_secrets',
    primaryKey: ['event_id'],
    column: 'lan_secret_encrypted',
    context: ([eventId]) => scannerLanAad(eventId!),
  },
  {
    id: 'admin_users.totp_secret_encrypted',
    table: 'admin_users',
    primaryKey: ['id'],
    column: 'totp_secret_encrypted',
    context: ([id]) => TOTP_SECRET_CONTEXT(id!),
  },
  {
    id: 'admin_users.totp_pending_secret_encrypted',
    table: 'admin_users',
    primaryKey: ['id'],
    column: 'totp_pending_secret_encrypted',
    context: ([id]) => TOTP_SECRET_CONTEXT(id!),
  },
  {
    id: 'email_messages.attachments->>variables',
    table: 'email_messages',
    primaryKey: ['id'],
    column: 'attachments',
    jsonKey: 'variables',
    context: () => EMAIL_VARIABLES_CONTEXT,
  },
];

/**
 * Source files (relative to the repository root) that call `encrypt(` / `encryptJson(` on a secret
 * box for a value persisted in PostgreSQL, with the registry entries that cover them.
 */
export const ENCRYPT_CALL_SITES: Readonly<Record<string, readonly string[]>> = {
  'packages/core/src/settings.ts': ['system_settings.encrypted_value'],
  'packages/core/src/banking/connections.ts': ['bank_connections.credentials_encrypted'],
  'packages/core/src/tickets/keys.ts': ['event_signing_keys.private_key_encrypted'],
  'packages/core/src/scanner/manifest.ts': ['event_scanner_secrets.lan_secret_encrypted'],
  'packages/core/src/admin-users.ts': [
    'admin_users.totp_secret_encrypted',
    'admin_users.totp_pending_secret_encrypted',
  ],
  'packages/core/src/email/request.ts': ['email_messages.attachments->>variables'],
};

/** Call sites whose ciphertext is short-lived Redis state (never in a backup, nothing to migrate). */
export const TRANSIENT_ENCRYPT_CALL_SITES: Readonly<Record<string, string>> = {
  'packages/core/src/backup/source-keys.ts': 'staged source keys (Redis, 1 h, single use)',
  'packages/core/src/banking/tan.ts': 'TAN responses of the admin (Redis, minutes, single use)',
};

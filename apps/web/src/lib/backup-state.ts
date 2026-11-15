/** Result of a backup server action (operation buttons; translated in `backups.feedback.*`). */
export type BackupActionState =
  | { status: 'idle' }
  | {
      status: 'success';
      code: 'queued' | 'deleted' | 'connectionOk';
      at: number;
    }
  | {
      status: 'error';
      code:
        | 'generic'
        | 'busy'
        | 'notFound'
        | 'password'
        | 'twoFactorRequired'
        | 'twoFactorInvalid'
        | 'passkeyInvalid'
        | 'acknowledge'
        | 'locked'
        | 'rateLimited'
        | 'connectionFailed'
        | 'connectionIncomplete'
        | 'endpointNotAllowed'
        | 'protected'
        | 'sourceKeysInvalid'
        | 'sourceKeysConflict'
        | 'sourceKeysDisabled'
        | 'twoFactorSetupRequired';
      /** Technical detail of connection errors (never contains secrets). */
      detail?: string;
      at: number;
    };

export const BACKUP_IDLE: BackupActionState = { status: 'idle' };

/** Shown by the restore dialog before the confirmation. */
export interface RestorePreview {
  backupCreatedAt: string;
  loss: { orders: number; invoices: number; payments: number; refunds: number };
  /** The admin has an authenticator app and/or a passkey. */
  twoFactor: boolean;
  /** The admin can confirm with a passkey (has one and the public URL allows WebAuthn). */
  passkeys: boolean;
  /** Restore needs 2FA by setting, but this admin has none: the dialog explains and links to the account page. */
  twoFactorSetupRequired: boolean;
  /** The operator allows keys of another system (`TIX_ALLOW_FOREIGN_BACKUP_KEYS`). */
  foreignKeysAllowed: boolean;
}

/** Result of the "check key" step in the restore dialog (nothing is started or stored). */
export type SourceKeyCheck =
  | {
      result:
        | 'match'
        | 'unknown'
        | 'mismatch'
        | 'invalid'
        | 'notBackup'
        | 'notFound'
        | 'empty'
        | 'readable'
        | 'disabled';
    }
  | { result: 'conflict'; detail: string }
  | { result: 'rateLimited' };

/** Result of parking the typed source keys before an upload (returns an opaque single-use token). */
export type StageKeysResult =
  | { ok: true; token: string }
  | { ok: false; error: 'invalid' | 'conflict' | 'rateLimited' | 'disabled' };

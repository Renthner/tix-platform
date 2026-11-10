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
        | 'acknowledge'
        | 'locked'
        | 'rateLimited'
        | 'connectionFailed'
        | 'connectionIncomplete'
        | 'endpointNotAllowed'
        | 'protected'
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
  twoFactor: boolean;
  /** Restore needs 2FA by setting, but this admin has none: the dialog explains and links to the account page. */
  twoFactorSetupRequired: boolean;
}

/**
 * Result of a customer-account server action, shared by the actions and the client forms.
 * Codes are translated in the UI (`account.errors.<code>`, `account.fieldErrors.<code>`,
 * `account.messages.<code>`); `values` fills ICU placeholders such as {min} or {email}.
 */
export const ACCOUNT_FORM_ERRORS = [
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'RATE_LIMITED',
  'TOKEN_INVALID',
  'ACCOUNTS_DISABLED',
  'LOGIN_LINK_DISABLED',
  'CURRENT_PASSWORD_INVALID',
  'SESSION_EXPIRED',
  'VALIDATION_FAILED',
  'GENERIC',
] as const;
export type AccountFormError = (typeof ACCOUNT_FORM_ERRORS)[number];

export type AccountFieldError =
  | 'required'
  | 'email'
  | 'tooLong'
  | 'invalid'
  | 'country'
  | 'passwordTooShort'
  | 'passwordMismatch';

export type AccountFormMessage =
  | 'registered'
  | 'linkSent'
  | 'resetSent'
  | 'verificationSent'
  | 'alreadyVerified'
  | 'profileSaved'
  | 'passwordChanged';

export type AccountFormValues = Record<string, string | number>;

export type AccountFormState =
  | { status: 'idle' }
  | {
      status: 'error';
      error: AccountFormError;
      fieldErrors?: Partial<Record<string, AccountFieldError>>;
      values?: AccountFormValues;
      at: number;
    }
  | { status: 'success'; message: AccountFormMessage; values?: AccountFormValues; at: number }
  /** Password accepted, a second factor is required (shop sign-in of an admin account). */
  | { status: 'twoFactor'; at: number };

export const ACCOUNT_IDLE: AccountFormState = { status: 'idle' };

export function fieldErrorOf(state: AccountFormState, name: string): AccountFieldError | undefined {
  return state.status === 'error' ? state.fieldErrors?.[name] : undefined;
}

/**
 * Result of an admin server action, shared by server actions and client forms.
 * Errors are machine-readable codes translated in the UI (`admin.errors.<code>`).
 */
export const FIELD_ERROR_CODES = [
  'required',
  'invalid',
  'tooLong',
  'tooSmall',
  'tooLarge',
  'slugFormat',
  'slugTaken',
  'nameTaken',
  'codeFormat',
  'codeTaken',
  'timeZone',
  'money',
  'percent',
  'dateOrder',
  'url',
  'country',
  'email',
  'fileRequired',
  'svgTooLarge',
  'svgInvalid',
  'svgEmpty',
  'svgTooComplex',
  'confirmMismatch',
  'numberPattern',
  'dunningOrder',
  'secretRequired',
  'prefixFormat',
  'pngOnly',
  'hostNotAllowed',
] as const;
export type FieldErrorCode = (typeof FIELD_ERROR_CODES)[number];

export const FORM_ERROR_CODES = [
  'generic',
  'notFound',
  'inUse',
  'publishIncomplete',
  'warningRequired',
  'templateMismatch',
  'eventHasOrders',
  'eventNotArchived',
  'builtinSymbol',
  'venueHasEvents',
  'mediaInUse',
] as const;
export type FormErrorCode = (typeof FORM_ERROR_CODES)[number];

export type ActionState =
  | { status: 'idle' }
  | {
      status: 'success';
      message?: 'saved' | 'created' | 'deleted' | 'reset' | 'published';
      at: number;
    }
  | {
      status: 'error';
      fieldErrors?: Partial<Record<string, FieldErrorCode>>;
      formError?: FormErrorCode;
      at: number;
    };

export const IDLE: ActionState = { status: 'idle' };

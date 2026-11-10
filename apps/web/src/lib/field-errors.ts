'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { mapIssuesToFields, type FieldMap, validationIssues } from './validation-issues';

export { fieldForPath, mapIssuesToFields, validationIssues } from './validation-issues';
export type { FieldMap, ValidationIssue } from './validation-issues';

/**
 * Field-level validation feedback for client forms that talk to JSON APIs.
 *
 *  - `apply(err)` reads a VALIDATION_FAILED error, remembers the affected controls and focuses the
 *    first one (document order); returns true when at least one control was matched.
 *  - `invalid(id)` → `true | undefined` for `aria-invalid` (red border + destructive ring come from
 *    the shared Input / Select styles), `message(id)` the text to show next to the control.
 *  - `clear(id)` removes the error of one control; attach `onChange` of the `<form>` as
 *    `onFormChange` to clear by the changed control's `id` automatically.
 */
export function useFieldErrors(fields: FieldMap, fallbackMessage: string) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const focusRequest = useRef(0);
  const [round, setRound] = useState(0);

  const apply = useCallback(
    (err: unknown): boolean => {
      const issues = validationIssues(err);
      if (!issues) return false;
      const mapped = mapIssuesToFields(issues, fields);
      if (Object.keys(mapped).length === 0) return false;
      setErrors(mapped);
      focusRequest.current += 1;
      setRound(focusRequest.current);
      return true;
    },
    [fields],
  );

  // Focus the first invalid control after the error state rendered.
  useEffect(() => {
    if (round === 0) return;
    const elements = Object.keys(errors)
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    elements.sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    const first = elements[0];
    if (!first) return;
    first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    first.focus({ preventScroll: true });
    // only when a new validation result arrived
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round]);

  const clear = useCallback((id: string) => {
    setErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const reset = useCallback(() => setErrors({}), []);

  return {
    errors,
    apply,
    clear,
    reset,
    invalid: (id: string): true | undefined => (id in errors ? true : undefined),
    message: (id: string): string | undefined => (id in errors ? fallbackMessage : undefined),
    onFormChange: (event: { target: EventTarget }) => {
      const id = (event.target as { id?: string }).id;
      if (id) clear(id);
    },
  };
}

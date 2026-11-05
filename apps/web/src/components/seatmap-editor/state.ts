import { useCallback, useReducer } from 'react';
import {
  EMPTY_SELECTION,
  EMPTY_SET,
  HISTORY_LIMIT,
  pruneSelection,
  type Doc,
  type Selection,
} from './model';

/**
 * Editor state: the document with an undo/redo history, the selection and transient
 * highlights. The persisted `version` is tracked outside the history so undo never
 * reverts the optimistic-concurrency token.
 */

export interface EditorState {
  doc: Doc;
  /** Version the next save must send (bumped after each successful save). */
  version: number;
  /** Reference of the last saved document – `doc !== saved` means unsaved changes. */
  saved: Doc;
  past: Doc[];
  future: Doc[];
  coalesce: { key: string; at: number } | null;
  selection: Selection;
  /** Seats to highlight (e.g. returned by the server as "in use"). */
  highlight: ReadonlySet<string>;
}

export type EditorAction =
  | { type: 'apply'; update: (doc: Doc) => Doc; coalesceKey?: string; select?: Selection }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'select'; selection: Selection }
  | { type: 'highlight'; ids: ReadonlySet<string> }
  | { type: 'saved'; doc: Doc; version: number }
  | { type: 'replace'; doc: Doc };

const COALESCE_MS = 1_500;

function reducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'apply': {
      const next = action.update(state.doc);
      if (next === state.doc) {
        return action.select
          ? { ...state, selection: pruneSelection(action.select, state.doc) }
          : state;
      }
      const now = Date.now();
      const coalesce =
        action.coalesceKey !== undefined &&
        state.coalesce?.key === action.coalesceKey &&
        now - state.coalesce.at < COALESCE_MS;
      const past = coalesce ? state.past : [...state.past, state.doc].slice(-HISTORY_LIMIT);
      return {
        ...state,
        doc: next,
        past,
        future: [],
        coalesce: action.coalesceKey ? { key: action.coalesceKey, at: now } : null,
        selection: pruneSelection(action.select ?? state.selection, next),
      };
    }
    case 'undo': {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return {
        ...state,
        doc: previous,
        past: state.past.slice(0, -1),
        future: [state.doc, ...state.future].slice(0, HISTORY_LIMIT),
        coalesce: null,
        selection: pruneSelection(state.selection, previous),
      };
    }
    case 'redo': {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return {
        ...state,
        doc: next,
        past: [...state.past, state.doc].slice(-HISTORY_LIMIT),
        future: rest,
        coalesce: null,
        selection: pruneSelection(state.selection, next),
      };
    }
    case 'select':
      return { ...state, selection: action.selection };
    case 'highlight':
      return { ...state, highlight: action.ids };
    case 'saved':
      return {
        ...state,
        saved: action.doc,
        version: action.version,
        coalesce: null,
        highlight: EMPTY_SET,
      };
    case 'replace':
      return {
        doc: action.doc,
        version: action.doc.version,
        saved: action.doc,
        past: [],
        future: [],
        coalesce: null,
        selection: EMPTY_SELECTION,
        highlight: EMPTY_SET,
      };
  }
}

export function useEditorState(initial: Doc) {
  const [state, dispatch] = useReducer(reducer, initial, (doc): EditorState => ({
    doc,
    version: doc.version,
    saved: doc,
    past: [],
    future: [],
    coalesce: null,
    selection: EMPTY_SELECTION,
    highlight: EMPTY_SET,
  }));

  const apply = useCallback(
    (update: (doc: Doc) => Doc, coalesceKey?: string, select?: Selection) =>
      dispatch({ type: 'apply', update, coalesceKey, select }),
    [],
  );
  const select = useCallback((selection: Selection) => dispatch({ type: 'select', selection }), []);

  return { state, dispatch, apply, select };
}

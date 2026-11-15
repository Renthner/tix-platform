import type { Doc, Selection } from '../model';
import type { EditorSymbol } from '../types';

export type Apply = (update: (doc: Doc) => Doc, coalesceKey?: string, select?: Selection) => void;

export interface PanelProps {
  doc: Doc;
  selection: Selection;
  /** Category assignment is available (event plans: price categories, master plans: plan categories). */
  isEventMap: boolean;
  /** Master plan: plan categories are edited in the plan panel. */
  planCategories?: boolean;
  categories: { id: string; name: string; color: string }[];
  symbols: EditorSymbol[];
  apply: Apply;
  select: (selection: Selection) => void;
}

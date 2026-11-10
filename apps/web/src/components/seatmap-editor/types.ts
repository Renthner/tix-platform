import type { PublicSymbol, SeatMapDocument, SymbolKind } from '@tix/shared';

/** Symbol from the SVG library offered in the editor (seat shapes / element icons). */
export interface EditorSymbol extends PublicSymbol {
  name: string;
  kind: SymbolKind;
}

/** Contract between the editor page (server) and the client editor. */
export interface SeatMapEditorProps {
  seatMapId: string;
  kind: 'TEMPLATE' | 'EVENT';
  initialDocument: SeatMapDocument;
  /** Price categories of the event (empty for templates). */
  categories: { id: string; name: string; color: string }[];
  /** Venue name (template) or event title (event map). */
  title: string;
  /** Locale-independent admin path to return to. */
  backHref: string;
  /** Complete symbol library (both kinds). */
  symbols: EditorSymbol[];
  /** Content language switch: base language, edited language and completeness per language. */
  translation?: {
    baseLocale: string;
    /** Language being edited; equals `baseLocale` for the normal editor. */
    editLocale: string;
    options: { locale: string; done: number; total: number }[];
  };
}

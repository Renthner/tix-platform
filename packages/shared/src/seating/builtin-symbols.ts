import type { SymbolKind } from '../enums';

/**
 * Built-in SVG symbols seeded into `svg_symbols` (key = `builtin_key`). Original artwork
 * of this project, drawn on a 24×24 grid. Seat shapes are filled silhouettes; element icons
 * are stroke drawings. All paint uses `currentColor` so the symbols follow the seat /
 * element colour. Admins can rename them, upload their own and pick per seat / element.
 */
export interface BuiltinSymbol {
  key: string;
  name: string;
  kind: SymbolKind;
  viewBox: string;
  markup: string;
}

const stroke = (inner: string) =>
  `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;
const solid = (inner: string) => `<g fill="currentColor">${inner}</g>`;

export const BUILTIN_SYMBOLS: readonly BuiltinSymbol[] = [
  // ── Seat shapes ────────────────────────────────────────────────────────
  {
    key: 'seat-theatre',
    name: 'Theatre seat',
    kind: 'SEAT',
    viewBox: '0 0 24 24',
    markup: solid(
      '<path d="M6 2h12a2.5 2.5 0 0 1 2.5 2.5V13h-17V4.5A2.5 2.5 0 0 1 6 2z"/><path d="M2 14.5h20V18a2 2 0 0 1-2 2h-1v2h-2.5v-2h-9v2H5v-2H4a2 2 0 0 1-2-2z"/>',
    ),
  },
  {
    // Seen from above, facing up (front edge at the top, backrest at the bottom) – rotates
    // with the row so the seats visibly face the stage.
    key: 'seat-topview',
    name: 'Seat (top view)',
    kind: 'SEAT',
    viewBox: '0 0 24 24',
    markup: solid(
      '<rect x="6.5" y="2.5" width="11" height="14" rx="2.5" opacity="0.72"/><rect x="2" y="5.5" width="3.6" height="13.5" rx="1.6"/><rect x="18.4" y="5.5" width="3.6" height="13.5" rx="1.6"/><rect x="2.5" y="17.5" width="19" height="4.5" rx="2.2"/>',
    ),
  },
  {
    key: 'seat-armchair',
    name: 'Armchair',
    kind: 'SEAT',
    viewBox: '0 0 24 24',
    markup: solid(
      '<rect x="5" y="3" width="14" height="10" rx="3"/><rect x="1.5" y="9" width="4.5" height="10" rx="2"/><rect x="18" y="9" width="4.5" height="10" rx="2"/><rect x="5" y="13" width="14" height="5" rx="1.5"/><rect x="6" y="18" width="2.5" height="3.5" rx="0.5"/><rect x="15.5" y="18" width="2.5" height="3.5" rx="0.5"/>',
    ),
  },
  {
    key: 'seat-sofa',
    name: 'Sofa seat',
    kind: 'SEAT',
    viewBox: '0 0 24 24',
    markup: solid(
      '<rect x="3" y="5" width="18" height="8" rx="2.5"/><rect x="1" y="10" width="4" height="9" rx="2"/><rect x="19" y="10" width="4" height="9" rx="2"/><rect x="4" y="13" width="16" height="5" rx="1.5"/><rect x="4" y="18" width="2" height="3" rx="0.5"/><rect x="18" y="18" width="2" height="3" rx="0.5"/>',
    ),
  },
  {
    key: 'seat-stool',
    name: 'Bar stool',
    kind: 'SEAT',
    viewBox: '0 0 24 24',
    markup: solid(
      '<ellipse cx="12" cy="5.5" rx="8" ry="3.5"/><rect x="10.5" y="8" width="3" height="10" rx="1"/><path d="M5.5 22l4.5-4h4l4.5 4z"/>',
    ),
  },
  {
    key: 'seat-square',
    name: 'Square seat',
    kind: 'SEAT',
    viewBox: '0 0 24 24',
    markup: solid('<rect x="3" y="3" width="18" height="18" rx="4"/>'),
  },
  {
    key: 'seat-wheelchair',
    name: 'Wheelchair space',
    kind: 'SEAT',
    viewBox: '0 0 24 24',
    markup: solid(
      '<circle cx="10" cy="3.5" r="2.5"/><path d="M8.5 7h3v4.5h5.2l3.3 6.6-2.2 1.1-2.7-5.2H8.5z"/><path d="M6.4 10.6l.5 2.3a4.5 4.5 0 1 0 6.6 5.6l2.2.7A6.8 6.8 0 1 1 6.4 10.6z"/>',
    ),
  },

  // ── Element icons ──────────────────────────────────────────────────────
  {
    key: 'icon-camera',
    name: 'Camera',
    kind: 'ELEMENT',
    viewBox: '0 0 24 24',
    markup: stroke(
      '<rect x="2" y="7" width="14" height="10" rx="2"/><path d="M16 11l6-3.5v9L16 13"/>',
    ),
  },
  {
    key: 'icon-speaker',
    name: 'Loudspeaker',
    kind: 'ELEMENT',
    viewBox: '0 0 24 24',
    markup: stroke(
      '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 9a4 4 0 0 1 0 6"/><path d="M19 6.5a8 8 0 0 1 0 11"/>',
    ),
  },
  {
    key: 'icon-mixing-desk',
    name: 'Mixing desk (FOH)',
    kind: 'ELEMENT',
    viewBox: '0 0 24 24',
    markup: stroke(
      '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 8v8M12 8v8M17 8v8"/><path d="M5.5 11h3M10.5 14h3M15.5 10h3"/>',
    ),
  },
  {
    key: 'icon-microphone',
    name: 'Microphone',
    kind: 'ELEMENT',
    viewBox: '0 0 24 24',
    markup: stroke(
      '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v4M8 22h8"/>',
    ),
  },
  {
    key: 'icon-spotlight',
    name: 'Spotlight',
    kind: 'ELEMENT',
    viewBox: '0 0 24 24',
    markup: stroke(
      '<path d="M8 3h8l2 6H6z"/><path d="M12 9v3"/><path d="M7 21l5-9 5 9"/><path d="M4 21h16"/>',
    ),
  },
  {
    // Theatre curtain: rod, two gathered drapes with folds, stage floor.
    key: 'icon-stage',
    name: 'Stage',
    kind: 'ELEMENT',
    viewBox: '0 0 24 24',
    markup: stroke(
      '<path d="M2 3h20"/><path d="M3 3v15.5c2.5-.5 4.5-3.5 5.5-7C9.3 8 10.2 5 11.5 3"/><path d="M21 3v15.5c-2.5-.5-4.5-3.5-5.5-7C14.7 8 13.8 5 12.5 3"/><path d="M5.6 5.5v9.5M18.4 5.5v9.5"/><path d="M2 21.5h20"/>',
    ),
  },
  {
    // Band: guitar, drum, microphone and keyboard in a 2 × 2 grid.
    key: 'icon-band',
    name: 'Band',
    kind: 'ELEMENT',
    viewBox: '0 0 24 24',
    markup:
      '<g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="4.2" cy="7.8" r="2.7"/><path d="M6.1 5.9L10 2"/><path d="M9 1.4l1.6 1.6"/>' +
      '<ellipse cx="18.5" cy="4.6" rx="4" ry="1.6"/><path d="M14.5 4.6v4c0 .9 1.8 1.6 4 1.6s4-.7 4-1.6v-4"/><path d="M15.4 .9l2 2.4M21.6 .9l-2 2.4"/>' +
      '<rect x="3.5" y="13" width="4" height="6" rx="2"/><path d="M2 17.2a3.5 3.5 0 0 0 7 0"/><path d="M5.5 20.7v2.4M3.5 23.1h4"/>' +
      '<rect x="13" y="15" width="10" height="7" rx="1"/><path d="M15.5 15v4M18 15v4M20.5 15v4"/>' +
      '</g>',
  },
  {
    key: 'icon-wc',
    name: 'Toilets',
    kind: 'ELEMENT',
    viewBox: '0 0 24 24',
    markup: stroke(
      '<circle cx="6.5" cy="4" r="2"/><path d="M4.5 22v-7H3.5l1-7h4l1 7h-1v7"/><circle cx="17.5" cy="4" r="2"/><path d="M15.5 22v-6h-2l2-8h4l2 8h-2v6"/><path d="M12 2v20"/>',
    ),
  },
  {
    key: 'icon-bar',
    name: 'Bar',
    kind: 'ELEMENT',
    viewBox: '0 0 24 24',
    markup: stroke('<path d="M5 3h14l-7 8z"/><path d="M12 11v9"/><path d="M8 21h8"/>'),
  },
  {
    key: 'icon-food',
    name: 'Food',
    kind: 'ELEMENT',
    viewBox: '0 0 24 24',
    markup: stroke(
      '<path d="M6 2v7a2 2 0 0 0 2 2v11"/><path d="M4 2v5M8 2v5"/><path d="M17 2c-2.5 2.5-2.5 7 0 9v11"/>',
    ),
  },
  {
    key: 'icon-cloakroom',
    name: 'Cloakroom',
    kind: 'ELEMENT',
    viewBox: '0 0 24 24',
    markup: stroke(
      '<path d="M10 6a2 2 0 1 1 2 2c-.8 0-1 .6-1 1.5L21 17a1 1 0 0 1-.6 1.8H3.6A1 1 0 0 1 3 17l8-7.5"/>',
    ),
  },
  {
    key: 'icon-merchandise',
    name: 'Merchandise',
    kind: 'ELEMENT',
    viewBox: '0 0 24 24',
    markup: stroke('<path d="M8 3L3 6l2 5 3-1v11h8V10l3 1 2-5-5-3c0 2-1.5 3-4 3S8 5 8 3z"/>'),
  },
  {
    key: 'icon-info',
    name: 'Information',
    kind: 'ELEMENT',
    viewBox: '0 0 24 24',
    markup: stroke('<circle cx="12" cy="12" r="10"/><path d="M12 11v6"/><path d="M12 7.5h.01"/>'),
  },
  {
    key: 'icon-first-aid',
    name: 'First aid',
    kind: 'ELEMENT',
    viewBox: '0 0 24 24',
    markup: stroke('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 8v8M8 12h8"/>'),
  },
  {
    key: 'icon-accessible',
    name: 'Accessible',
    kind: 'ELEMENT',
    viewBox: '0 0 24 24',
    markup: stroke(
      '<circle cx="10" cy="4" r="1.6"/><path d="M10 7.5v5.5h6l3 6"/><path d="M7 10.5A5.5 5.5 0 1 0 14.8 18"/>',
    ),
  },
  {
    key: 'icon-stairs',
    name: 'Stairs',
    kind: 'ELEMENT',
    viewBox: '0 0 24 24',
    markup: stroke('<path d="M3 20h5v-5h5v-5h5V5h3"/>'),
  },
  {
    key: 'icon-entrance',
    name: 'Entrance',
    kind: 'ELEMENT',
    viewBox: '0 0 24 24',
    markup: stroke(
      '<path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5"/><path d="M3 12h12"/><path d="M11 8l4 4-4 4"/>',
    ),
  },
  {
    key: 'icon-exit',
    name: 'Exit',
    kind: 'ELEMENT',
    viewBox: '0 0 24 24',
    markup: stroke(
      '<path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5"/><path d="M9 12h12"/><path d="M17 8l4 4-4 4"/>',
    ),
  },
  {
    key: 'icon-star',
    name: 'VIP / star',
    kind: 'ELEMENT',
    viewBox: '0 0 24 24',
    markup: stroke(
      '<path d="M12 2.5l2.9 6 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.2 1.3-6.6-4.9-4.6 6.6-.8z"/>',
    ),
  },
];

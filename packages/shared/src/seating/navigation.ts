/**
 * Keyboard navigation over the seats of a public seating plan (pure geometry, no DOM).
 *
 * Seats are grouped into rows (seats without a row form one pseudo row per section, ordered by x).
 * Left / right follow the row on screen, up / down go to the neighbouring row of the same section
 * and pick the seat nearest by x. At the edge of a section the arrows continue into the section
 * that lies in that direction (nearest seat inside a 60 degree cone by real coordinates). Home / End
 * jump to the row ends, Ctrl+Home / Ctrl+End (first / last) to the first / last seat of the plan,
 * PageUp / PageDown move between sections (in plan order).
 */
import type { PublicSeat } from './public';

export type SeatNavKey =
  'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'first' | 'last' | 'pageUp' | 'pageDown';

/** tan(60 deg): half-width of the search cone for cross-section moves. */
const CONE_TAN = Math.tan(Math.PI / 3);

type NavSeat = Pick<PublicSeat, 'i' | 's' | 'r' | 'p' | 'x' | 'y'>;

interface NavRow {
  key: string;
  section: string;
  /** Mean y of the row (screen "height"). */
  y: number;
  /** Seats from the visually left end to the right end. */
  seats: NavSeat[];
}

export interface SeatNavigator {
  /** Seat reached from `fromId` with `key`, or null when there is no such neighbour. */
  move(fromId: string, key: SeatNavKey): string | null;
  /** Section ids in navigation order. */
  sections: string[];
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
}

/** Builds the navigator. `sectionOrder` = section ids in plan order (unknown sections are appended). */
export function createSeatNavigator(
  seats: readonly NavSeat[],
  sectionOrder: readonly string[],
): SeatNavigator {
  const groups = new Map<string, NavSeat[]>();
  for (const seat of seats) {
    const key = seat.r ? `r:${seat.r}` : `s:${seat.s}`;
    const list = groups.get(key) ?? [];
    list.push(seat);
    groups.set(key, list);
  }

  const rows: NavRow[] = [];
  for (const [key, list] of groups) {
    let ordered: NavSeat[];
    if (key.startsWith('r:')) {
      // Logical order by position; then flip so that "right" really is to the right on screen.
      ordered = [...list].sort((a, b) => (a.p ?? 0) - (b.p ?? 0) || a.x - b.x);
      const first = ordered[0]!;
      const last = ordered[ordered.length - 1]!;
      const horizontal = Math.abs(last.x - first.x) >= Math.abs(last.y - first.y);
      if (horizontal ? last.x < first.x : last.y < first.y) ordered.reverse();
    } else {
      ordered = [...list].sort((a, b) => a.x - b.x || a.y - b.y);
    }
    rows.push({
      key,
      section: ordered[0]!.s,
      y: mean(ordered.map((s) => s.y)),
      seats: ordered,
    });
  }

  const sections = [...sectionOrder];
  for (const row of rows) if (!sections.includes(row.section)) sections.push(row.section);
  const usedSections = sections.filter((id) => rows.some((r) => r.section === id));

  const rowsBySection = new Map<string, NavRow[]>();
  for (const id of usedSections) {
    rowsBySection.set(
      id,
      rows.filter((r) => r.section === id).sort((a, b) => a.y - b.y),
    );
  }
  const rowOfSeat = new Map<string, { row: NavRow; index: number }>();
  for (const row of rows) row.seats.forEach((seat, index) => rowOfSeat.set(seat.i, { row, index }));

  const nearestByX = (row: NavRow, x: number): NavSeat => {
    let best = row.seats[0]!;
    for (const seat of row.seats) {
      if (Math.abs(seat.x - x) < Math.abs(best.x - x)) best = seat;
    }
    return best;
  };

  /**
   * Nearest seat of ANOTHER section in a screen direction: inside a cone of +-CONE_HALF_ANGLE around
   * the direction, ranked by distance along the axis plus twice the sideways offset (so a seat
   * straight ahead beats a nearer one far off to the side; staggered / offset / curved layouts work).
   */
  const crossSection = (from: NavSeat, dx: number, dy: number): string | null => {
    let best: string | null = null;
    let bestScore = Infinity;
    for (const seat of seats) {
      if (seat.s === from.s || !rowOfSeat.has(seat.i)) continue;
      const along = (seat.x - from.x) * dx + (seat.y - from.y) * dy;
      if (along <= 0) continue;
      const side = Math.abs((seat.x - from.x) * dy - (seat.y - from.y) * dx);
      if (side > along * CONE_TAN) continue;
      const score = along + 2 * side;
      if (score < bestScore) {
        bestScore = score;
        best = seat.i;
      }
    }
    return best;
  };
  const plan = usedSections.flatMap((id) =>
    (rowsBySection.get(id) ?? []).flatMap((row) => row.seats),
  );

  return {
    sections: usedSections,
    move(fromId, key) {
      const at = rowOfSeat.get(fromId);
      if (!at) return null;
      const { row, index } = at;
      const here = row.seats[index]!;
      switch (key) {
        case 'left':
          return row.seats[index - 1]?.i ?? crossSection(here, -1, 0);
        case 'right':
          return row.seats[index + 1]?.i ?? crossSection(here, 1, 0);
        case 'home':
          return row.seats[0]!.i;
        case 'end':
          return row.seats[row.seats.length - 1]!.i;
        case 'first':
          return plan[0]?.i ?? null;
        case 'last':
          return plan[plan.length - 1]?.i ?? null;
        case 'up':
        case 'down': {
          const sectionRows = rowsBySection.get(row.section) ?? [];
          const pos = sectionRows.indexOf(row);
          const target = sectionRows[pos + (key === 'up' ? -1 : 1)];
          return target
            ? nearestByX(target, here.x).i
            : crossSection(here, 0, key === 'up' ? -1 : 1);
        }
        case 'pageUp':
        case 'pageDown': {
          const pos = usedSections.indexOf(row.section);
          const next = usedSections[pos + (key === 'pageUp' ? -1 : 1)];
          const target = next ? rowsBySection.get(next)?.[0] : undefined;
          return target ? target.seats[0]!.i : null;
        }
      }
    },
  };
}

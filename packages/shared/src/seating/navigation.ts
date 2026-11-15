/**
 * Keyboard navigation over the seats of a public seating plan (pure geometry, no DOM).
 *
 * Seats are grouped into rows (seats without a row form one pseudo row per section, ordered by x).
 * Left / right follow the row on screen, up / down go to the neighbouring row of the same section
 * and pick the seat nearest by x, Home / End jump to the row ends, PageUp / PageDown move between
 * sections (in plan order).
 */
import type { PublicSeat } from './public';

export type SeatNavKey = 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'pageUp' | 'pageDown';

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

  return {
    sections: usedSections,
    move(fromId, key) {
      const at = rowOfSeat.get(fromId);
      if (!at) return null;
      const { row, index } = at;
      switch (key) {
        case 'left':
          return row.seats[index - 1]?.i ?? null;
        case 'right':
          return row.seats[index + 1]?.i ?? null;
        case 'home':
          return row.seats[0]!.i;
        case 'end':
          return row.seats[row.seats.length - 1]!.i;
        case 'up':
        case 'down': {
          const sectionRows = rowsBySection.get(row.section) ?? [];
          const pos = sectionRows.indexOf(row);
          const target = sectionRows[pos + (key === 'up' ? -1 : 1)];
          return target ? nearestByX(target, row.seats[index]!.x).i : null;
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

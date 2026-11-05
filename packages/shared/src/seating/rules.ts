import { SEAT_FLAG } from './public';

/**
 * Seat selection rules (pure functions, used by the server and for instant UI hints).
 */

// ─── Orphan seat rule (Einzelplatz-Regel) ───────────────────────────────────

export type RowSeatState = 'free' | 'taken' | 'mine';

export interface RowSeat {
  id: string;
  /** Adjacency position; seats are neighbours iff positions differ by exactly 1. */
  position: number;
  state: RowSeatState;
}

/**
 * Returns the seats that would be left as isolated single free seats *because of* the
 * session's selection ("mine"), where a better placement would have been possible.
 *
 * Within each run of consecutive non-taken seats (length L) containing k selected seats,
 * a single free seat left over is unavoidable only if L − k = 1 – that case is allowed
 * ("unless no other seats exist in that row"). Pre-existing single seats that the
 * selection does not touch are never reported.
 */
export function findOrphanSeats(row: RowSeat[]): string[] {
  const seats = [...row].sort((a, b) => a.position - b.position);
  const orphans: string[] = [];
  let run: RowSeat[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const k = run.filter((s) => s.state === 'mine').length;
    if (k > 0 && run.length - k !== 1) {
      let gap: RowSeat[] = [];
      const closeGap = () => {
        if (gap.length === 1) orphans.push(gap[0]!.id);
        gap = [];
      };
      for (const seat of run) {
        if (seat.state === 'free') gap.push(seat);
        else closeGap();
      }
      closeGap();
    }
    run = [];
  };

  let prevPosition: number | null = null;
  for (const seat of seats) {
    const adjacent = prevPosition !== null && seat.position === prevPosition + 1;
    if (!adjacent || seat.state === 'taken') flush();
    if (seat.state !== 'taken') run.push(seat);
    prevPosition = seat.position;
  }
  flush();
  return orphans;
}

// ─── Companion seats (Begleitplätze) ────────────────────────────────────────

export interface CompanionSeatInput {
  id: string;
  /** Row or table the seat belongs to (adjacency scope). */
  parentId: string | null;
  position: number | null;
  isWheelchairSpace: boolean;
  isCompanionSeat: boolean;
  /** Explicit assignment; null = the directly adjacent wheelchair space(s). */
  companionOfSeatId: string | null;
}

/**
 * Wheelchair space(s) each companion seat belongs to: the explicitly assigned one, else the
 * wheelchair spaces directly next to it (position ± 1 in the same row / at the same table).
 * Companion seats without any wheelchair space are not included (they cannot be paired).
 */
export function companionPartners(seats: readonly CompanionSeatInput[]): Map<string, string[]> {
  const byId = new Map(seats.map((s) => [s.id, s]));
  const wheelchairAt = new Map<string, string>();
  for (const s of seats) {
    if (s.isWheelchairSpace && s.parentId && s.position !== null)
      wheelchairAt.set(`${s.parentId}|${s.position}`, s.id);
  }
  const result = new Map<string, string[]>();
  for (const s of seats) {
    if (!s.isCompanionSeat) continue;
    const explicit = s.companionOfSeatId ? byId.get(s.companionOfSeatId) : undefined;
    if (explicit?.isWheelchairSpace) {
      result.set(s.id, [explicit.id]);
      continue;
    }
    if (!s.parentId || s.position === null) continue;
    const partners = [s.position - 1, s.position + 1]
      .map((p) => wheelchairAt.get(`${s.parentId}|${p}`))
      .filter((id): id is string => id !== undefined);
    if (partners.length > 0) result.set(s.id, partners);
  }
  return result;
}

/**
 * Companion seats in a selection whose wheelchair space is not part of the same selection
 * (only checked when the event requires companion seats to be booked with their partner).
 *  - `unpaired`: not allowed,
 *  - `ownerCheck`: allowed because the wheelchair space is already SOLD – but only if it was
 *    sold to the same customer; verified at checkout by comparing the e-mail address.
 */
export function checkCompanionSeats(
  selected: ReadonlySet<string>,
  seats: readonly { i: string; w?: string[] }[],
  soldSeatIds: ReadonlySet<string> = new Set(),
): { unpaired: string[]; ownerCheck: string[] } {
  const unpaired: string[] = [];
  const ownerCheck: string[] = [];
  for (const s of seats) {
    if (!selected.has(s.i) || !s.w || s.w.length === 0) continue;
    if (s.w.some((w) => selected.has(w))) continue;
    if (s.w.some((w) => soldSeatIds.has(w))) ownerCheck.push(s.i);
    else unpaired.push(s.i);
  }
  return { unpaired, ownerCheck };
}

// ─── Best available (Bestplatzbuchung) ──────────────────────────────────────

export interface BestAvailableSeat {
  id: string;
  sectionId: string;
  rowId: string | null;
  position: number | null;
  categoryId: string | null;
  rank: number | null;
  flags: number;
  /** Plan coordinates – used to keep blocks in consecutive rows aligned. */
  x?: number;
  y?: number;
}

export interface BestAvailableInput {
  seats: BestAvailableSeat[];
  sections: { id: string; priority: number; enabled: boolean }[];
  rows: { id: string; sortOrder: number }[];
  /** Seats that cannot be offered (sold, reserved, locked by anyone, blocked). */
  unavailable: ReadonlySet<string>;
  categoryId: string;
  quantity: number;
  /** Number of ranked alternatives to return (used for retry on lock races). */
  maxCandidates?: number;
}

/**
 * How the seats of a candidate relate to each other:
 *  - ROW: all seats side by side in one row (always preferred),
 *  - ROWS: side-by-side blocks in directly consecutive rows of one block (one behind the other),
 *  - SCATTERED: best remaining seats, grouped as far as possible.
 */
export type BestAvailableArrangement = 'ROW' | 'ROWS' | 'SCATTERED';

export interface BestAvailableCandidate {
  ids: string[];
  arrangement: BestAvailableArrangement;
}

const EXCLUDED_FLAGS = SEAT_FLAG.WHEELCHAIR | SEAT_FLAG.COMPANION | SEAT_FLAG.BLOCKED;
const ORPHAN_PENALTY = 1e8;
/** Most rows a ROWS group may span. */
const MAX_GROUP_ROWS = 5;
/** Score per additional row of a ROWS group (fewer rows = more together). */
const ROW_SPLIT_PENALTY = 5_000;
/** Score per plan unit of horizontal offset between the blocks of a ROWS group. */
const ALIGN_WEIGHT = 20;

interface Block {
  ids: string[];
  rowId: string;
  sectionId: string;
  size: number;
  /** Σ seat rank + orphan penalty. */
  score: number;
  /** Mean x of the block (alignment between rows). */
  cx: number;
  cy: number;
}

interface RowInfo {
  id: string;
  sectionId: string;
  sortOrder: number;
  /** Eligible blocks by size. */
  blocks: Map<number, Block[]>;
  longest: number;
}

/**
 * Finds the best seats of one category, best first. Seats side by side in one row always
 * win; otherwise blocks in consecutive rows (one behind the other); otherwise the best
 * remaining seats. Score = section priority, then Σ seat rank (explicit `rank` or row order
 * + distance to the row centre), heavily penalising blocks that would strand a single seat.
 * Wheelchair spaces and companion seats are never auto-assigned.
 */
export function findBestAvailable(input: BestAvailableInput): BestAvailableCandidate[] {
  const { quantity } = input;
  if (!Number.isInteger(quantity) || quantity < 1) return [];
  const max = input.maxCandidates ?? 10;
  const sectionInfo = new Map(input.sections.map((s) => [s.id, s]));
  const rowInfos = buildRows(input, quantity);
  const priorityOf = (sectionId: string) => (sectionInfo.get(sectionId)?.priority ?? 0) * 1e10;

  // 1) side by side in one row
  const single: { ids: string[]; score: number }[] = [];
  for (const row of rowInfos) {
    for (const block of row.blocks.get(quantity) ?? []) {
      single.push({ ids: block.ids, score: priorityOf(row.sectionId) + block.score });
    }
  }
  if (single.length > 0) {
    return single
      .sort((a, b) => a.score - b.score)
      .slice(0, max)
      .map((c) => ({ ids: c.ids, arrangement: 'ROW' as const }));
  }

  // 2) blocks in directly consecutive rows of one section
  const groups = findRowGroups(rowInfos, quantity, priorityOf);
  if (groups.length > 0) {
    return groups
      .sort((a, b) => a.score - b.score)
      .slice(0, max)
      .map((c) => ({ ids: c.ids, arrangement: 'ROWS' as const }));
  }

  // 3) best remaining seats, grouped as far as possible
  const scattered = findScattered(input, quantity, priorityOf);
  return scattered ? [{ ids: scattered, arrangement: 'SCATTERED' }] : [];
}

/** Rows of enabled sections with all eligible blocks up to `quantity` seats. */
function buildRows(input: BestAvailableInput, quantity: number): RowInfo[] {
  const sectionInfo = new Map(input.sections.map((s) => [s.id, s]));
  const rowOrder = new Map(input.rows.map((r) => [r.id, r.sortOrder]));
  const byRow = new Map<string, BestAvailableSeat[]>();
  for (const seat of input.seats) {
    if (!seat.rowId || seat.position === null) continue;
    const list = byRow.get(seat.rowId);
    if (list) list.push(seat);
    else byRow.set(seat.rowId, [seat]);
  }

  const result: RowInfo[] = [];
  for (const [rowId, rowSeats] of byRow) {
    rowSeats.sort((a, b) => a.position! - b.position!);
    const sectionId = rowSeats[0]!.sectionId;
    const section = sectionInfo.get(sectionId);
    if (!section || !section.enabled) continue;
    const positions = rowSeats.map((s) => s.position!);
    const centre = (Math.min(...positions) + Math.max(...positions)) / 2;
    const rowSort = rowOrder.get(rowId) ?? 0;
    const rankOf = (s: BestAvailableSeat) =>
      s.rank ?? rowSort * 1000 + Math.abs(s.position! - centre) * 10;
    const eligible = (s: BestAvailableSeat) =>
      s.categoryId === input.categoryId &&
      (s.flags & EXCLUDED_FLAGS) === 0 &&
      !input.unavailable.has(s.id);

    const info: RowInfo = {
      id: rowId,
      sectionId,
      sortOrder: rowSort,
      blocks: new Map(),
      longest: 0,
    };
    // Runs of physically adjacent, non-taken seats (for orphan evaluation).
    let i = 0;
    while (i < rowSeats.length) {
      let j = i;
      while (
        j + 1 < rowSeats.length &&
        rowSeats[j + 1]!.position === rowSeats[j]!.position! + 1 &&
        !input.unavailable.has(rowSeats[j + 1]!.id)
      ) {
        j += 1;
      }
      const run = rowSeats.slice(i, j + 1).filter((s) => !input.unavailable.has(s.id));
      for (let size = 1; size <= Math.min(quantity, run.length); size += 1) {
        for (let start = 0; start + size <= run.length; start += 1) {
          const window = run.slice(start, start + size);
          if (!window.every(eligible)) continue;
          const leftGap = start;
          const rightGap = run.length - start - size;
          const orphanCount = (leftGap === 1 ? 1 : 0) + (rightGap === 1 ? 1 : 0);
          const unavoidable = run.length - size === 1;
          const block: Block = {
            ids: window.map((s) => s.id),
            rowId,
            sectionId,
            size,
            score:
              window.reduce((sum, s) => sum + rankOf(s), 0) +
              (unavoidable ? 0 : orphanCount * ORPHAN_PENALTY),
            cx: window.reduce((sum, s) => sum + (s.x ?? s.position!), 0) / size,
            cy: window.reduce((sum, s) => sum + (s.y ?? rowSort), 0) / size,
          };
          const list = info.blocks.get(size);
          if (list) list.push(block);
          else info.blocks.set(size, [block]);
          info.longest = Math.max(info.longest, size);
        }
      }
      i = j + 1;
    }
    // Rows without free seats stay in the list: they interrupt "consecutive rows".
    result.push(info);
  }
  return result;
}

/**
 * Groups of side-by-side blocks in directly consecutive rows (front to back) of one
 * section, aligned under each other – e.g. 3 + 2 seats for 5 tickets.
 */
function findRowGroups(
  rows: RowInfo[],
  quantity: number,
  priorityOf: (sectionId: string) => number,
): { ids: string[]; score: number }[] {
  if (quantity < 2) return [];
  const bySection = new Map<string, RowInfo[]>();
  for (const row of rows) {
    const list = bySection.get(row.sectionId);
    if (list) list.push(row);
    else bySection.set(row.sectionId, [row]);
  }
  const results: { ids: string[]; score: number }[] = [];
  const seen = new Set<string>();

  for (const [sectionId, sectionRows] of bySection) {
    sectionRows.sort((a, b) => a.sortOrder - b.sortOrder);
    const base = priorityOf(sectionId);
    const extend = (
      list: RowInfo[],
      index: number,
      remaining: number,
      chosen: Block[],
      score: number,
      anchor: Block,
    ): void => {
      if (remaining === 0) {
        const ids = chosen.flatMap((b) => b.ids);
        const key = [...ids].sort().join(',');
        if (seen.has(key)) return;
        seen.add(key);
        results.push({ ids, score: base + score + (chosen.length - 1) * ROW_SPLIT_PENALTY });
        return;
      }
      if (chosen.length >= MAX_GROUP_ROWS || index >= list.length) return;
      const row = list[index]!;
      const maxSize = Math.min(remaining, row.longest);
      // Largest block that fits, and one smaller (better balance / alignment).
      for (const size of [maxSize, maxSize - 1]) {
        if (size < 1) continue;
        const options = row.blocks.get(size);
        if (!options) continue;
        let best: Block | null = null;
        let bestCost = Infinity;
        for (const option of options) {
          const cost = option.score + Math.abs(option.cx - anchor.cx) * ALIGN_WEIGHT;
          if (cost < bestCost) [best, bestCost] = [option, cost];
        }
        if (best)
          extend(list, index + 1, remaining - size, [...chosen, best], score + bestCost, anchor);
      }
    };

    for (let start = 0; start < sectionRows.length; start += 1) {
      const first = sectionRows[start]!;
      // Largest few block sizes of the first row (keeps the search small).
      const firstSizes = [...first.blocks.keys()]
        .filter((s) => s < quantity)
        .sort((a, b) => b - a)
        .slice(0, 3);
      for (const size of firstSizes) {
        for (const block of first.blocks.get(size)!) {
          extend(sectionRows, start + 1, quantity - size, [block], block.score, block);
        }
      }
    }
  }
  return results;
}

/** Best remaining seats: repeatedly the largest available block, close to the first one. */
function findScattered(
  input: BestAvailableInput,
  quantity: number,
  priorityOf: (sectionId: string) => number,
): string[] | null {
  const taken = new Set(input.unavailable);
  const chosen: string[] = [];
  let anchor: { cx: number; cy: number } | null = null;
  while (chosen.length < quantity) {
    const remaining = quantity - chosen.length;
    const rows = buildRows({ ...input, unavailable: taken }, remaining);
    let best: Block | null = null;
    let bestCost = Infinity;
    const longest = Math.max(0, ...rows.map((r) => r.longest));
    if (longest === 0) return null;
    for (const row of rows) {
      for (const block of row.blocks.get(Math.min(longest, remaining)) ?? []) {
        const distance: number = anchor
          ? Math.hypot(block.cx - anchor.cx, block.cy - anchor.cy)
          : 0;
        const cost: number = priorityOf(row.sectionId) + block.score + distance * ALIGN_WEIGHT;
        if (cost < bestCost) [best, bestCost] = [block, cost];
      }
    }
    if (!best) return null;
    for (const id of best.ids) {
      chosen.push(id);
      taken.add(id);
    }
    anchor ??= { cx: best.cx, cy: best.cy };
  }
  return chosen;
}

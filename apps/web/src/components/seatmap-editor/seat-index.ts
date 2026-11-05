import type { DocSeat, Point } from '@tix/shared';

/**
 * Uniform-grid spatial index over seat centres for O(1) hit testing and fast rubber-band
 * selection on plans with many thousands of seats.
 */
export class SeatIndex {
  private readonly cells = new Map<string, number[]>();

  constructor(
    private readonly seats: readonly DocSeat[],
    private readonly cellSize: number,
  ) {
    seats.forEach((seat, i) => {
      const key = this.key(Math.floor(seat.x / cellSize), Math.floor(seat.y / cellSize));
      const list = this.cells.get(key);
      if (list) list.push(i);
      else this.cells.set(key, [i]);
    });
  }

  private key(cx: number, cy: number): string {
    return `${cx}:${cy}`;
  }

  /** Nearest seat whose centre lies within `maxDistance` of the point. */
  nearest(p: Point, maxDistance: number): string | null {
    const span = Math.ceil(maxDistance / this.cellSize);
    const cx = Math.floor(p.x / this.cellSize);
    const cy = Math.floor(p.y / this.cellSize);
    let best: string | null = null;
    let bestDist = maxDistance;
    for (let x = cx - span; x <= cx + span; x += 1) {
      for (let y = cy - span; y <= cy + span; y += 1) {
        for (const i of this.cells.get(this.key(x, y)) ?? []) {
          const seat = this.seats[i]!;
          const d = Math.hypot(seat.x - p.x, seat.y - p.y);
          if (d <= bestDist) {
            bestDist = d;
            best = seat.id;
          }
        }
      }
    }
    return best;
  }

  /** Seats whose centre lies inside the axis-aligned rectangle. */
  inRect(minX: number, minY: number, maxX: number, maxY: number): string[] {
    const out: string[] = [];
    const x0 = Math.floor(minX / this.cellSize);
    const x1 = Math.floor(maxX / this.cellSize);
    const y0 = Math.floor(minY / this.cellSize);
    const y1 = Math.floor(maxY / this.cellSize);
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        for (const i of this.cells.get(this.key(x, y)) ?? []) {
          const s = this.seats[i]!;
          if (s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY) out.push(s.id);
        }
      }
    }
    return out;
  }
}

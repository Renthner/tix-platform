import { describe, expect, it } from 'vitest';
import { statisticsParallelLimit } from '../src/statistics/sales';

const dbWithPool = (max: number) => ({ $client: { options: { max } } });

describe('statistics parallelism follows the process pool', () => {
  it('is a quarter of the pool, at least 1, at most 4', () => {
    expect(statisticsParallelLimit(dbWithPool(2))).toBe(1);
    expect(statisticsParallelLimit(dbWithPool(4))).toBe(1);
    expect(statisticsParallelLimit(dbWithPool(8))).toBe(2);
    expect(statisticsParallelLimit(dbWithPool(20))).toBe(4);
    expect(statisticsParallelLimit(dbWithPool(200))).toBe(4);
  });

  it('falls back to a safe default without pool information', () => {
    expect(statisticsParallelLimit({})).toBe(4);
    expect(statisticsParallelLimit(null)).toBe(4);
  });
});

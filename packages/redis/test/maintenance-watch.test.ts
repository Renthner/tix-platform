import { describe, expect, it, vi } from 'vitest';
import { MaintenanceWatcher } from '../src/maintenance-watch';

describe('MaintenanceWatcher', () => {
  it('fires onStart / onEnd once per transition and ignores probe errors', async () => {
    let state: boolean | Error = false;
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const watcher = new MaintenanceWatcher({
      probe: async () => {
        if (state instanceof Error) throw state;
        return state;
      },
      onStart,
      onEnd,
    });
    await watcher.tick();
    expect(onStart).not.toHaveBeenCalled();

    state = true;
    await watcher.tick();
    await watcher.tick();
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(watcher.isActive).toBe(true);

    state = new Error('redis down');
    await watcher.tick();
    expect(watcher.isActive).toBe(true);
    expect(onEnd).not.toHaveBeenCalled();

    state = false;
    await watcher.tick();
    await watcher.tick();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(watcher.isActive).toBe(false);
  });

  it('can start in maintenance (no onStart for the initial state)', async () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const watcher = new MaintenanceWatcher({
      probe: async () => false,
      onStart,
      onEnd,
      active: true,
    });
    await watcher.tick();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('polls on its timer', async () => {
    vi.useFakeTimers();
    try {
      const onStart = vi.fn();
      const watcher = new MaintenanceWatcher({
        probe: async () => true,
        onStart,
        intervalMs: 100,
      });
      watcher.start();
      await vi.advanceTimersByTimeAsync(250);
      watcher.stop();
      expect(onStart).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

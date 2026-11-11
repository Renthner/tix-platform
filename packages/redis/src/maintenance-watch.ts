/**
 * Edge detector for maintenance mode (backup restore) used by the realtime gateway: polls a probe
 * and calls `onStart` when maintenance begins (clients are told and disconnected) and `onEnd`
 * when it is over. Probe errors never flip the state (Redis hiccups must not kick everybody).
 */
export interface MaintenanceWatcherOptions {
  probe: () => Promise<boolean>;
  onStart: () => void | Promise<void>;
  onEnd?: () => void | Promise<void>;
  intervalMs?: number;
  /** Initial state; defaults to "not in maintenance". */
  active?: boolean;
}

export class MaintenanceWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private active: boolean;

  constructor(private readonly options: MaintenanceWatcherOptions) {
    this.active = options.active ?? false;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** One probe + transition handling (exposed for tests; also called by the timer). */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let next: boolean;
      try {
        next = await this.options.probe();
      } catch {
        return;
      }
      if (next === this.active) return;
      this.active = next;
      if (next) await this.options.onStart();
      else await this.options.onEnd?.();
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 2_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// Child process management: spawn, prefixed log forwarding, restart with exponential backoff.
import { spawn } from 'node:child_process';

/** One JSON log line of the supervisor itself (same shape as the app's pino lines). */
export function logLine(level, msg, extra = {}) {
  const levels = { debug: 20, info: 30, warn: 40, error: 50 };
  return JSON.stringify({
    level: levels[level] ?? 30,
    time: Date.now(),
    service: 'supervisor',
    msg,
    ...extra,
  });
}

export function createLogger(write = (line) => process.stdout.write(line + '\n')) {
  const make = (level) => (msg, extra) => write(logLine(level, msg, extra));
  return { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') };
}

/** pino JSON lines pass through untouched; anything else gets a `[name] ` prefix. */
export function formatChildLine(name, line) {
  if (line.startsWith('{') && line.endsWith('}')) return line;
  return line.startsWith(`[${name}]`) ? line : `[${name}] ${line}`;
}

/** Splits a stream into lines (handles chunk boundaries) and calls `onLine` for each. */
export function lineSplitter(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line) onLine(line);
      }
      if (buffer.length > 1_000_000) {
        onLine(buffer);
        buffer = '';
      }
    },
    flush() {
      if (buffer) onLine(buffer);
      buffer = '';
    },
  };
}

export function backoffDelay(failures, baseMs = 1_000, maxMs = 30_000) {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1));
}

function pipeLines(stream, name, sink) {
  stream.setEncoding('utf8');
  const splitter = lineSplitter((line) => sink(formatChildLine(name, line)));
  stream.on('data', (chunk) => splitter.push(chunk));
  stream.on('end', () => splitter.flush());
}

/**
 * Path of the hung-process watchdog probe per role. The web app answers `?probe=live` without
 * touching PostgreSQL / Redis, so a database outage cannot make the probe slow or flaky.
 */
export function watchdogProbePath(role) {
  return role === 'web' ? '/api/health?probe=live' : '/healthz';
}

/**
 * Resolves `fn()` at most once per `ttlMs` (concurrent callers share one in-flight call).
 * Used for the aggregated health check, which any client may poll.
 */
export function cachedAsync(fn, ttlMs, now = Date.now) {
  let value;
  let at = -Infinity;
  let pending = null;
  return () => {
    if (now() - at < ttlMs) return Promise.resolve(value);
    pending ??= fn()
      .then((v) => {
        value = v;
        at = now();
        return v;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

/**
 * SIGTERM a one-shot child and wait for its `close` (`run` is the promise runOnce returned);
 * SIGKILL when it is still there after `timeoutMs`. Resolves with { forced }.
 */
export async function stopRun(child, run, timeoutMs, onForce = () => {}) {
  child.kill('SIGTERM');
  let timer;
  const timedOut = await Promise.race([
    run.then(() => false),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (timedOut) {
    onForce();
    child.kill('SIGKILL');
    await run;
  }
  return { forced: timedOut };
}

/** Runs a command to completion with forwarded output. Resolves with the exit code. */
export function runOnce(name, args, { env, cwd, out, err, onSpawn }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    onSpawn?.(child);
    pipeLines(child.stdout, name, out);
    pipeLines(child.stderr, name, err);
    child.on('error', () => resolve(127));
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

export class ManagedChild {
  /**
   * @param {object} o
   * @param {string} o.name
   * @param {string[]} o.args  arguments for node
   * @param {object} o.env
   * @param {string} o.cwd
   * @param {(line: string) => void} o.out
   * @param {(line: string) => void} o.err
   * @param {object} o.log  logger from createLogger
   * @param {number} [o.baseDelayMs]
   * @param {number} [o.stableMs]  uptime after which the failure counter resets
   * @param {() => void} [o.onExit]  called whenever the process is gone (also when stopping)
   * @param {() => Promise<boolean>} [o.probe]  liveness probe (true = the process answers). Only
   *   "no answer at all" may count as failure: a process that answers with an error status (for
   *   example because PostgreSQL is down) is alive and must not be killed. The probe should hit a
   *   pure in-process endpoint (see watchdogProbePath), not one that pings the database / Redis.
   * @param {number} [o.watchdogIntervalMs]  time between probes (default 10 s)
   * @param {number} [o.watchdogGraceMs]  no probing this long after a start (default 120 s)
   * @param {number} [o.watchdogMaxFailures]  consecutive failed probes before SIGKILL (default 6)
   */
  constructor(o) {
    this.o = { baseDelayMs: 1_000, stableMs: 60_000, ...o };
    this.name = o.name;
    this.proc = null;
    this.failures = 0;
    this.restarts = 0;
    this.stopping = false;
    this.timer = null;
    this.exited = Promise.resolve();
    this.watchdog = null;
    this.hungKills = 0;
  }

  get running() {
    return this.proc !== null;
  }

  start() {
    if (this.stopping || this.proc) return;
    const { name, args, env, cwd, out, err, log } = this.o;
    const startedAt = Date.now();
    const proc = spawn(process.execPath, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    this.exited = new Promise((resolve) => {
      let done = false;
      const finish = (code, signal) => {
        if (done) return;
        done = true;
        this.proc = null;
        this.stopWatchdog();
        resolve();
        try {
          this.o.onExit?.();
        } catch {
          // a failing observer must not break the restart logic
        }
        if (this.stopping) return;
        if (Date.now() - startedAt >= this.o.stableMs) this.failures = 0;
        this.failures += 1;
        const delay = backoffDelay(this.failures, this.o.baseDelayMs);
        log.error(`${name} exited, restarting`, {
          code,
          signal,
          restartInMs: delay,
          failures: this.failures,
        });
        this.timer = setTimeout(() => {
          this.timer = null;
          this.restarts += 1;
          this.start();
        }, delay);
      };
      proc.on('error', (error) => {
        log.error(`${name} could not be started`, { error: error.message });
        finish(null, null);
      });
      proc.on('close', finish);
    });
    pipeLines(proc.stdout, name, out);
    pipeLines(proc.stderr, name, err);
    this.startWatchdog(proc, startedAt);
    log.info(`${name} started`, { pid: proc.pid });
  }

  stopWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /**
   * A child that is alive but no longer answers (event loop stuck) would never exit and so never
   * be restarted. After `watchdogMaxFailures` consecutive probes without any answer it gets SIGKILL;
   * the normal exit handling then restarts it with backoff.
   */
  startWatchdog(proc, startedAt) {
    const { probe, name, log } = this.o;
    if (!probe) return;
    const interval = this.o.watchdogIntervalMs ?? 10_000;
    const grace = this.o.watchdogGraceMs ?? 120_000;
    const maxFailures = this.o.watchdogMaxFailures ?? 6;
    let failures = 0;
    let probing = false;
    this.watchdog = setInterval(async () => {
      if (probing || this.stopping || this.proc !== proc || Date.now() - startedAt < grace) return;
      probing = true;
      let alive = true;
      try {
        alive = await probe();
      } catch {
        alive = true; // a broken probe must never kill a healthy child
      }
      probing = false;
      if (this.proc !== proc || this.stopping) return;
      if (alive) {
        failures = 0;
        return;
      }
      failures += 1;
      if (failures < maxFailures) return;
      this.hungKills += 1;
      log.error(`${name} does not answer any more, killing it`, { consecutiveFailures: failures });
      this.stopWatchdog();
      proc.kill('SIGKILL');
    }, interval);
    this.watchdog.unref();
  }

  /** SIGTERM now, SIGKILL after `timeoutMs`. Resolves when the process is gone. */
  async stop(timeoutMs) {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.stopWatchdog();
    const proc = this.proc;
    if (!proc) return;
    proc.kill('SIGTERM');
    const kill = setTimeout(() => {
      this.o.log.warn(`${this.name} did not stop in time, killing`, { timeoutMs });
      proc.kill('SIGKILL');
    }, timeoutMs);
    await this.exited;
    clearTimeout(kill);
  }
}

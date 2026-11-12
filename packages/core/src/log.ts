/**
 * Process-wide logger for core code. Web and worker install their pino logger through
 * `createCoreContext({ logger })`; until then (tests, CLI) output goes to the console.
 */
export interface CoreLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
}

const consoleLogger: CoreLogger = {
  info: (obj, msg) => console.info(msg ?? '', obj),
  warn: (obj, msg) => console.warn(msg ?? '', obj),
  error: (obj, msg) => console.error(msg ?? '', obj),
  debug: (obj, msg) => console.debug(msg ?? '', obj),
};

let current: CoreLogger = consoleLogger;

export function setCoreLogger(logger: CoreLogger | undefined): void {
  current = logger ?? consoleLogger;
}

/** Delegating handle: safe to import at module level before the logger is installed. */
export const coreLog: CoreLogger = {
  info: (obj, msg) => current.info(obj, msg),
  warn: (obj, msg) => current.warn(obj, msg),
  error: (obj, msg) => current.error(obj, msg),
  debug: (obj, msg) => current.debug(obj, msg),
};

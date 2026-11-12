import 'server-only';
import { pino, type Logger } from 'pino';
import { getEnv } from './env';

const globalForLogger = globalThis as typeof globalThis & { __tixLogger?: Logger };

function create(): Logger {
  return pino({
    level: getEnv().LOG_LEVEL,
    base: { service: 'web' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        '*.password',
        '*.pin',
        '*.secret',
        '*.token',
        '*.authorization',
        '*.cookie',
        '*.set-cookie',
        '*.iban',
      ],
      censor: '[redacted]',
    },
  });
}

/** Process-wide structured JSON logger (survives dev hot reloads). */
export const logger: Logger = new Proxy({} as Logger, {
  get(_t, prop) {
    globalForLogger.__tixLogger ??= create();
    const target = globalForLogger.__tixLogger;
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

/** Child logger carrying the proxy-assigned request id (`X-Request-Id`), if any. */
export function requestLogger(req: Request): Logger {
  const reqId = req.headers.get('x-request-id');
  return reqId ? logger.child({ reqId }) : logger;
}

import { pino, type Logger } from 'pino';

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'worker' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['*.password', '*.pin', '*.secret', '*.token', '*.authorization'],
      censor: '[redacted]',
    },
  });
}

export type { Logger };

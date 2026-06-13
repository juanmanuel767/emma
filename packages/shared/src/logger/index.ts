import pino from 'pino';

export type Logger = pino.Logger;

export function createLogger(name: string, level?: string): Logger {
  const isDev = process.env['NODE_ENV'] !== 'production';
  const logLevel = level ?? process.env['LOG_LEVEL'] ?? 'info';

  if (isDev) {
    return pino({
      name,
      level: logLevel,
      transport: { target: 'pino-pretty', options: { colorize: true } },
    });
  }

  return pino({ name, level: logLevel });
}

export const rootLogger = createLogger('emma');

import { ConsoleLogger, LoggerService } from '@nestjs/common';

/**
 * One JSON object per line — the format every log shipper (Logtail,
 * Datadog, Loki, Elastic, Papertrail) parses natively. Drop in with
 *   `app.useLogger(new JsonLogger())`
 * when LOG_FORMAT=json. For local dev, keep the default ConsoleLogger:
 * colorized output is easier to scan by eye.
 */
export class JsonLogger implements LoggerService {
  private emit(level: string, context: unknown, message: unknown, extra?: Record<string, unknown>) {
    const ts = new Date().toISOString();
    // `message` might be a plain string or a richer object (Nest sometimes
    // passes objects). Normalize to a string field for searchability, but
    // keep the raw under `data` when it was structured.
    const msg = typeof message === 'string' ? message : undefined;
    const data = typeof message === 'string' ? undefined : message;
    const line = {
      ts,
      level,
      context: typeof context === 'string' ? context : undefined,
      msg,
      data,
      ...extra,
    };
    // Never use console.log for errors — stderr is conventional for them.
    const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    out.write(JSON.stringify(line) + '\n');
  }

  log(message: unknown, context?: string) {
    this.emit('info', context, message);
  }
  error(message: unknown, trace?: string, context?: string) {
    this.emit('error', context, message, trace ? { trace } : undefined);
  }
  warn(message: unknown, context?: string) {
    this.emit('warn', context, message);
  }
  debug(message: unknown, context?: string) {
    this.emit('debug', context, message);
  }
  verbose(message: unknown, context?: string) {
    this.emit('verbose', context, message);
  }
}

/** Factory: picks the right logger based on LOG_FORMAT. Keeps main.ts tidy. */
export function makeLogger(format: 'pretty' | 'json'): LoggerService {
  return format === 'json' ? new JsonLogger() : new ConsoleLogger();
}

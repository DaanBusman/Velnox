import { Injectable, type LoggerService, type LogLevel } from '@nestjs/common';
import pino, { type Logger } from 'pino';
import { rootRedactor, type Redactor } from '@velnox/shared';
import { currentRequestId } from './request-context';

/**
 * Structured logging with mandatory redaction.
 *
 * Every log line goes through the shared redactor before it reaches a transport
 * (docs/risks.md R-02). Redaction is applied here, at the sink, rather than at
 * each call site, because the lines most likely to leak a secret are the ones we
 * did not write — a library's error message, a connection string in a stack
 * trace.
 */

export interface LoggerOptions {
  level: string;
  pretty: boolean;
  redactor?: Redactor;
  base?: Record<string, unknown>;
}

export function createRootLogger(options: LoggerOptions): Logger {
  return pino({
    level: options.level,
    base: { ...options.base },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    // Key-based redaction as a first pass. The redactor's value-based pass runs
    // in NestPinoLogger below and catches what key matching cannot.
    redact: {
      paths: [
        'password',
        '*.password',
        'secret',
        '*.secret',
        'token',
        '*.token',
        'authorization',
        '*.authorization',
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
      ],
      censor: '[redacted]',
    },
    ...(options.pretty
      ? {
          transport: {
            target: 'pino/file',
            options: { destination: 1 },
          },
        }
      : {}),
  });
}

@Injectable()
export class NestPinoLogger implements LoggerService {
  constructor(
    private readonly logger: Logger,
    private readonly redactor: Redactor = rootRedactor,
  ) {}

  private write(level: LogLevel, message: unknown, ...optional: unknown[]): void {
    const context = typeof optional.at(-1) === 'string' ? (optional.at(-1) as string) : undefined;
    const rest = context ? optional.slice(0, -1) : optional;

    const payload: Record<string, unknown> = {};
    const requestId = currentRequestId();
    if (requestId) payload.requestId = requestId;
    if (context) payload.context = context;
    if (rest.length > 0) payload.detail = this.redactor.value(rest.length === 1 ? rest[0] : rest);

    const text =
      typeof message === 'string'
        ? this.redactor.text(message)
        : this.redactor.text(JSON.stringify(this.redactor.value(message)));

    switch (level) {
      case 'error':
        this.logger.error(payload, text);
        break;
      case 'warn':
        this.logger.warn(payload, text);
        break;
      case 'debug':
        this.logger.debug(payload, text);
        break;
      case 'verbose':
        this.logger.trace(payload, text);
        break;
      case 'fatal':
        this.logger.fatal(payload, text);
        break;
      default:
        this.logger.info(payload, text);
    }
  }

  log(message: unknown, ...optional: unknown[]): void {
    this.write('log', message, ...optional);
  }
  error(message: unknown, ...optional: unknown[]): void {
    this.write('error', message, ...optional);
  }
  warn(message: unknown, ...optional: unknown[]): void {
    this.write('warn', message, ...optional);
  }
  debug(message: unknown, ...optional: unknown[]): void {
    this.write('debug', message, ...optional);
  }
  verbose(message: unknown, ...optional: unknown[]): void {
    this.write('verbose', message, ...optional);
  }
  fatal(message: unknown, ...optional: unknown[]): void {
    this.write('fatal', message, ...optional);
  }
}

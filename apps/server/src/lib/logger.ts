import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

import { AppError } from './errors.js';
import { safeErrorText } from './safe-error.js';

/**
 * Field names whose values never reach a log line, at any level and nesting depth up to 4
 * (absolute rule 4, ADR 0010). Request and response logging is minimal on top of this: the request
 * serializer keeps method and path only, and request/response bodies and headers are never logged.
 */
export const REDACTED_FIELDS = [
  // credentials
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-csrf-token',
  'password',
  'newPassword',
  'apiKey',
  'secret',
  'token',
  // buyer content (request)
  'messages',
  'prompt',
  'input',
  // buyer content (response)
  'choices',
  'output',
  'text',
] as const;

const segment = (field: string): string =>
  /^[A-Za-z_$][\w$]*$/.test(field) ? `.${field}` : `["${field}"]`;

/** pino redact paths: each field at depth 0..3 (`a`, `*.a`, `*.*.a`, `*.*.*.a`). */
export function redactPaths(fields: readonly string[] = REDACTED_FIELDS): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const seg = segment(f);
    out.push(seg.startsWith('.') ? seg.slice(1) : seg);
    out.push(`*${seg}`, `*.*${seg}`, `*.*.*${seg}`);
  }
  return out;
}

export const REDACTED = '[REDACTED]';

/**
 * Error serializer: name, code and a log-safe message. Messages that may quote input are replaced
 * (V8's JSON.parse errors include part of the body; Drizzle errors include query parameters).
 */
export function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: 'non-error thrown' };
  const out: Record<string, unknown> = { type: err.name };
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') out['code'] = code;
  const status = (err as { statusCode?: unknown }).statusCode;
  if (typeof status === 'number') out['statusCode'] = status;
  if (err instanceof AppError) {
    out['message'] = err.publicMessage;
  } else if (err instanceof SyntaxError || (typeof status === 'number' && status < 500)) {
    out['message'] = 'client error (message withheld)';
  } else {
    out['message'] = safeErrorText(err);
    // Stack frames without the first line (which repeats the message).
    if (typeof err.stack === 'string') out['stack'] = err.stack.split('\n').slice(1, 8).join('\n');
  }
  return out;
}

export interface LoggerConfig {
  readonly level: string;
  /** Where lines go (default stdout). Tests pass a capturing stream. */
  readonly destination?: DestinationStream;
}

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: { paths: redactPaths(), censor: REDACTED },
    serializers: { err: serializeError, error: serializeError },
    // No pid/hostname on every line.
    base: null,
  };
}

export function createLogger(config: LoggerConfig): Logger {
  return config.destination === undefined
    ? pino(loggerOptions(config.level))
    : pino(loggerOptions(config.level), config.destination);
}

export type { Logger };

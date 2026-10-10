/**
 * Typed application errors. Every error response has the shape
 * `{ "error": { "code", "message", "requestId", "details"? } }` (buyer API routes add the OpenAI `type`).
 * `publicMessage` and `details` are shown to the client: never put buyer content, secrets or internal
 * state in them. Unexpected errors become 500 `internal_error` without their message.
 */

const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

export type ErrorDetails = Readonly<Record<string, string | number | boolean | readonly string[]>>;

export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    readonly publicMessage: string,
    readonly details?: ErrorDetails,
    /** Extra response headers (e.g. Retry-After). */
    readonly headers?: Readonly<Record<string, string>>,
  ) {
    super(publicMessage);
    if (!CODE_RE.test(code)) throw new Error(`AppError: malformed code ${code}`);
    if (!Number.isInteger(httpStatus) || httpStatus < 400 || httpStatus > 599) {
      throw new Error(`AppError: status must be 4xx or 5xx, got ${String(httpStatus)}`);
    }
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: ErrorDetails): AppError =>
  new AppError(code, 400, message, details);

export const unauthenticated = (message = 'Login required.'): AppError =>
  new AppError('unauthenticated', 401, message);

export const forbidden = (message = 'You do not have permission for this action.'): AppError =>
  new AppError('forbidden', 403, message);

/** Also used for resources that exist but belong to someone else (do not reveal existence). */
export const notFound = (message = 'Not found.'): AppError =>
  new AppError('not_found', 404, message);

export const conflict = (code: string, message: string): AppError =>
  new AppError(code, 409, message);

export const tooManyRequests = (code: string, message: string, retryAfterMs: number): AppError =>
  new AppError(code, 429, message, undefined, {
    'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
  });

export const internalError = (): AppError => new AppError('internal_error', 500, 'Internal error.');

/** Paths of zod issues only (never the offending values, which may be buyer content or secrets). */
export function invalidRequest(
  issues: readonly { readonly path: readonly PropertyKey[] }[],
  where = 'body',
): AppError {
  const fields = [...new Set(issues.map((i) => i.path.map(String).join('.') || `(${where})`))];
  return badRequest('invalid_request', `Invalid request: ${fields.join(', ')}`, { fields });
}

/** OpenAI-compatible error `type` for the buyer API (`/v1/*`), derived from the HTTP status. */
export function openAiErrorType(status: number): string {
  if (status === 401) return 'authentication_error';
  if (status === 402) return 'insufficient_quota';
  if (status === 403) return 'permission_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'server_error';
  return 'invalid_request_error';
}

/** Fastify's own client errors (body parsing, size, media type) mapped to stable codes. */
export function fromFrameworkError(err: unknown): AppError | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as { statusCode?: unknown }).statusCode;
  if (typeof status !== 'number' || status < 400 || status > 499) return undefined;
  // Never reuse err.message: JSON parse errors quote part of the body (buyer content).
  if (status === 413) return new AppError('payload_too_large', 413, 'Request body is too large.');
  if (status === 415)
    return new AppError('unsupported_media_type', 415, 'Unsupported content type.');
  if (status === 400) return badRequest('invalid_request', 'Malformed request body.');
  return new AppError('bad_request', status, 'Bad request.');
}

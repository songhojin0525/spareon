/**
 * Typed database errors. pg errors carry a SQLSTATE; drizzle wraps them in DrizzleQueryError whose
 * message contains the query parameters (which may be hashes, emails or ciphertext). DbError keeps only
 * the code, constraint and table so it is safe to log (ADR 0010).
 */

/** SQLSTATEs the server reacts to. BJxxx are raised by our invariant triggers (drizzle/0001_invariants.sql). */
export const SQLSTATE = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  notNullViolation: '23502',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
  lockNotAvailable: '55P03',
  insufficientPrivilege: '42501',
  ledgerUnbalanced: 'BJ001',
  appendOnly: 'BJ002',
  balanceDirectWrite: 'BJ003',
  postingOutsideTransaction: 'BJ004',
  moneyRecordGuard: 'BJ005',
} as const;

export type DbErrorCode =
  | 'unique_violation'
  | 'foreign_key_violation'
  | 'check_violation'
  | 'not_null_violation'
  | 'serialization_failure'
  | 'deadlock_detected'
  | 'lock_not_available'
  | 'insufficient_privilege'
  | 'ledger_unbalanced'
  | 'append_only'
  | 'balance_direct_write'
  | 'posting_outside_transaction'
  | 'money_record_guard'
  | 'other';

const CODE_BY_SQLSTATE: Readonly<Record<string, DbErrorCode>> = {
  [SQLSTATE.uniqueViolation]: 'unique_violation',
  [SQLSTATE.foreignKeyViolation]: 'foreign_key_violation',
  [SQLSTATE.checkViolation]: 'check_violation',
  [SQLSTATE.notNullViolation]: 'not_null_violation',
  [SQLSTATE.serializationFailure]: 'serialization_failure',
  [SQLSTATE.deadlockDetected]: 'deadlock_detected',
  [SQLSTATE.lockNotAvailable]: 'lock_not_available',
  [SQLSTATE.insufficientPrivilege]: 'insufficient_privilege',
  [SQLSTATE.ledgerUnbalanced]: 'ledger_unbalanced',
  [SQLSTATE.appendOnly]: 'append_only',
  [SQLSTATE.balanceDirectWrite]: 'balance_direct_write',
  [SQLSTATE.postingOutsideTransaction]: 'posting_outside_transaction',
  [SQLSTATE.moneyRecordGuard]: 'money_record_guard',
};

interface PgErrorFields {
  code?: unknown;
  constraint?: unknown;
  table?: unknown;
}

/** Walk the cause chain (drizzle wraps pg errors) and return the first error that has a SQLSTATE. */
function findPgError(err: unknown): PgErrorFields | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth++) {
    const fields = current as PgErrorFields & { cause?: unknown };
    if (typeof fields.code === 'string' && /^[0-9A-Z]{5}$/.test(fields.code)) return fields;
    current = fields.cause;
  }
  return undefined;
}

/** The SQLSTATE of a (possibly wrapped) database error, or undefined. */
export function sqlState(err: unknown): string | undefined {
  const code = findPgError(err)?.code;
  return typeof code === 'string' ? code : undefined;
}

export class DbError extends Error {
  constructor(
    readonly code: DbErrorCode,
    readonly sqlState: string | undefined,
    readonly constraint: string | undefined,
    readonly table: string | undefined,
    options?: { cause?: unknown },
  ) {
    const where = [table, constraint].filter((x) => x !== undefined).join('.');
    super(
      `database error ${code}${sqlState === undefined ? '' : ` (${sqlState})`}${where === '' ? '' : ` at ${where}`}`,
      options,
    );
    this.name = 'DbError';
  }
}

/**
 * Convert any error from a query into a DbError without query text or parameters.
 * The original error stays reachable as `cause` for local debugging; do not log `cause`.
 */
export function toDbError(err: unknown): DbError {
  if (err instanceof DbError) return err;
  const pgErr = findPgError(err);
  const state = typeof pgErr?.code === 'string' ? pgErr.code : undefined;
  const constraint = typeof pgErr?.constraint === 'string' ? pgErr.constraint : undefined;
  const table = typeof pgErr?.table === 'string' ? pgErr.table : undefined;
  const code = state === undefined ? 'other' : (CODE_BY_SQLSTATE[state] ?? 'other');
  return new DbError(code, state, constraint, table, { cause: err });
}

/** Serialization failures and deadlocks: the whole transaction can safely run again. */
export function isRetryableTransactionError(err: unknown): boolean {
  const state = sqlState(err);
  return state === SQLSTATE.serializationFailure || state === SQLSTATE.deadlockDetected;
}

import { describe, expect, it } from 'vitest';

import { DbError, isRetryableTransactionError, sqlState, toDbError } from './errors.js';

/** Shape of a node-postgres DatabaseError (the fields toDbError reads). */
function pgError(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code,
    ...extra,
  });
}

/** drizzle's DrizzleQueryError puts the query and its parameters in the message. */
function wrapped(cause: unknown): Error {
  return new Error('Failed query: insert into users values ($1)\nparams: secret@example.com', {
    cause,
  });
}

describe('toDbError', () => {
  it('maps SQLSTATEs (also through a wrapper) to typed codes', () => {
    const err = toDbError(
      wrapped(pgError('23505', { constraint: 'users_email_lower_key', table: 'users' })),
    );
    expect(err).toBeInstanceOf(DbError);
    expect(err.code).toBe('unique_violation');
    expect(err.sqlState).toBe('23505');
    expect(err.constraint).toBe('users_email_lower_key');
    expect(err.table).toBe('users');
  });

  it('maps the invariant trigger codes', () => {
    expect(toDbError(pgError('BJ001')).code).toBe('ledger_unbalanced');
    expect(toDbError(pgError('BJ002')).code).toBe('append_only');
    expect(toDbError(pgError('BJ003')).code).toBe('balance_direct_write');
    expect(toDbError(pgError('BJ004')).code).toBe('posting_outside_transaction');
    expect(toDbError(pgError('BJ005')).code).toBe('money_record_guard');
  });

  it('never copies the query text or parameters into its message', () => {
    const err = toDbError(wrapped(pgError('23514', { constraint: 'c', table: 't' })));
    expect(err.message).toBe('database error check_violation (23514) at t.c');
    expect(err.message).not.toContain('secret');
  });

  it('classifies unknown errors as other and keeps DbError as is', () => {
    const other = toDbError(new Error('socket hang up'));
    expect(other.code).toBe('other');
    expect(other.sqlState).toBeUndefined();
    expect(toDbError(other)).toBe(other);
    expect(toDbError(pgError('XX000')).code).toBe('other');
  });

  it('ignores error codes that are not SQLSTATEs (Node system errors)', () => {
    expect(sqlState(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(
      undefined,
    );
  });
});

describe('isRetryableTransactionError', () => {
  it('retries serialization failures and deadlocks only', () => {
    expect(isRetryableTransactionError(wrapped(pgError('40001')))).toBe(true);
    expect(isRetryableTransactionError(pgError('40P01'))).toBe(true);
    expect(isRetryableTransactionError(pgError('23505'))).toBe(false);
    expect(isRetryableTransactionError(pgError('55P03'))).toBe(false);
    expect(isRetryableTransactionError(new Error('x'))).toBe(false);
  });
});

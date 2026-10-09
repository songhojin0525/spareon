import { toDbError } from '../db/errors.js';

/**
 * A log-safe description of an error. Drizzle query errors carry the SQL parameters in their message
 * (hashes, ciphertext, buyer-supplied stop strings), so database errors are reduced to their SQLSTATE,
 * table and constraint (ADR 0010: no buyer content in logs).
 */
export function safeErrorText(err: unknown): string {
  const db = toDbError(err);
  if (db.sqlState !== undefined) return db.message;
  if (err instanceof Error) {
    return err.message.startsWith('Failed query') ? 'database query failed' : err.message;
  }
  return 'unknown error';
}

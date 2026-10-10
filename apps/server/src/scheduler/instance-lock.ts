import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';

import { safeErrorText } from '../lib/safe-error.js';

/**
 * pg_try_advisory_lock(key1, key2): key1 is the project's lock namespace (shared with the migration
 * runner, which uses key2 = 1), key2 = 2 is "the scheduler instance".
 */
const LOCK_KEY_1 = 0x62696e6a;
const LOCK_KEY_2 = 2;

export class InstanceLockError extends Error {
  readonly code = 'instance_lock_held';
  constructor() {
    super('another server process is already scheduling jobs on this database');
    this.name = 'InstanceLockError';
  }
}

export interface InstanceLock {
  release(): Promise<void>;
}

/**
 * Hold a session advisory lock for the life of the process: only one server may schedule jobs on a
 * database. In stage A (ADR 0002) the scheduler keeps waiting buyers in memory and, at start, cancels
 * every unfinished job as left over by a dead process; a second process on the same database (a stray
 * dev server, an overlapping deploy) would cancel the first one's live jobs. Throws InstanceLockError
 * when another process holds the lock; the caller refuses to start.
 * The lock lives on one pooled connection checked out until release(). If that connection dies the
 * lock is gone: this is logged as an error (an operator must restart the process).
 */
export async function acquireInstanceLock(
  pool: pg.Pool,
  log: FastifyBaseLogger,
): Promise<InstanceLock> {
  const client = await pool.connect();
  let lost = false;
  const onError = (err: Error): void => {
    lost = true;
    log.error({ err: safeErrorText(err) }, 'scheduler instance lock connection lost');
  };
  client.on('error', onError);
  let held: boolean;
  try {
    const res = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [
      LOCK_KEY_1,
      LOCK_KEY_2,
    ]);
    held = res.rows[0]?.ok === true;
  } catch (err) {
    client.off('error', onError);
    client.release(true);
    throw err;
  }
  if (!held) {
    client.off('error', onError);
    client.release();
    throw new InstanceLockError();
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        if (!lost)
          await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_KEY_1, LOCK_KEY_2]);
      } catch (err) {
        lost = true;
        log.warn({ err: safeErrorText(err) }, 'scheduler instance unlock failed');
      } finally {
        client.off('error', onError);
        // A connection that failed or may still hold the lock is destroyed, not returned to the pool.
        client.release(lost);
      }
    },
  };
}

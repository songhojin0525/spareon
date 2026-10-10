import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';

import { safeErrorText } from '../lib/safe-error.js';

/**
 * pg_try_advisory_lock(key1, key2): key1 is the project's lock namespace (shared with the migration
 * runner, which uses key2 = 1), key2 = 2 is "the scheduler instance".
 */
export const INSTANCE_LOCK_KEYS = [0x62696e6a, 2] as const;

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
 *
 * The lock lives on one pooled connection checked out until release(). It needs a session-level
 * connection (a direct connection or a session-mode pooler; a transaction-mode pooler cannot hold it).
 * If that connection dies the lock is gone and another process could take it: onLost is called once
 * (the caller stops scheduling — when unsure, stop) and an operator must restart the process.
 */
export async function acquireInstanceLock(
  pool: pg.Pool,
  log: FastifyBaseLogger,
  onLost: () => void,
): Promise<InstanceLock> {
  const client = await pool.connect();
  let released = false;
  let lost = false;
  const markLost = (err?: Error): void => {
    if (lost) return;
    lost = true;
    if (released) return;
    log.fatal(
      err === undefined ? {} : { err: safeErrorText(err) },
      'scheduler instance lock lost: scheduling stopped, restart the server',
    );
    onLost();
  };
  const onError = (err: Error): void => {
    markLost(err);
  };
  const onEnd = (): void => {
    markLost();
  };
  client.on('error', onError);
  client.on('end', onEnd);
  const detach = (): void => {
    client.off('error', onError);
    client.off('end', onEnd);
  };
  let held: boolean;
  try {
    const res = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [
      ...INSTANCE_LOCK_KEYS,
    ]);
    held = res.rows[0]?.ok === true;
  } catch (err) {
    detach();
    client.release(true);
    throw err;
  }
  if (!held) {
    detach();
    client.release();
    throw new InstanceLockError();
  }
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        if (!lost) await client.query('SELECT pg_advisory_unlock($1, $2)', [...INSTANCE_LOCK_KEYS]);
      } catch (err) {
        lost = true;
        log.warn({ err: safeErrorText(err) }, 'scheduler instance unlock failed');
      } finally {
        detach();
        // A connection that failed or may still hold the lock is destroyed, not returned to the pool.
        client.release(lost);
      }
    },
  };
}

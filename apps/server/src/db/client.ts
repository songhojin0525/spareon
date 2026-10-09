import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import pg from 'pg';

import { isRetryableTransactionError } from './errors.js';
import { retry, type RetryOptions } from './retry.js';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
/** The handle passed to a transaction callback (same query API as Db). */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbConfig {
  readonly url: string;
  /** Pool size (default 10). Managed Postgres free tiers allow few direct connections (S30). */
  readonly maxConnections?: number;
  readonly applicationName?: string;
  /** Server-side statement timeout in ms (default 30 s): a runaway query cannot hold locks forever. */
  readonly statementTimeoutMs?: number;
  /** Abort sessions idle inside a transaction for this long (default 60 s). */
  readonly idleInTransactionTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
  /**
   * Run every session as this role (`-c role=<role>` at connection start). The server passes
   * `binjari_app` so it keeps least privilege even when the URL names a more powerful login (S03).
   * Must be a plain lowercase identifier.
   */
  readonly role?: string;
  /**
   * Errors of idle pooled connections (e.g. the server restarted). Without a listener node-postgres
   * would crash the process. Receives the error only — never log query parameters.
   */
  readonly onIdleClientError?: (err: Error) => void;
}

export interface DbHandle {
  readonly db: Db;
  readonly pool: pg.Pool;
  /** Close every pooled connection. Safe to call twice. */
  close(): Promise<void>;
}

const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export function createDb(config: DbConfig): DbHandle {
  if (config.role !== undefined && !ROLE_RE.test(config.role)) {
    throw new Error('createDb: role must be a plain lowercase identifier');
  }
  const pool = new pg.Pool({
    ...(config.role === undefined ? {} : { options: `-c role=${config.role}` }),
    connectionString: config.url,
    max: config.maxConnections ?? 10,
    application_name: config.applicationName ?? 'binjari-server',
    statement_timeout: config.statementTimeoutMs ?? 30_000,
    idle_in_transaction_session_timeout: config.idleInTransactionTimeoutMs ?? 60_000,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? 10_000,
  });
  pool.on('error', (err) => {
    config.onIdleClientError?.(err);
  });
  const db = drizzle(pool, { schema });
  let closed = false;
  return {
    db,
    pool,
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}

export interface TransactionOptions extends PgTransactionConfig {
  /**
   * Retry the whole transaction on serialization failures and deadlocks (default: 5 attempts).
   * `false` disables retrying. The callback may run more than once: it must not have side effects
   * outside the database (send messages after commit, e.g. through the outbox).
   */
  readonly retry?: Omit<RetryOptions, 'shouldRetry'> | false;
}

/**
 * Run fn in a transaction (default isolation: read committed) and retry it when Postgres reports a
 * serialization failure or deadlock. Any other error rolls back and propagates unchanged.
 */
export async function withTransaction<T>(
  db: Db,
  fn: (tx: Tx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const { retry: retryOptions, ...config } = options;
  const run = (): Promise<T> => db.transaction(fn, config);
  if (retryOptions === false) return run();
  return retry(run, { ...retryOptions, shouldRetry: isRetryableTransactionError });
}

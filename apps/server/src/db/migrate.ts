import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { z } from 'zod';

/**
 * Migration runner (ADR 0018). drizzle-kit only generates SQL; this applies it.
 * - Order and tags come from drizzle/meta/_journal.json (what `drizzle-kit generate` maintains).
 * - Each migration runs in its own transaction and is recorded in spareon_meta.migrations with the
 *   SHA-256 of its file. A recorded migration whose file changed is refused (no silent drift).
 * - Down files live in drizzle/down/<tag>.sql and are applied in reverse order by rollback().
 * - A session advisory lock serializes concurrent runners (two server instances starting at once).
 */

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle/', import.meta.url));

/** pg_advisory_lock(key1, key2): 'binj' as an int32, then 1 for "migrations". */
const LOCK_KEY_1 = 0x62696e6a;
const LOCK_KEY_2 = 1;

export interface Migration {
  readonly idx: number;
  readonly tag: string;
  readonly up: string;
  /** null when the migration has no down file (it cannot be rolled back). */
  readonly down: string | null;
  readonly checksum: string;
}

export class MigrationError extends Error {
  readonly code = 'MIGRATION_FAILED';
  constructor(
    message: string,
    readonly tag?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

const journalSchema = z.object({
  dialect: z.literal('postgresql'),
  entries: z
    .array(
      z.object({
        idx: z.number().int().min(0),
        tag: z.string().regex(/^\d{4}_[a-z0-9_]+$/),
      }),
    )
    .min(1),
});

/** Line endings must not change the checksum (a Windows checkout with CRLF is the same migration). */
function normalize(sql: string): string {
  return sql.replace(/\r\n/g, '\n');
}

export function checksum(sql: string): string {
  return createHash('sha256').update(normalize(sql), 'utf8').digest('hex');
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<Migration[]> {
  const journal = journalSchema.parse(
    JSON.parse(await readFile(path.join(dir, 'meta', '_journal.json'), 'utf8')),
  );
  const migrations: Migration[] = [];
  journal.entries.forEach((e, i) => {
    if (e.idx !== i)
      throw new MigrationError(`journal entry ${String(i)} has idx ${String(e.idx)}`);
  });
  for (const e of journal.entries) {
    const up = await readFile(path.join(dir, `${e.tag}.sql`), 'utf8');
    if (up.trim() === '') throw new MigrationError(`migration ${e.tag} is empty`, e.tag);
    const down = await readOptional(path.join(dir, 'down', `${e.tag}.sql`));
    migrations.push({ idx: e.idx, tag: e.tag, up: normalize(up), down, checksum: checksum(up) });
  }
  return migrations;
}

export interface MigrationRunOptions {
  /** Connection URL (needs DDL rights: the migration owner, never the app role). */
  readonly url: string;
  readonly dir?: string;
  readonly log?: (message: string) => void;
  /** Wait at most this long for table locks inside a migration before failing (default 10 s). */
  readonly lockTimeoutMs?: number;
  /**
   * Wait at most this long for another runner to finish (default 120 s). A runner stuck while holding
   * the lock must not hang every deploy forever.
   */
  readonly runnerWaitMs?: number;
}

interface AppliedRow {
  idx: number;
  tag: string;
  checksum: string;
}

const RUNNER_POLL_MS = 250;

function positiveMs(value: number | undefined, fallback: number, name: string): number {
  const ms = value ?? fallback;
  if (!Number.isSafeInteger(ms) || ms < 1) {
    throw new MigrationError(`${name} must be a positive integer (got ${String(value)})`);
  }
  return ms;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Take the runner lock, polling with pg_try_advisory_lock so the wait is bounded. */
async function acquireRunnerLock(client: pg.Client, waitMs: number): Promise<void> {
  const tries = Math.max(1, Math.ceil(waitMs / RUNNER_POLL_MS));
  for (let i = 0; i < tries; i++) {
    const res = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [
      LOCK_KEY_1,
      LOCK_KEY_2,
    ]);
    if (res.rows[0]?.ok === true) return;
    await sleep(RUNNER_POLL_MS);
  }
  throw new MigrationError(
    `another migration runner held the lock for more than ${String(waitMs)} ms; giving up`,
  );
}

async function withMigrationLock<T>(
  options: MigrationRunOptions,
  fn: (client: pg.Client, applied: AppliedRow[], migrations: Migration[]) => Promise<T>,
): Promise<T> {
  const lockTimeoutMs = positiveMs(options.lockTimeoutMs, 10_000, 'lockTimeoutMs');
  const runnerWaitMs = positiveMs(options.runnerWaitMs, 120_000, 'runnerWaitMs');
  const migrations = await loadMigrations(options.dir);
  const client = new pg.Client({
    connectionString: options.url,
    application_name: 'spareon-migrate',
  });
  await client.connect();
  try {
    await acquireRunnerLock(client, runnerWaitMs);
    try {
      await client.query(`SET lock_timeout = ${String(lockTimeoutMs)}`);
      await client.query('CREATE SCHEMA IF NOT EXISTS spareon_meta');
      await client.query(`CREATE TABLE IF NOT EXISTS spareon_meta.migrations (
        idx integer PRIMARY KEY,
        tag text NOT NULL UNIQUE,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const res = await client.query<AppliedRow>(
        'SELECT idx, tag, checksum FROM spareon_meta.migrations ORDER BY idx',
      );
      verifyApplied(res.rows, migrations);
      return await fn(client, res.rows, migrations);
    } finally {
      // Never let an unlock failure (e.g. a dropped connection) hide the original error; the session
      // ends right after, which releases the lock anyway.
      await client
        .query('SELECT pg_advisory_unlock($1, $2)', [LOCK_KEY_1, LOCK_KEY_2])
        .catch(() => undefined);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Applied migrations must be a prefix of the journal with unchanged files. */
function verifyApplied(applied: readonly AppliedRow[], migrations: readonly Migration[]): void {
  applied.forEach((row, i) => {
    const m = migrations[i];
    if (row.idx !== i || m === undefined) {
      throw new MigrationError(
        `database has migration ${row.tag} (#${String(row.idx)}) that is not in the journal; refusing to continue`,
        row.tag,
      );
    }
    if (m.tag !== row.tag) {
      throw new MigrationError(
        `migration #${String(i)} is ${row.tag} in the database but ${m.tag} in the journal`,
        m.tag,
      );
    }
    if (m.checksum !== row.checksum) {
      throw new MigrationError(
        `migration ${m.tag} was modified after it was applied (checksum mismatch). Write a new migration instead.`,
        m.tag,
      );
    }
  });
}

async function inTransaction(
  client: pg.Client,
  tag: string,
  fn: () => Promise<void>,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await fn();
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const reason = err instanceof Error ? err.message : String(err);
    throw new MigrationError(`migration ${tag} failed: ${reason}`, tag, { cause: err });
  }
}

/** Apply every pending migration. Returns the tags applied (empty when up to date). */
export async function migrate(options: MigrationRunOptions): Promise<{ applied: string[] }> {
  return withMigrationLock(options, async (client, done, migrations) => {
    const applied: string[] = [];
    for (const m of migrations.slice(done.length)) {
      options.log?.(`applying ${m.tag}`);
      await inTransaction(client, m.tag, async () => {
        await client.query(m.up);
        await client.query(
          'INSERT INTO spareon_meta.migrations (idx, tag, checksum) VALUES ($1, $2, $3)',
          [m.idx, m.tag, m.checksum],
        );
      });
      applied.push(m.tag);
    }
    return { applied };
  });
}

export interface RollbackOptions extends MigrationRunOptions {
  /** How many of the most recent migrations to undo (default 1), or 'all'. */
  readonly steps?: number | 'all';
}

/** Undo the most recent migrations with their down files. Destructive: rolling back 0000 drops every table. */
export async function rollback(options: RollbackOptions): Promise<{ rolledBack: string[] }> {
  const steps = options.steps ?? 1;
  if (steps !== 'all' && (!Number.isInteger(steps) || steps < 1)) {
    throw new MigrationError(`steps must be a positive integer or 'all' (got ${String(steps)})`);
  }
  return withMigrationLock(options, async (client, done, migrations) => {
    const count = steps === 'all' ? done.length : Math.min(steps, done.length);
    const targets = migrations.slice(done.length - count, done.length).reverse();
    // Check every down file first: never stop half-way because a later file is missing.
    for (const m of targets) {
      if (m.down === null) {
        throw new MigrationError(
          `migration ${m.tag} has no down file (drizzle/down/${m.tag}.sql)`,
          m.tag,
        );
      }
    }
    const rolledBack: string[] = [];
    for (const m of targets) {
      options.log?.(`rolling back ${m.tag}`);
      await inTransaction(client, m.tag, async () => {
        await client.query(m.down ?? '');
        await client.query('DELETE FROM spareon_meta.migrations WHERE idx = $1', [m.idx]);
      });
      rolledBack.push(m.tag);
    }
    return { rolledBack };
  });
}

export interface MigrationStatus {
  readonly applied: string[];
  readonly pending: string[];
}

/** Read-only: needs no DDL rights and takes no lock (a runner may be applying migrations meanwhile). */
export async function migrationStatus(
  options: Pick<MigrationRunOptions, 'url' | 'dir'>,
): Promise<MigrationStatus> {
  const migrations = await loadMigrations(options.dir);
  const client = new pg.Client({
    connectionString: options.url,
    application_name: 'spareon-migrate-status',
  });
  await client.connect();
  try {
    const exists = await client.query<{ t: string | null }>(
      "SELECT to_regclass('spareon_meta.migrations')::text AS t",
    );
    const done =
      exists.rows[0]?.t == null
        ? []
        : (
            await client.query<AppliedRow>(
              'SELECT idx, tag, checksum FROM spareon_meta.migrations ORDER BY idx',
            )
          ).rows;
    verifyApplied(done, migrations);
    return {
      applied: done.map((r) => r.tag),
      pending: migrations.slice(done.length).map((m) => m.tag),
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

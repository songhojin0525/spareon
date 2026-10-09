import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTransaction } from '../../src/db/client.js';
import { DbError, sqlState, toDbError } from '../../src/db/errors.js';
import { openTestDb, type TestDb } from '../support/db.js';

/** Resolves once `parties` callers have arrived: forces two transactions to interleave. */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const all = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived++;
    if (arrived === parties) release();
    await all;
  };
}

const noWait = { sleep: () => Promise.resolve(), random: () => 0 };

describe('withTransaction (real Postgres)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await openTestDb({ empty: true });
    await db.withClient(async (c) => {
      await c.query('CREATE TABLE t (name text PRIMARY KEY, seen integer NOT NULL)');
      await c.query('CREATE TABLE acct (id integer PRIMARY KEY, v integer NOT NULL)');
    });
  });
  afterAll(async () => {
    await db.cleanup();
  });

  const count = async (): Promise<number> =>
    db.withClient(
      async (c) =>
        (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM t')).rows[0]?.n ?? -1,
    );

  it('commits on success and rolls back on error', async () => {
    await withTransaction(db.db, async (tx) => {
      await tx.execute(sql`INSERT INTO t VALUES ('commit', 0)`);
    });
    await expect(
      withTransaction(db.db, async (tx) => {
        await tx.execute(sql`INSERT INTO t VALUES ('rollback', 0)`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const names = await db.withClient(
      async (c) => (await c.query<{ name: string }>('SELECT name FROM t')).rows,
    );
    expect(names).toEqual([{ name: 'commit' }]);
    await db.withClient((c) => c.query('TRUNCATE t'));
  });

  it('retries a real serialization failure (40001) until both writers succeed', async () => {
    const meet = barrier(2);
    const attempts: string[] = [];
    const errors: string[] = [];
    const writer = (name: string): Promise<void> =>
      withTransaction(
        db.db,
        async (tx) => {
          attempts.push(name);
          const first = attempts.filter((a) => a === name).length === 1;
          const res = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM t`);
          // Both read before either writes: write skew that SERIALIZABLE must refuse.
          if (first) await meet();
          await tx.execute(sql`INSERT INTO t VALUES (${name}, ${res.rows[0]?.n ?? -1})`);
        },
        {
          isolationLevel: 'serializable',
          retry: {
            ...noWait,
            onRetry: ({ error }) => errors.push(sqlState(error) ?? 'none'),
          },
        },
      );
    await Promise.all([writer('a'), writer('b')]);
    expect(errors).toEqual(['40001']);
    expect(attempts).toHaveLength(3);
    // The retried writer saw the other's row: the outcome is serializable.
    const seen = await db.withClient(
      async (c) => (await c.query<{ seen: number }>('SELECT seen FROM t ORDER BY seen')).rows,
    );
    expect(seen).toEqual([{ seen: 0 }, { seen: 1 }]);
    await db.withClient((c) => c.query('TRUNCATE t'));
  });

  it('retries a real deadlock (40P01)', async () => {
    await db.withClient((c) => c.query('INSERT INTO acct VALUES (1, 0), (2, 0)'));
    const meet = barrier(2);
    const tries = new Map<string, number>();
    const errors: string[] = [];
    const mover = (name: string, first: number, second: number): Promise<void> =>
      withTransaction(
        db.db,
        async (tx) => {
          tries.set(name, (tries.get(name) ?? 0) + 1);
          // Detect quickly (the test server's admin role may set this; production keeps the default).
          await tx.execute(sql`SET LOCAL deadlock_timeout = '50ms'`);
          await tx.execute(sql`UPDATE acct SET v = v + 1 WHERE id = ${first}`);
          if (tries.get(name) === 1) await meet();
          await tx.execute(sql`UPDATE acct SET v = v + 1 WHERE id = ${second}`);
        },
        { retry: { ...noWait, onRetry: ({ error }) => errors.push(sqlState(error) ?? 'none') } },
      );
    await Promise.all([mover('x', 1, 2), mover('y', 2, 1)]);
    expect(errors).toEqual(['40P01']);
    const rows = await db.withClient(
      async (c) => (await c.query<{ v: number }>('SELECT v FROM acct ORDER BY id')).rows,
    );
    // Both transfers committed exactly once.
    expect(rows).toEqual([{ v: 2 }, { v: 2 }]);
  });

  it('does not retry other errors and surfaces them as typed DbErrors', async () => {
    await withTransaction(db.db, async (tx) => {
      await tx.execute(sql`INSERT INTO t VALUES ('dup', 0)`);
    });
    let calls = 0;
    const err = await withTransaction(db.db, async (tx) => {
      calls++;
      await tx.execute(sql`INSERT INTO t VALUES ('dup', 0)`);
    }).catch((e: unknown) => e);
    expect(calls).toBe(1);
    const typed = toDbError(err);
    expect(typed).toBeInstanceOf(DbError);
    expect(typed.code).toBe('unique_violation');
    expect(typed.constraint).toBe('t_pkey');
    expect(await count()).toBe(1);
    await db.withClient((c) => c.query('TRUNCATE t'));
  });

  it('propagates a serialization failure unchanged when retry is disabled', async () => {
    const meet = barrier(2);
    const writer = (name: string): Promise<void> =>
      withTransaction(
        db.db,
        async (tx) => {
          const res = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM t`);
          await meet();
          await tx.execute(sql`INSERT INTO t VALUES (${name}, ${res.rows[0]?.n ?? -1})`);
        },
        { isolationLevel: 'serializable', retry: false },
      );
    const results = await Promise.allSettled([writer('p'), writer('q')]);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failed).toHaveLength(1);
    expect(sqlState(failed[0]?.reason)).toBe('40001');
    expect(await count()).toBe(1);
  });
});

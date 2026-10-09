import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { dumpSchema } from '@binjari/testkit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { runDbCli } from '../../src/db/cli.js';
import {
  checksum,
  DEFAULT_MIGRATIONS_DIR,
  loadMigrations,
  migrate,
  MigrationError,
  migrationStatus,
  rollback,
} from '../../src/db/migrate.js';
import * as schema from '../../src/db/schema/index.js';
import { openTestDb, type TestDb } from '../support/db.js';
import { migrationBetween, type SchemaSnapshot, snapshotOf } from '../support/drizzle-kit.js';

const TAGS = ['0000_schema', '0001_invariants', '0002_app_role', '0003_review_fixes'];

/** Schema dump of the app's objects; binjari_meta (migration bookkeeping) is compared separately. */
async function dump(db: TestDb): Promise<string> {
  return db.withClient((c) => dumpSchema(c, { schemas: ['public'] }));
}

async function publicObjects(db: TestDb): Promise<number> {
  return db.withClient(async (c) => {
    const r = await c.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public')
            + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') AS n`,
    );
    return Number(r.rows[0]?.n);
  });
}

describe('migration runner', () => {
  const dbs: TestDb[] = [];
  const dirs: string[] = [];
  const fresh = async (): Promise<TestDb> => {
    const db = await openTestDb({ empty: true });
    dbs.push(db);
    return db;
  };
  /** A writable copy of the real migrations directory. */
  const copyMigrations = async (): Promise<string> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'binjari-migrations-'));
    dirs.push(dir);
    await cp(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
    return dir;
  };

  afterEach(async () => {
    for (const db of dbs.splice(0)) await db.cleanup();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('loads the journal in order with a down file for every migration', async () => {
    const ms = await loadMigrations();
    expect(ms.map((m) => m.tag)).toEqual(TAGS);
    for (const m of ms) {
      expect(m.down).not.toBeNull();
      expect(m.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('checksums ignore CRLF vs LF (a Windows checkout is the same migration)', () => {
    expect(checksum('a;\r\nb;\r\n')).toBe(checksum('a;\nb;\n'));
    expect(checksum('a;\nb;\n')).not.toBe(checksum('a;\nc;\n'));
  });

  it('applies every migration once; a second run is a no-op', async () => {
    const db = await fresh();
    const logs: string[] = [];
    expect(await migrate({ url: db.url, log: (m) => logs.push(m) })).toEqual({ applied: TAGS });
    expect(logs).toEqual(TAGS.map((t) => `applying ${t}`));
    expect(await migrate({ url: db.url })).toEqual({ applied: [] });
    expect(await migrationStatus({ url: db.url })).toEqual({ applied: TAGS, pending: [] });
  });

  it('acceptance 3: up -> down (all) -> up gives an identical schema dump', async () => {
    const db = await fresh();
    await migrate({ url: db.url });
    const first = await dump(db);
    expect(first).toContain('trigger | schema=public | table=ledger_postings');
    expect(await rollback({ url: db.url, steps: 'all' })).toEqual({
      rolledBack: [...TAGS].reverse(),
    });
    // Down removes everything the migrations created in public.
    expect(await publicObjects(db)).toBe(0);
    expect(await migrationStatus({ url: db.url })).toEqual({ applied: [], pending: TAGS });
    await migrate({ url: db.url });
    expect(await dump(db)).toBe(first);
  });

  it('each partial rollback followed by up restores the same schema', async () => {
    const db = await fresh();
    await migrate({ url: db.url });
    const full = await dump(db);
    for (let n = 1; n <= TAGS.length; n++) {
      const { rolledBack } = await rollback({ url: db.url, steps: n });
      expect(rolledBack).toEqual(TAGS.slice(TAGS.length - n).reverse());
      expect(await migrate({ url: db.url })).toEqual({ applied: TAGS.slice(TAGS.length - n) });
      expect(await dump(db)).toBe(full);
    }
  });

  it('refuses to run when an applied migration file was modified', async () => {
    const dir = await copyMigrations();
    const db = await fresh();
    await migrate({ url: db.url, dir });
    const file = path.join(dir, '0001_invariants.sql');
    await writeFile(file, `${await readFile(file, 'utf8')}\n-- edited after release\n`);
    await expect(migrate({ url: db.url, dir })).rejects.toThrow(/0001_invariants.*checksum/);
    await expect(rollback({ url: db.url, dir })).rejects.toBeInstanceOf(MigrationError);
  });

  it('refuses a database that has migrations the journal does not know', async () => {
    const dir = await copyMigrations();
    const db = await fresh();
    await migrate({ url: db.url });
    const journalFile = path.join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalFile, 'utf8')) as {
      dialect: string;
      entries: unknown[];
    };
    journal.entries = journal.entries.slice(0, 3);
    await writeFile(journalFile, JSON.stringify(journal));
    await expect(migrate({ url: db.url, dir })).rejects.toThrow(
      /0003_review_fixes.*not in the journal/,
    );
  });

  it('rolls back a failing migration completely and records nothing', async () => {
    const dir = await copyMigrations();
    const file = path.join(dir, '0001_invariants.sql');
    // Valid statements first, then an error: the whole file must be undone.
    await writeFile(
      file,
      `${await readFile(file, 'utf8')}\nCREATE TABLE half_done (x int);\nSELECT * FROM no_such_table;\n`,
    );
    const db = await fresh();
    const err = await migrate({ url: db.url, dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationError);
    expect((err as MigrationError).tag).toBe('0001_invariants');
    expect((err as MigrationError).message).toContain('no_such_table');
    const state = await db.withClient(async (c) => ({
      tags: (await c.query<{ tag: string }>('SELECT tag FROM binjari_meta.migrations')).rows.map(
        (r) => r.tag,
      ),
      halfDone: (await c.query<{ t: string | null }>("SELECT to_regclass('public.half_done') AS t"))
        .rows[0]?.t,
      triggers: (
        await c.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal',
        )
      ).rows[0]?.n,
    }));
    expect(state).toEqual({ tags: ['0000_schema'], halfDone: null, triggers: 0 });
  });

  it('checks every down file before undoing anything', async () => {
    const dir = await copyMigrations();
    const db = await fresh();
    await migrate({ url: db.url, dir });
    await unlink(path.join(dir, 'down', '0000_schema.sql'));
    await expect(rollback({ url: db.url, dir, steps: 'all' })).rejects.toThrow(
      /0000_schema has no down file/,
    );
    expect((await migrationStatus({ url: db.url, dir })).applied).toEqual(TAGS);
  });

  it('serializes concurrent runners (two servers starting at once)', async () => {
    const db = await fresh();
    const results = await Promise.all([migrate({ url: db.url }), migrate({ url: db.url })]);
    const applied = results.map((r) => r.applied).sort((a, b) => b.length - a.length);
    expect(applied).toEqual([TAGS, []]);
  });

  it('gives up after a bounded wait when another runner holds the lock', async () => {
    const db = await fresh();
    await db.withClient(async (holder) => {
      await holder.query('SELECT pg_advisory_lock($1, $2)', [0x62696e6a, 1]);
      await expect(migrate({ url: db.url, runnerWaitMs: 300 })).rejects.toThrow(
        /another migration runner/,
      );
    });
    // Released with the holder's session: the next run proceeds.
    expect((await migrate({ url: db.url })).applied).toEqual(TAGS);
  });

  it('status is read-only (no schema created, no lock taken)', async () => {
    const db = await fresh();
    expect(await migrationStatus({ url: db.url })).toEqual({ applied: [], pending: TAGS });
    const meta = await db.withClient(
      async (c) =>
        (
          await c.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'binjari_meta'",
          )
        ).rows[0]?.n,
    );
    expect(meta).toBe(0);
  });

  it('rejects invalid rollback step counts', async () => {
    const db = await fresh();
    await expect(rollback({ url: db.url, steps: 0 })).rejects.toThrow(/positive integer/);
  });
});

describe('drift: hand-reviewed SQL vs the Drizzle schema', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await openTestDb();
  });
  afterAll(async () => {
    await db.cleanup();
  });

  it('the last drizzle-kit snapshot matches src/db/schema (nothing left to generate)', async () => {
    const meta = path.join(DEFAULT_MIGRATIONS_DIR, 'meta');
    const journal = JSON.parse(await readFile(path.join(meta, '_journal.json'), 'utf8')) as {
      entries: { idx: number }[];
    };
    const last = journal.entries.at(-1)?.idx ?? 0;
    const snapshot = JSON.parse(
      await readFile(path.join(meta, `${String(last).padStart(4, '0')}_snapshot.json`), 'utf8'),
    ) as SchemaSnapshot;
    const current = snapshotOf(schema, snapshot.id);
    expect(await migrationBetween(snapshot, current)).toEqual([]);
  });

  it('the migrated tables equal what drizzle-kit generates from src/db/schema', async () => {
    // drizzle-kit's pushSchema cannot introspect our CHECK constraints (it fails with 42P02), so the
    // comparison is done in Postgres instead: apply drizzle-kit's own SQL for the TS schema to an empty
    // database and compare the catalog (tables, columns, constraints, indexes, sequences).
    // Triggers, functions and grants exist only in the hand-written 0001/0002 and are not compared.
    const statements = await migrationBetween(snapshotOf({}), snapshotOf(schema));
    const generated = await openTestDb({ empty: true });
    try {
      await generated.withClient(async (c) => {
        for (const s of statements) await c.query(s);
      });
      const shape = async (target: TestDb): Promise<string[]> =>
        (await dump(target))
          .split('\n')
          .filter((l) => /^(relation|column|constraint|index|sequence) /.test(l))
          // Constraint triggers (type=t) come from 0001, not from the TS schema.
          .filter((l) => !/^constraint .* \| type=t \|/.test(l))
          .map((l) => l.replace(/ \| acl=[^|]*/, ''));
      const fromTs = await shape(generated);
      expect(fromTs.length).toBeGreaterThan(500);
      expect(await shape(db)).toEqual(fromTs);
    } finally {
      await generated.cleanup();
    }
  });
});

describe('db CLI', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await openTestDb({ empty: true });
  });
  afterAll(async () => {
    await db.cleanup();
  });

  const run = async (
    argv: string[],
    env: Record<string, string | undefined> = { DATABASE_URL: db.url },
  ): Promise<{ code: number; out: string[]; err: string[] }> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runDbCli(argv, env, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out, err };
  };

  it('migrates, reports status and rolls back only with confirmation', async () => {
    expect((await run(['migrate'])).out.at(-1)).toBe('applied 4');
    expect((await run(['migrate'])).out).toEqual(['up to date']);
    expect((await run(['status'])).out).toEqual(TAGS.map((t) => `applied  ${t}`));
    const refused = await run(['rollback']);
    expect(refused.code).toBe(2);
    expect(refused.err.join('\n')).toContain('--yes');
    expect((await run(['rollback', '--yes', '--steps', '3'])).out.at(-1)).toBe('rolled back 3');
    expect((await run(['status'])).out).toEqual([
      'applied  0000_schema',
      'pending  0001_invariants',
      'pending  0002_app_role',
      'pending  0003_review_fixes',
    ]);
    expect((await run(['rollback', '--yes', '--all'])).out.at(-1)).toBe('rolled back 1');
  });

  it('validates its environment and arguments without printing the URL', async () => {
    const missing = await run(['migrate'], {});
    expect(missing.code).toBe(2);
    expect(missing.err.join('\n')).toContain('DATABASE_URL');
    expect((await run(['bogus'])).code).toBe(2);
    expect((await run(['rollback', '--yes', '--steps', '0'])).code).toBe(2);
    expect((await run([])).code).toBe(2);
    const bad = await run(['status'], {
      DATABASE_URL: 'postgres://binjari:hunter2-secret@127.0.0.1:1/nope',
    });
    expect(bad.code).toBe(1);
    expect(bad.err.join('\n')).not.toContain('hunter2-secret');
  });
});

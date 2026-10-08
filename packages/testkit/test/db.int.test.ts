import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createDatabase, dropDatabase, dropRunDatabases, withClient } from '../src/admin.js';
import { createIsolatedDatabase, type IsolatedDatabase } from '../src/isolated.js';
import { isolatedName, newRunId } from '../src/naming.js';

// Runs against TEST_DATABASE_URL / DATABASE_URL if set, otherwise against an embedded Postgres
// started once by the global setup (packages/testkit/src/global-setup.ts).
describe('test database (integration)', () => {
  let a: IsolatedDatabase;
  let b: IsolatedDatabase;

  beforeAll(async () => {
    a = await createIsolatedDatabase();
    b = await createIsolatedDatabase();
  });

  afterAll(async () => {
    await a.drop();
    await b.drop();
  });

  it('creates a table and reads rows back', async () => {
    const rows = await withClient(a.url, async (c) => {
      await c.query('CREATE TABLE widgets (id bigint PRIMARY KEY, name text NOT NULL)');
      await c.query("INSERT INTO widgets (id, name) VALUES (1, 'one'), (2, 'two')");
      const res = await c.query<{ id: string; name: string }>(
        'SELECT id, name FROM widgets ORDER BY id',
      );
      return res.rows;
    });
    // pg returns bigint as string: no silent precision loss.
    expect(rows).toEqual([
      { id: '1', name: 'one' },
      { id: '2', name: 'two' },
    ]);
  });

  it('gives each isolated database its own state', async () => {
    await withClient(a.url, (c) => c.query('CREATE TABLE only_in_a (x int)'));
    const tablesInB = await withClient(b.url, async (c) => {
      const res = await c.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      );
      return res.rows.map((r) => r.table_name);
    });
    expect(tablesInB).not.toContain('only_in_a');
    expect(tablesInB).not.toContain('widgets');
  });

  it('never modifies the template database', async () => {
    await withClient(a.url, (c) => c.query('CREATE TABLE after_clone (x int)'));
    // A fresh clone mirrors the template. Checking a clone (instead of connecting to the template)
    // avoids holding a template connection, which would make concurrent CREATE DATABASE ... TEMPLATE fail.
    const fresh = await createIsolatedDatabase();
    try {
      const tables = await withClient(fresh.url, async (c) => {
        const res = await c.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = 'public'",
        );
        return res.rows[0]?.n;
      });
      expect(tables).toBe('0');
    } finally {
      await fresh.drop();
    }
  });

  it('connects to the database it was given, not the admin database', async () => {
    const current = await withClient(a.url, async (c) => {
      const res = await c.query<{ db: string }>('SELECT current_database() AS db');
      return res.rows[0]?.db;
    });
    expect(current).toBe(a.name);
  });

  it('run cleanup drops only that run’s databases (underscores are escaped in LIKE)', async () => {
    const { adminUrl } = inject('binjariTestDb');
    const fakeRun = `zz${newRunId()}`;
    const target = isolatedName(fakeRun);
    // Decoys: would match if '_' were an unescaped LIKE wildcard, or if the prefix were not delimited.
    const decoys = [`binjarixtx${fakeRun}xabc`, isolatedName(`${fakeRun}0`)];
    for (const name of [target, ...decoys]) await createDatabase(adminUrl, name);
    try {
      const dropped = await dropRunDatabases(adminUrl, fakeRun);
      expect(dropped).toContain(target);
      const remaining = await withClient(adminUrl, async (c) => {
        const res = await c.query<{ datname: string }>(
          'SELECT datname FROM pg_database WHERE datname = ANY($1) ORDER BY datname',
          [[target, ...decoys]],
        );
        return res.rows.map((r) => r.datname);
      });
      expect(remaining).toEqual([...decoys].sort());
    } finally {
      for (const name of decoys) await dropDatabase(adminUrl, name);
    }
  });

  it('drop() removes the database and is idempotent', async () => {
    const c = await createIsolatedDatabase();
    await c.drop();
    await c.drop();
    const { adminUrl } = inject('binjariTestDb');
    const exists = await withClient(adminUrl, async (cl) => {
      const res = await cl.query('SELECT 1 FROM pg_database WHERE datname = $1', [c.name]);
      return res.rowCount;
    });
    expect(exists).toBe(0);
  });
});

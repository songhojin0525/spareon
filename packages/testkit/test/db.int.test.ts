import { afterEach, describe, expect, inject, it } from 'vitest';

import { createDatabase, dropDatabase, dropRunDatabases, withClient } from '../src/admin.js';
import { createIsolatedDatabase, type IsolatedDatabase } from '../src/isolated.js';
import { isolatedName, newRunId } from '../src/naming.js';

// Runs against TEST_DATABASE_URL / a local DATABASE_URL if set, otherwise against an embedded Postgres
// started once by the global setup (packages/testkit/src/global-setup.ts).
// Every test creates its own databases, so tests do not depend on order or on each other.

const created: IsolatedDatabase[] = [];
async function fresh(): Promise<IsolatedDatabase> {
  const db = await createIsolatedDatabase();
  created.push(db);
  return db;
}
afterEach(async () => {
  for (const db of created.splice(0)) await db.drop();
});

async function publicTables(url: string): Promise<string[]> {
  return withClient(url, async (c) => {
    const res = await c.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    return res.rows.map((r) => r.table_name);
  });
}

describe('test database (integration)', () => {
  it('creates a table and reads rows back', async () => {
    const db = await fresh();
    const rows = await withClient(db.url, async (c) => {
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
    const a = await fresh();
    const b = await fresh();
    await withClient(a.url, (c) => c.query('CREATE TABLE only_in_a (x int)'));
    expect(await publicTables(a.url)).toEqual(['only_in_a']);
    expect(await publicTables(b.url)).toEqual([]);
  });

  it('writes to a clone never reach the template (later clones start empty)', async () => {
    const a = await fresh();
    await withClient(a.url, (c) => c.query('CREATE TABLE written_after_clone (x int)'));
    expect(await publicTables(a.url)).toEqual(['written_after_clone']);
    // A fresh clone mirrors the template. Checking a clone (instead of connecting to the template)
    // avoids holding a template connection, which would make concurrent CREATE DATABASE ... TEMPLATE fail.
    const later = await fresh();
    expect(await publicTables(later.url)).toEqual([]);
  });

  it('connects to the database it was given, not the admin database', async () => {
    const db = await fresh();
    const current = await withClient(db.url, async (c) => {
      const res = await c.query<{ db: string }>('SELECT current_database() AS db');
      return res.rows[0]?.db;
    });
    expect(current).toBe(db.name);
  });

  it('run cleanup drops only that run’s databases (underscores are escaped in LIKE)', async () => {
    const { adminUrl } = inject('spareonTestDb');
    const fakeRun = `zz${newRunId()}`;
    const target = isolatedName(fakeRun);
    // Decoys: would match if '_' were an unescaped LIKE wildcard, or if the prefix were not delimited.
    const decoys = [`spareonxtx${fakeRun}xabc`, isolatedName(`${fakeRun}0`)];
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
    const { adminUrl } = inject('spareonTestDb');
    const exists = await withClient(adminUrl, async (cl) => {
      const res = await cl.query('SELECT 1 FROM pg_database WHERE datname = $1', [c.name]);
      return res.rowCount;
    });
    expect(exists).toBe(0);
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import { withClient } from '../src/admin.js';
import { createIsolatedDatabase, type IsolatedDatabase } from '../src/isolated.js';
import { dumpSchema } from '../src/schema-dump.js';

const created: IsolatedDatabase[] = [];
async function fresh(): Promise<IsolatedDatabase> {
  const db = await createIsolatedDatabase({ empty: true });
  created.push(db);
  return db;
}
afterEach(async () => {
  for (const db of created.splice(0)) await db.drop();
});

async function apply(url: string, statements: readonly string[]): Promise<string> {
  return withClient(url, async (c) => {
    for (const s of statements) await c.query(s);
    return dumpSchema(c, { schemas: ['public', 'extra'] });
  });
}

const BASE = [
  'CREATE SCHEMA extra',
  "CREATE TABLE a (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, amount bigint NOT NULL CHECK (amount > 0), note text DEFAULT 'x')",
  'CREATE TABLE extra.b (id uuid PRIMARY KEY, a_id bigint REFERENCES a(id) DEFERRABLE INITIALLY DEFERRED)',
  'CREATE INDEX a_note_idx ON a (note) WHERE note IS NOT NULL',
  "CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'no'; END $$",
  'CREATE TRIGGER a_no_update BEFORE UPDATE ON a FOR EACH ROW EXECUTE FUNCTION f()',
  'ALTER TABLE a ENABLE ALWAYS TRIGGER a_no_update',
];

describe('dumpSchema (integration)', () => {
  it('is identical for the same objects created in a different order', async () => {
    const one = await apply((await fresh()).url, BASE);
    const reordered = [BASE[0], BASE[1], BASE[4], BASE[5], BASE[6], BASE[3], BASE[2]].map(String);
    const two = await apply((await fresh()).url, reordered);
    expect(two).toBe(one);
    expect(one).toContain('relation | schema=extra | name=b');
    expect(one).toContain('CHECK (amount > 0)');
    expect(one).toContain('enabled=A');
  });

  it.each([
    ['a check constraint', 'ALTER TABLE a ADD CONSTRAINT note_len CHECK (char_length(note) < 10)'],
    ['a column default', "ALTER TABLE a ALTER COLUMN note SET DEFAULT 'y'"],
    ['a trigger enable mode', 'ALTER TABLE a ENABLE TRIGGER a_no_update'],
    ['a privilege', 'GRANT SELECT ON a TO PUBLIC'],
    ['an index predicate', 'DROP INDEX a_note_idx'],
    [
      'a function body',
      "CREATE OR REPLACE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'nope'; END $$",
    ],
    ['nullability', 'ALTER TABLE a ALTER COLUMN note SET NOT NULL'],
  ])('notices a change in %s', async (_what, change) => {
    const base = await apply((await fresh()).url, BASE);
    const changed = await apply((await fresh()).url, [...BASE, change]);
    expect(changed).not.toBe(base);
  });

  it('an empty database dumps no relations', async () => {
    const dump = await apply((await fresh()).url, []);
    expect(dump).not.toContain('relation |');
  });
});

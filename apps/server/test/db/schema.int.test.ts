import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema/index.js';
import { openTestDb, type TestDb } from '../support/db.js';

/** Every pgTable exported by the Drizzle schema. */
function schemaTables(): PgTable[] {
  return (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  column_default: string | null;
}

describe('migrated schema (template database)', () => {
  let db: TestDb;
  let columns: ColumnRow[];

  beforeAll(async () => {
    db = await openTestDb();
    columns = await db.withClient(
      async (c) =>
        (
          await c.query<ColumnRow>(
            `SELECT table_name, column_name, data_type, column_default
               FROM information_schema.columns WHERE table_schema = 'public'
              ORDER BY table_name, ordinal_position`,
          )
        ).rows,
    );
  });
  afterAll(async () => {
    await db.cleanup();
  });

  it('has exactly the tables the Drizzle schema declares', async () => {
    const tables = await db.withClient(
      async (c) =>
        (
          await c.query<{ name: string }>(
            `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
          )
        ).rows,
    );
    const declared = schemaTables()
      .map((t) => getTableConfig(t).name)
      .sort();
    expect(declared.length).toBeGreaterThan(30);
    expect(tables.map((t) => t.name)).toEqual(declared);
  });

  it('records the applied migrations', async () => {
    const rows = await db.withClient(
      async (c) =>
        (await c.query<{ tag: string }>('SELECT tag FROM spareon_meta.migrations ORDER BY idx'))
          .rows,
    );
    expect(rows.map((r) => r.tag)).toEqual([
      '0000_schema',
      '0001_invariants',
      '0002_app_role',
      '0003_review_fixes',
    ]);
  });

  it('uses no floating-point, numeric, money, json or zone-less time columns', () => {
    const forbidden = new Set([
      'numeric',
      'real',
      'double precision',
      'money',
      'json',
      'timestamp without time zone',
      'time without time zone',
      'time with time zone',
    ]);
    const bad = columns.filter((c) => forbidden.has(c.data_type));
    expect(bad).toEqual([]);
  });

  it('stores every money and price column as bigint', () => {
    const money = columns.filter((c) =>
      /(^|_)(amount|balance|ucr|uusd|krw|won)(_|$)/.test(c.column_name),
    );
    expect(money.length).toBeGreaterThan(15);
    expect(money.filter((c) => c.data_type !== 'bigint')).toEqual([]);
  });

  it('has no database-side clock defaults (times come from the injected Clock)', () => {
    const clockDefaults = columns.filter((c) =>
      /now\(\)|current_timestamp|clock_timestamp|localtimestamp/i.test(c.column_default ?? ''),
    );
    expect(clockDefaults).toEqual([]);
  });

  it('holds buyer content only as ciphertext in job_payloads and batch_files (reviewed list)', () => {
    // A new column whose name suggests content fails here until it is reviewed (CLAUDE.md rule 4).
    const contentLike = columns
      .filter((c) =>
        /(prompt|content|message|result|cipher|plain|body|payload|input|output)/.test(
          c.column_name,
        ),
      )
      .map((c) => `${c.table_name}.${c.column_name}:${c.data_type}`)
      .sort();
    expect(contentLike).toEqual([
      'batch_files.ciphertext:bytea',
      'batch_files.plaintext_bytes:bigint',
      'job_attempts.output_sha256:text',
      'job_payloads.ciphertext:bytea',
      'job_payloads.plaintext_bytes:integer',
      'jobs.input_bytes:integer',
      // Outbox events carry ids and states for other components, never buyer content (docs/DB.md).
      'outbox_events.payload:jsonb',
      'price_entries.input_ucr_per_mtok:bigint',
      'price_entries.output_ucr_per_mtok:bigint',
    ]);
  });

  it('has the partial queue index the scheduler claims from', async () => {
    const def = await db.withClient(
      async (c) =>
        (
          await c.query<{ indexdef: string }>(
            `SELECT indexdef FROM pg_indexes WHERE indexname = 'jobs_queue_idx'`,
          )
        ).rows[0]?.indexdef,
    );
    expect(def).toContain('(priority DESC NULLS LAST, created_at, id)');
    expect(def).toContain("WHERE (status = 'queued'::text)");
  });
});

import { newUuidV7 } from '@binjari/shared';
import { FakeClock } from '@binjari/testkit';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sqlState } from '../../src/db/errors.js';
import { openTestDb, type TestDb } from '../support/db.js';

/**
 * 0002_app_role: the server runs as a member of binjari_app, which can use the tables but cannot
 * change history, write balances, or switch the invariant triggers off (S03 review point
 * "다른 연결 역할"). Every attempt below runs as binjari_app (session authorization).
 */

const clock = new FakeClock();
const id = (): string => newUuidV7(clock.now());
const at = (): string => clock.now().toISOString();

/** Expected grants per table: a new table without a decision in 0002 fails this test. */
const APPEND_ONLY = 'INSERT,SELECT';
const READ_ONLY = 'SELECT';
const NO_DELETE = 'INSERT,SELECT,UPDATE';
const FULL = 'DELETE,INSERT,SELECT,UPDATE';
const EXPECTED_GRANTS: Record<string, string> = {
  ledger_accounts: APPEND_ONLY,
  ledger_transactions: APPEND_ONLY,
  ledger_postings: APPEND_ONLY,
  audit_log: APPEND_ONLY,
  price_versions: APPEND_ONLY,
  price_entries: APPEND_ONLY,
  fx_rates: APPEND_ONLY,
  account_balances: READ_ONLY,
  holds: NO_DELETE,
  earnings: NO_DELETE,
  payout_records: NO_DELETE,
  users: FULL,
  sessions: FULL,
  api_keys: FULL,
  idempotency_keys: FULL,
  stores: FULL,
  enrollment_codes: FULL,
  nodes: FULL,
  node_events: FULL,
  presence_intervals: FULL,
  kill_switches: FULL,
  models: FULL,
  model_artifacts: FULL,
  runtime_releases: FULL,
  agent_releases: FULL,
  batches: FULL,
  batch_files: FULL,
  jobs: FULL,
  job_attempts: FULL,
  job_payloads: FULL,
  verifications: FULL,
  reputation_events: FULL,
  external_usage: FULL,
  reserve_reservations: FULL,
  settings: FULL,
  outbox_events: FULL,
};

async function stateOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return sqlState(err) ?? 'no-sqlstate';
  }
}

describe('binjari_app role (least privilege)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await openTestDb();
  });
  afterAll(async () => {
    await db.cleanup();
  });

  /**
   * Run fn as binjari_app on a dedicated connection. SET SESSION AUTHORIZATION (not SET ROLE) makes it
   * the session user, as for a real login: SET ROLE checks are then made against binjari_app.
   */
  const asApp = <T>(fn: (c: pg.ClientBase, owner: string) => Promise<T>): Promise<T> =>
    db.withClient(async (c) => {
      // The migration owner (the test admin): the role an attacker would most like to become.
      const owner = (await c.query<{ u: string }>('SELECT current_user AS u')).rows[0]?.u ?? '';
      await c.query('SET SESSION AUTHORIZATION binjari_app');
      try {
        return await fn(c, owner);
      } finally {
        await c.query('RESET SESSION AUTHORIZATION');
      }
    });

  it('has exactly the reviewed table privileges and owns nothing', async () => {
    const rows = await db.withClient(
      async (c) =>
        (
          await c.query<{ table: string; privileges: string | null }>(
            `SELECT t.tablename AS table,
                    (SELECT string_agg(p, ',' ORDER BY p) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
                      WHERE has_table_privilege('binjari_app', format('public.%I', t.tablename), p)) AS privileges
               FROM pg_tables t WHERE t.schemaname = 'public' ORDER BY 1`,
          )
        ).rows,
    );
    expect(Object.fromEntries(rows.map((r) => [r.table, r.privileges]))).toEqual(EXPECTED_GRANTS);
    const owned = await db.withClient(
      async (c) =>
        (
          await c.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_class WHERE relowner = 'binjari_app'::regrole`,
          )
        ).rows[0]?.n,
    );
    expect(owned).toBe(0);
    const role = await db.withClient(
      async (c) =>
        (
          await c.query<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }>(
            `SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'binjari_app'`,
          )
        ).rows[0],
    );
    expect(role).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false });
  });

  it('can do the ledger work the server needs (accounts, balanced entries, reading balances)', async () => {
    const result = await asApp(async (c) => {
      const conv = id();
      const wallet = id();
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO ledger_accounts (id, kind, owner_type, owner_id, currency, allow_negative, created_at)
         VALUES ($1, 'fx_conversion', 'platform', NULL, 'CR', true, $3),
                ($2, 'buyer_wallet', 'user', $4, 'CR', false, $3)`,
        [conv, wallet, at(), id()],
      );
      const tx = id();
      await c.query(
        `INSERT INTO ledger_transactions (id, kind, idempotency_key, created_at) VALUES ($1, 'TEST_TOPUP', $2, $3)`,
        [tx, `test:${tx}`, at()],
      );
      await c.query(
        `INSERT INTO ledger_postings (tx_id, account_id, currency, amount) VALUES ($1, $2, 'CR', -5), ($1, $3, 'CR', 5)`,
        [tx, conv, wallet],
      );
      await c.query('COMMIT');
      return (
        await c.query<{ balance: string }>(
          'SELECT balance::text FROM account_balances WHERE account_id = $1',
          [wallet],
        )
      ).rows[0]?.balance;
    });
    expect(result).toBe('5');
  });

  it('cannot rewrite history, write balances or delete money records (42501)', async () => {
    const attempts = await asApp(async (c) => ({
      updatePostings: await stateOf(c.query('UPDATE ledger_postings SET amount = amount')),
      deletePostings: await stateOf(c.query('DELETE FROM ledger_postings')),
      updateTx: await stateOf(c.query("UPDATE ledger_transactions SET memo = 'x'")),
      updateAudit: await stateOf(c.query("UPDATE audit_log SET action = 'x'")),
      truncateAudit: await stateOf(c.query('TRUNCATE audit_log')),
      updateBalance: await stateOf(c.query('UPDATE account_balances SET balance = 1')),
      insertBalance: await stateOf(
        c.query(
          `INSERT INTO account_balances (account_id, currency, allow_negative) VALUES ($1, 'CR', true)`,
          [id()],
        ),
      ),
      deleteHolds: await stateOf(c.query('DELETE FROM holds')),
      deleteEarnings: await stateOf(c.query('DELETE FROM earnings')),
      deletePayouts: await stateOf(c.query('DELETE FROM payout_records')),
      updateAccount: await stateOf(c.query('UPDATE ledger_accounts SET allow_negative = true')),
    }));
    expect(attempts).toEqual({
      updatePostings: '42501',
      deletePostings: '42501',
      updateTx: '42501',
      updateAudit: '42501',
      truncateAudit: '42501',
      updateBalance: '42501',
      insertBalance: '42501',
      deleteHolds: '42501',
      deleteEarnings: '42501',
      deletePayouts: '42501',
      updateAccount: '42501',
    });
  });

  it('cannot switch the invariant triggers off or change the schema', async () => {
    const attempts = await asApp(async (c, owner) => ({
      disableTrigger: await stateOf(c.query('ALTER TABLE ledger_postings DISABLE TRIGGER ALL')),
      disableOne: await stateOf(
        c.query('ALTER TABLE ledger_transactions DISABLE TRIGGER ledger_tx_balanced'),
      ),
      dropTrigger: await stateOf(c.query('DROP TRIGGER audit_log_append_only ON audit_log')),
      replicaMode: await stateOf(c.query('SET session_replication_role = replica')),
      replaceFunction: await stateOf(
        c.query(
          `CREATE OR REPLACE FUNCTION public.binjari_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
        ),
      ),
      createTable: await stateOf(c.query('CREATE TABLE public.sneaky (x int)')),
      dropTable: await stateOf(c.query('DROP TABLE audit_log')),
      alterCheck: await stateOf(
        c.query('ALTER TABLE account_balances DROP CONSTRAINT account_balances_non_negative_check'),
      ),
      becomeOwner: await stateOf(c.query(`SET ROLE "${owner}"`)),
    }));
    expect(attempts).toEqual({
      disableTrigger: '42501',
      disableOne: '42501',
      dropTrigger: '42501',
      replicaMode: '42501',
      replaceFunction: '42501',
      createTable: '42501',
      dropTable: '42501',
      alterCheck: '42501',
      becomeOwner: '42501',
    });
  });

  it('cannot redirect the SECURITY DEFINER balance trigger with a temp table', async () => {
    // The definer functions use schema-qualified names and search_path = pg_catalog, pg_temp, so a
    // temporary account_balances created by the app role is never written instead of the real one.
    const balances = await asApp(async (c) => {
      await c.query(
        'CREATE TEMP TABLE account_balances (account_id uuid, currency text, allow_negative boolean, balance bigint, version bigint)',
      );
      const conv = id();
      const wallet = id();
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO public.ledger_accounts (id, kind, owner_type, owner_id, currency, allow_negative, created_at, shard)
         VALUES ($1, 'fx_conversion', 'platform', NULL, 'CR', true, $3, 1),
                ($2, 'buyer_wallet', 'user', $4, 'CR', false, $3, 0)`,
        [conv, wallet, at(), id()],
      );
      const tx = id();
      await c.query(
        `INSERT INTO public.ledger_transactions (id, kind, idempotency_key, created_at) VALUES ($1, 'TEST_TOPUP', $2, $3)`,
        [tx, `test:${tx}`, at()],
      );
      await c.query(
        `INSERT INTO public.ledger_postings (tx_id, account_id, currency, amount) VALUES ($1, $2, 'CR', -3), ($1, $3, 'CR', 3)`,
        [tx, conv, wallet],
      );
      await c.query('COMMIT');
      const temp = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM account_balances'))
        .rows[0]?.n;
      const real = (
        await c.query<{ balance: string }>(
          'SELECT balance::text FROM public.account_balances WHERE account_id = $1',
          [wallet],
        )
      ).rows[0]?.balance;
      await c.query('DROP TABLE pg_temp.account_balances');
      return { temp, real };
    });
    expect(balances).toEqual({ temp: 0, real: '3' });
  });
});

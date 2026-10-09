import { newUuidV7 } from '@binjari/shared';
import { FakeClock } from '@binjari/testkit';
import fc from 'fast-check';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sqlState } from '../../src/db/errors.js';
import { openTestDb, type TestDb } from '../support/db.js';

/**
 * Acceptance 2 of S03 and the other money/audit invariants of drizzle/0001_invariants.sql, exercised
 * with raw SQL as a superuser connection (the strongest client short of DDL; the app role is tested in
 * roles.int.test.ts).
 */

const clock = new FakeClock();
const id = (): string => newUuidV7(clock.now());
const at = (): string => clock.now().toISOString();

type Kind =
  | 'buyer_wallet'
  | 'buyer_hold'
  | 'platform_revenue'
  | 'test_topup_source'
  | 'reserve'
  | 'fx_conversion';

let shard = 0;

async function account(
  c: pg.ClientBase,
  kind: Kind,
  currency: string,
  options: { allowNegative?: boolean } = {},
): Promise<string> {
  const accountId = id();
  const owner = kind.startsWith('buyer_') ? 'user' : 'platform';
  // Platform accounts are unique per (kind, currency, shard): use a new shard for each test account.
  shard = (shard + 1) % 256;
  await c.query(
    `INSERT INTO ledger_accounts (id, kind, owner_type, owner_id, currency, allow_negative, created_at, shard)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      accountId,
      kind,
      owner,
      owner === 'user' ? id() : null,
      currency,
      options.allowNegative ?? false,
      at(),
      shard,
    ],
  );
  return accountId;
}

async function ledgerTx(c: pg.ClientBase, key = `test:${id()}`): Promise<string> {
  const txId = id();
  await c.query(
    `INSERT INTO ledger_transactions (id, kind, idempotency_key, created_at) VALUES ($1, 'TEST_TOPUP', $2, $3)`,
    [txId, key, at()],
  );
  return txId;
}

async function post(
  c: pg.ClientBase,
  txId: string,
  accountId: string,
  currency: string,
  amount: bigint,
): Promise<void> {
  await c.query(
    'INSERT INTO ledger_postings (tx_id, account_id, currency, amount) VALUES ($1, $2, $3, $4)',
    [txId, accountId, currency, amount.toString()],
  );
}

async function balance(c: pg.ClientBase, accountId: string): Promise<bigint> {
  const r = await c.query<{ balance: string }>(
    'SELECT balance::text FROM account_balances WHERE account_id = $1',
    [accountId],
  );
  return BigInt(r.rows[0]?.balance ?? 'NaN');
}

/** Run fn in BEGIN ... COMMIT; resolves to the SQLSTATE of the failure, or 'ok'. */
async function txn(c: pg.ClientBase, fn: () => Promise<void>): Promise<string> {
  await c.query('BEGIN');
  try {
    await fn();
    await c.query('COMMIT');
    return 'ok';
  } catch (err) {
    await c.query('ROLLBACK');
    return sqlState(err) ?? 'no-sqlstate';
  }
}

/** The SQLSTATE a single statement fails with, or 'ok'. */
async function stateOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return sqlState(err) ?? 'no-sqlstate';
  }
}

describe('ledger invariants (DB-enforced)', () => {
  let db: TestDb;
  let c: pg.Client;
  let release: () => void;
  let done: Promise<void>;

  beforeAll(async () => {
    db = await openTestDb();
    // One dedicated connection for the whole file (explicit BEGIN/COMMIT).
    let ready!: (client: pg.Client) => void;
    const got = new Promise<pg.Client>((resolve) => {
      ready = resolve;
    });
    done = db.withClient(
      (client) =>
        new Promise<void>((resolve) => {
          release = resolve;
          ready(client);
        }),
    );
    c = await got;
  });
  afterAll(async () => {
    release();
    await done;
    await db.cleanup();
  });

  it('commits a balanced transaction and derives balances from the postings', async () => {
    const source = await account(c, 'test_topup_source', 'KRW', { allowNegative: true });
    const reserve = await account(c, 'reserve', 'KRW');
    const conv = await account(c, 'fx_conversion', 'CR', { allowNegative: true });
    const wallet = await account(c, 'buyer_wallet', 'CR');
    const result = await txn(c, async () => {
      const tx = await ledgerTx(c);
      await post(c, tx, source, 'KRW', -10_000n);
      await post(c, tx, reserve, 'KRW', 10_000n);
      await post(c, tx, conv, 'CR', -10_000_000n);
      await post(c, tx, wallet, 'CR', 10_000_000n);
    });
    expect(result).toBe('ok');
    expect(await balance(c, wallet)).toBe(10_000_000n);
    expect(await balance(c, source)).toBe(-10_000n);
    const v = await c.query<{ version: string }>(
      'SELECT version::text FROM account_balances WHERE account_id = $1',
      [wallet],
    );
    expect(v.rows[0]?.version).toBe('1');
  });

  it('acceptance 2: a transaction whose postings do not sum to zero fails at COMMIT', async () => {
    const conv = await account(c, 'fx_conversion', 'CR', { allowNegative: true });
    const wallet = await account(c, 'buyer_wallet', 'CR');
    await c.query('BEGIN');
    const tx = await ledgerTx(c);
    await post(c, tx, conv, 'CR', -5n);
    // Each statement succeeds: the check is deferred to commit.
    await post(c, tx, wallet, 'CR', 4n);
    expect(await stateOf(c.query('COMMIT'))).toBe('BJ001');
    expect(await balance(c, wallet)).toBe(0n);
  });

  it('balances each currency separately', async () => {
    const conv = await account(c, 'fx_conversion', 'CR', { allowNegative: true });
    const convKrw = await account(c, 'fx_conversion', 'KRW', { allowNegative: true });
    const wallet = await account(c, 'buyer_wallet', 'CR');
    const reserve = await account(c, 'reserve', 'KRW');
    // CR balances, KRW does not (the sums across currencies are zero, which must not count).
    const result = await txn(c, async () => {
      const tx = await ledgerTx(c);
      await post(c, tx, conv, 'CR', -7n);
      await post(c, tx, wallet, 'CR', 7n);
      await post(c, tx, convKrw, 'KRW', -3n);
      await post(c, tx, reserve, 'KRW', 2n);
      await post(c, tx, wallet, 'CR', 1n);
      await post(c, tx, conv, 'CR', -1n);
      await post(c, tx, reserve, 'KRW', 1n);
      await post(c, tx, reserve, 'KRW', 5n);
      await post(c, tx, conv, 'CR', 5n);
    });
    expect(result).toBe('BJ001');
  });

  it('rejects a transaction without postings', async () => {
    expect(await txn(c, () => ledgerTx(c).then(() => undefined))).toBe('BJ001');
  });

  it('re-checks postings added after SET CONSTRAINTS ... IMMEDIATE', async () => {
    const conv = await account(c, 'fx_conversion', 'CR', { allowNegative: true });
    const wallet = await account(c, 'buyer_wallet', 'CR');
    const result = await txn(c, async () => {
      const tx = await ledgerTx(c);
      await c.query(
        `INSERT INTO ledger_postings (tx_id, account_id, currency, amount) VALUES ($1, $2, 'CR', -9), ($1, $3, 'CR', 9)`,
        [tx, conv, wallet],
      );
      await c.query('SET CONSTRAINTS ALL IMMEDIATE'); // checks now and passes
      await c.query('SET CONSTRAINTS ALL DEFERRED');
      await post(c, tx, wallet, 'CR', 100n); // free money, added after the check
    });
    expect(result).toBe('BJ001');
    expect(await balance(c, wallet)).toBe(0n);
  });

  it('refuses postings added to a transaction committed earlier (BJ004)', async () => {
    const conv = await account(c, 'fx_conversion', 'CR', { allowNegative: true });
    const wallet = await account(c, 'buyer_wallet', 'CR');
    let tx = '';
    expect(
      await txn(c, async () => {
        tx = await ledgerTx(c);
        await post(c, tx, conv, 'CR', -1n);
        await post(c, tx, wallet, 'CR', 1n);
      }),
    ).toBe('ok');
    // A balanced pair slipped into the old entry would rewrite history without breaking any sum.
    const result = await txn(c, async () => {
      await post(c, tx, conv, 'CR', -1_000n);
      await post(c, tx, wallet, 'CR', 1_000n);
    });
    expect(result).toBe('BJ004');
    // created_xid is set by the trigger, whatever the client sends.
    await c.query('BEGIN');
    const forgedId = id();
    await c.query(
      `INSERT INTO ledger_transactions (id, kind, idempotency_key, created_at, created_xid)
       VALUES ($1, 'TEST_TOPUP', $2, $3, '1')`,
      [forgedId, `test:${id()}`, at()],
    );
    const stamped = await c.query<{ same: boolean }>(
      'SELECT created_xid = pg_current_xact_id() AS same FROM ledger_transactions WHERE id = $1',
      [forgedId],
    );
    await c.query('ROLLBACK');
    expect(stamped.rows[0]?.same).toBe(true);
  });

  it('acceptance 2: a non-negative account cannot go below zero; allow_negative accounts can', async () => {
    const conv = await account(c, 'fx_conversion', 'CR', { allowNegative: true });
    const wallet = await account(c, 'buyer_wallet', 'CR');
    const overdraw = await txn(c, async () => {
      const tx = await ledgerTx(c);
      await post(c, tx, wallet, 'CR', -1n);
      await post(c, tx, conv, 'CR', 1n);
    });
    expect(overdraw).toBe('23514');
    const ok = await txn(c, async () => {
      const tx = await ledgerTx(c);
      await post(c, tx, conv, 'CR', -1n);
      await post(c, tx, wallet, 'CR', 1n);
    });
    expect(ok).toBe('ok');
    expect(await balance(c, conv)).toBe(-1n);
  });

  it('a posting must use its account currency', async () => {
    const conv = await account(c, 'fx_conversion', 'CR', { allowNegative: true });
    const wallet = await account(c, 'buyer_wallet', 'TCR');
    const result = await txn(c, async () => {
      const tx = await ledgerTx(c);
      await post(c, tx, conv, 'CR', -1n);
      await post(c, tx, wallet, 'CR', 1n);
    });
    expect(result).toBe('23503');
  });

  it('acceptance 2: a duplicate idempotency key fails (ledger and HTTP idempotency keys)', async () => {
    const conv = await account(c, 'fx_conversion', 'CR', { allowNegative: true });
    const wallet = await account(c, 'buyer_wallet', 'CR');
    const once = async (): Promise<string> =>
      txn(c, async () => {
        const tx = await ledgerTx(c, 'job:0190a000-0000-7000-8000-000000000000:capture');
        await post(c, tx, conv, 'CR', -1n);
        await post(c, tx, wallet, 'CR', 1n);
      });
    expect(await once()).toBe('ok');
    expect(await once()).toBe('23505');
    expect(await balance(c, wallet)).toBe(1n);

    const key = async (): Promise<string> =>
      stateOf(
        c.query(
          `INSERT INTO idempotency_keys (scope, key, request_hash, status, created_at, expires_at)
           VALUES ('buyer:1', 'abc', $1, 'in_progress', $2, $3)`,
          [Buffer.alloc(32, 1), at(), new Date(clock.nowMs() + 86_400_000).toISOString()],
        ),
      );
    expect(await key()).toBe('ok');
    expect(await key()).toBe('23505');
  });

  it('accounts cannot be created with rules that would bypass the money invariants', async () => {
    // A buyer wallet allowed to go negative would mint credit.
    expect(await stateOf(account(c, 'buyer_wallet', 'CR', { allowNegative: true }))).toBe('23514');
    // M8: TCR never reaches reserve accounts.
    expect(await stateOf(account(c, 'reserve', 'TCR'))).toBe('23514');
  });
});

describe('append-only and derived tables', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await openTestDb();
  });
  afterAll(async () => {
    await db.cleanup();
  });

  it('acceptance 2: audit_log, ledger_* , prices and fx rates reject UPDATE, DELETE and TRUNCATE', async () => {
    await db.withClient(async (c) => {
      const conv = await account(c, 'fx_conversion', 'CR', { allowNegative: true });
      const wallet = await account(c, 'buyer_wallet', 'CR');
      expect(
        await txn(c, async () => {
          const tx = await ledgerTx(c);
          await post(c, tx, conv, 'CR', -1n);
          await post(c, tx, wallet, 'CR', 1n);
        }),
      ).toBe('ok');
      await c.query(
        `INSERT INTO audit_log (id, at, actor_kind, action) VALUES ($1, $2, 'system', 'test.event')`,
        [id(), at()],
      );
      await c.query(
        `INSERT INTO price_versions (id, version, effective_at, created_at) VALUES ($1, 1, $2, $2)`,
        [id(), at()],
      );
      await c.query(
        `INSERT INTO fx_rates (id, pair, rate_micros, source, effective_at, created_at)
         VALUES ($1, 'USD/KRW', 1400000000, 'manual', $2, $2)`,
        [id(), at()],
      );
      const tables: Record<string, string> = {
        audit_log: "action = 'x.y'",
        ledger_transactions: "memo = 'changed'",
        ledger_postings: 'amount = amount * 2',
        ledger_accounts: 'allow_negative = true',
        price_versions: 'version = 2',
        fx_rates: 'rate_micros = 1',
      };
      for (const [table, set] of Object.entries(tables)) {
        expect([table, await stateOf(c.query(`UPDATE ${table} SET ${set}`))]).toEqual([
          table,
          'BJ002',
        ]);
        expect([table, await stateOf(c.query(`DELETE FROM ${table}`))]).toEqual([table, 'BJ002']);
        expect([table, await stateOf(c.query(`TRUNCATE ${table} CASCADE`))]).toEqual([
          table,
          'BJ002',
        ]);
      }
      // Replication mode does not switch the triggers off (ENABLE ALWAYS).
      await c.query('SET session_replication_role = replica');
      expect(await stateOf(c.query("UPDATE audit_log SET action = 'x.y'"))).toBe('BJ002');
      expect(await stateOf(c.query('DELETE FROM ledger_postings'))).toBe('BJ002');
      await c.query('RESET session_replication_role');
    });
  });

  it('account_balances can only be changed by postings', async () => {
    await db.withClient(async (c) => {
      const wallet = await account(c, 'buyer_wallet', 'CR');
      expect(await stateOf(c.query('UPDATE account_balances SET balance = 1000000'))).toBe('BJ003');
      expect(await stateOf(c.query('DELETE FROM account_balances'))).toBe('BJ003');
      expect(await stateOf(c.query('TRUNCATE account_balances'))).toBe('BJ002');
      expect(
        await stateOf(
          c.query(
            `INSERT INTO account_balances (account_id, currency, allow_negative, balance) VALUES ($1, 'CR', false, 5)`,
            [id()],
          ),
        ),
      ).toBe('BJ003');
      expect(await balance(c, wallet)).toBe(0n);
    });
  });

  it('holds: amounts are bounded, only grow, and a finished hold is final', async () => {
    await db.withClient(async (c) => {
      const wallet = await account(c, 'buyer_wallet', 'CR');
      const conv = await account(c, 'fx_conversion', 'CR', { allowNegative: true });
      let tx = '';
      await txn(c, async () => {
        tx = await ledgerTx(c);
        await post(c, tx, conv, 'CR', -100n);
        await post(c, tx, wallet, 'CR', 100n);
      });
      const holdId = id();
      await c.query(
        `INSERT INTO holds (id, buyer_account_id, currency, amount, status, purpose, reference_id, hold_tx_id, expires_at, created_at)
         VALUES ($1, $2, 'CR', 100, 'active', 'job', $3, $4, $5, $6)`,
        [holdId, wallet, id(), tx, new Date(clock.nowMs() + 60_000).toISOString(), at()],
      );
      const upd = (set: string): Promise<string> =>
        stateOf(c.query(`UPDATE holds SET ${set} WHERE id = $1`, [holdId]));
      expect(await upd('captured_amount = 60, released_amount = 41')).toBe('23514');
      expect(await upd('amount = 1000')).toBe('BJ005');
      expect(await upd('captured_amount = 30')).toBe('ok');
      expect(await upd('captured_amount = 10')).toBe('BJ005');
      // Finished means fully resolved.
      expect(await upd(`status = 'captured', resolved_at = now()`)).toBe('23514');
      expect(
        await upd(
          `status = 'captured', captured_amount = 60, released_amount = 40, resolved_at = now()`,
        ),
      ).toBe('ok');
      expect(await upd(`status = 'active', resolved_at = NULL`)).toBe('BJ005');
      expect(await stateOf(c.query('DELETE FROM holds'))).toBe('BJ005');
      expect(await stateOf(c.query('TRUNCATE holds CASCADE'))).toBe('BJ002');
    });
  });
});

describe('property: balances always equal the sum of postings', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await openTestDb();
  });
  afterAll(async () => {
    await db.cleanup();
  });

  it('random transfers keep every invariant (seeded)', async () => {
    await db.withClient(async (c) => {
      const accounts = [
        await account(c, 'fx_conversion', 'CR', { allowNegative: true }),
        await account(c, 'buyer_wallet', 'CR'),
        await account(c, 'buyer_hold', 'CR'),
        await account(c, 'platform_revenue', 'CR'),
      ];
      const transfer = fc.record({
        from: fc.integer({ min: 0, max: accounts.length - 1 }),
        to: fc.integer({ min: 0, max: accounts.length - 1 }),
        amount: fc.bigInt({ min: 1n, max: 1_000_000_000_000n }),
        // Sometimes break the sum on purpose: the commit must then fail and change nothing.
        skew: fc.constantFrom(0n, 0n, 0n, 1n),
      });
      await fc.assert(
        fc.asyncProperty(fc.array(transfer, { minLength: 1, maxLength: 4 }), async (batch) => {
          const before = await c.query<{ account_id: string; balance: string }>(
            'SELECT account_id, balance::text FROM account_balances ORDER BY account_id',
          );
          const result = await txn(c, async () => {
            const tx = await ledgerTx(c);
            for (const t of batch) {
              if (t.from === t.to) continue;
              await post(c, tx, accounts[t.from] ?? '', 'CR', -t.amount);
              await post(c, tx, accounts[t.to] ?? '', 'CR', t.amount + t.skew);
            }
          });
          const skewed = batch.some((t) => t.from !== t.to && t.skew !== 0n);
          const empty = batch.every((t) => t.from === t.to);
          // An overdraft (23514) can be detected on a posting before the deferred sum check runs.
          if (empty) expect(result).toBe('BJ001');
          else if (skewed) expect(['BJ001', '23514']).toContain(result);
          else expect(['ok', '23514']).toContain(result);
          const after = await c.query<{ account_id: string; balance: string }>(
            'SELECT account_id, balance::text FROM account_balances ORDER BY account_id',
          );
          if (result !== 'ok') expect(after.rows).toEqual(before.rows);
          const check = await c.query<{ mismatched: number; total: string; negative: number }>(
            `SELECT
               (SELECT count(*)::int FROM account_balances b
                 WHERE b.balance <> (SELECT coalesce(sum(p.amount), 0) FROM ledger_postings p WHERE p.account_id = b.account_id)
                    OR b.version <> (SELECT count(*) FROM ledger_postings p WHERE p.account_id = b.account_id)) AS mismatched,
               (SELECT coalesce(sum(balance), 0)::text FROM account_balances WHERE currency = 'CR') AS total,
               (SELECT count(*)::int FROM account_balances WHERE NOT allow_negative AND balance < 0) AS negative`,
          );
          expect(check.rows[0]).toEqual({ mismatched: 0, total: '0', negative: 0 });
        }),
        { seed: 20261009, numRuns: 40 },
      );
    });
  });
});

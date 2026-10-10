import { isUuidV7, MICRO_CR_PER_CR, uuidV7TimeMs } from '@spareon/shared';
import { createSeededRandom, FakeClock } from '@spareon/testkit';
import { eq, type SQL, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Tx, withTransaction } from '../../src/db/client.js';
import { sqlState } from '../../src/db/errors.js';
import {
  accountBalances,
  earnings,
  ledgerAccounts,
  nodes,
  payoutRecords,
  users,
} from '../../src/db/schema/index.js';
import { isLocalDatabaseUrl, runSeedCli, seedDatabase } from '../../src/db/seed.js';
import { createFactories, type Factories } from '../../src/testing/factories.js';
import { openTestDb, type TestDb } from '../support/db.js';

async function stateOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return sqlState(err) ?? 'no-sqlstate';
  }
}

describe('factories', () => {
  let db: TestDb;
  let clock: FakeClock;
  let f: Factories;
  beforeAll(async () => {
    db = await openTestDb();
    clock = new FakeClock('2026-03-01T00:00:00Z');
    f = createFactories({ db: db.db, clock, random: createSeededRandom('factories') });
  });
  afterAll(async () => {
    await db.cleanup();
  });

  it('creates users of every role with UUIDv7 ids from the injected clock', async () => {
    const [op, owner, buyer] = [await f.operator(), await f.owner(), await f.buyer()];
    expect([op.role, owner.role, buyer.role]).toEqual(['operator', 'owner', 'buyer']);
    for (const u of [op, owner, buyer]) {
      expect(isUuidV7(u.id)).toBe(true);
      expect(uuidV7TimeMs(u.id)).toBe(clock.nowMs());
      expect(u.createdAt.getTime()).toBe(clock.nowMs());
    }
    // Emails are unique case-insensitively.
    expect(await stateOf(f.buyer({ email: op.email.toUpperCase() }))).toBe('23505');
  });

  it('builds the store -> node -> job -> attempt chain with valid defaults', async () => {
    const node = await f.node({ state: 'idle' });
    expect(node.eligible).toBe(true);
    const job = await f.job();
    expect(job.status).toBe('queued');
    const attempt = await f.attempt({ jobId: job.id, nodeId: node.id });
    expect(attempt.status).toBe('running');
    // At most one active attempt per job.
    expect(await stateOf(f.attempt({ jobId: job.id, nodeId: node.id, seq: 1 }))).toBe('23505');
    const quarantined = await f.node({ state: 'quarantined' });
    expect(quarantined.eligible).toBe(false);
    expect(quarantined.quarantinedAt).not.toBeNull();
    // One node per hardware fingerprint per store (ADR 0008).
    expect(
      await stateOf(
        f.node({ storeId: node.storeId, fpStore: node.fpStore, fpGlobal: node.fpGlobal }),
      ),
    ).toBe('23505');
  });

  it('the scheduler query claims the oldest highest-priority job through the partial index', async () => {
    const model = await f.model();
    const pv = await f.priceVersion({ version: 7, entries: [{ modelId: model.id }] });
    const low = await f.job({ modelId: model.id, priceVersionId: pv.id, priority: 0 });
    clock.advance(1_000);
    const high = await f.job({ modelId: model.id, priceVersionId: pv.id, priority: 10 });
    await f.job({ modelId: model.id, priceVersionId: pv.id, status: 'completed' });
    const claim = sql`SELECT id FROM jobs WHERE status = 'queued' AND model_id = ${model.id}
      ORDER BY priority DESC, created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`;
    const first = await db.db.execute<{ id: string }>(claim);
    expect(first.rows[0]?.id).toBe(high.id);
    expect(low.priority).toBe(0);

    // A realistic table: thousands of finished and queued jobs of a busier model, with statistics.
    // The planner must then pick the per-model queue index for the real claim query on its own.
    const other = await f.model();
    const filler = (n: number, modelId: string, status: string): SQL =>
      sql`INSERT INTO jobs (id, buyer_id, kind, currency, model_id, status, params, input_bytes, max_tokens,
            price_version_id, deadline_at, created_at, status_changed_at, ended_at)
          SELECT gen_random_uuid(), ${low.buyerId}, 'chat', 'CR', ${modelId}, ${status}, '{}'::jsonb, 1, 1,
                 ${pv.id}, now() + interval '1 hour', now(), now(),
                 CASE WHEN ${status} = 'completed' THEN now() END
            FROM generate_series(1, ${n})`;
    await db.db.execute(filler(20_000, other.id, 'completed'));
    await db.db.execute(filler(3_000, other.id, 'queued'));
    await db.db.execute(filler(200, model.id, 'completed'));
    await db.db.execute(sql`ANALYZE jobs`);
    const plan = await db.db.execute<{ 'QUERY PLAN': string }>(sql`EXPLAIN ${claim}`);
    expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('jobs_queue_model_idx');
    expect((await db.db.execute<{ id: string }>(claim)).rows[0]?.id).toBe(high.id);
  });

  it('ledger accounts follow ACCOUNT_RULES and entries move balances', async () => {
    const wallet = await f.ledgerAccount({ kind: 'buyer_wallet', currency: 'CR' });
    expect(wallet.ownerType).toBe('user');
    expect(wallet.allowNegative).toBe(false);
    const conv = await f.ledgerAccount({ kind: 'fx_conversion', currency: 'CR', shard: 9 });
    expect(conv.allowNegative).toBe(true);
    await withTransaction(db.db, async (tx) => {
      await createFactories({ db: tx, clock, random: createSeededRandom('entry') }).ledgerEntry({
        kind: 'TEST_TOPUP',
        idempotencyKey: 'test:factory-entry',
        postings: [
          { accountId: conv.id, currency: 'CR', amount: -5n },
          { accountId: wallet.id, currency: 'CR', amount: 5n },
        ],
      });
    });
    const [bal] = await db.db
      .select({ balance: accountBalances.balance })
      .from(accountBalances)
      .where(eq(accountBalances.accountId, wallet.id));
    expect(bal?.balance).toBe(5n);
  });
});

describe('earnings and payout record guards (M10, BJ005)', () => {
  let db: TestDb;
  let clock: FakeClock;
  beforeAll(async () => {
    db = await openTestDb();
    clock = new FakeClock();
  });
  afterAll(async () => {
    await db.cleanup();
  });

  /** A committed balanced ledger entry (earnings and payouts reference their transactions). */
  let shard = 100;
  const entry = async (key: string): Promise<string> =>
    withTransaction(db.db, async (tx: Tx) => {
      const g = createFactories({ db: tx, clock, random: createSeededRandom(key) });
      // Platform accounts are unique per (kind, currency, shard).
      shard++;
      const a = await g.ledgerAccount({ kind: 'fx_conversion', currency: 'CR', shard });
      const b = await g.ledgerAccount({ kind: 'platform_revenue', currency: 'CR', shard });
      return g.ledgerEntry({
        kind: 'TEST_TOPUP',
        idempotencyKey: `test:${key}`,
        postings: [
          { accountId: a.id, currency: 'CR', amount: -1n },
          { accountId: b.id, currency: 'CR', amount: 1n },
        ],
      });
    });

  it('walks pending -> matured -> payout_recorded -> settled and refuses everything else', async () => {
    const f = createFactories({ db: db.db, clock, random: createSeededRandom('earnings') });
    const node = await f.node();
    const job = await f.job({ status: 'completed' });
    const attempt = await f.attempt({ jobId: job.id, nodeId: node.id, status: 'completed' });
    const captureTx = await entry('capture');
    const [earning] = await db.db
      .insert(earnings)
      .values({
        id: f.id(),
        nodeId: node.id,
        storeId: node.storeId,
        jobId: job.id,
        attemptId: attempt.id,
        kind: 'job',
        currency: 'CR',
        amountUcr: 700n,
        status: 'pending',
        maturesAt: new Date(clock.nowMs() + 72 * 3_600_000),
        txId: captureTx,
        createdAt: clock.now(),
        statusChangedAt: clock.now(),
      })
      .returning();
    if (earning === undefined) throw new Error('insert failed');
    const upd = (set: Partial<typeof earnings.$inferInsert>): Promise<string> =>
      stateOf(db.db.update(earnings).set(set).where(eq(earnings.id, earning.id)));

    // Amount and identity never change; a second earning for the same attempt is refused.
    expect(await upd({ amountUcr: 7_000_000n })).toBe('BJ005');
    expect(
      await stateOf(
        db.db.insert(earnings).values({ ...earning, id: f.id(), payoutRecordId: null }),
      ),
    ).toBe('23505');

    const operator = await f.operator();
    const recordTx = await entry('record');
    const [payout] = await db.db
      .insert(payoutRecords)
      .values({
        id: f.id(),
        storeId: node.storeId,
        amountUcr: 700n,
        method: 'manual_bank_transfer',
        status: 'recorded',
        recordedBy: operator.id,
        recordedAt: clock.now(),
        recordTxId: recordTx,
      })
      .returning();
    if (payout === undefined) throw new Error('insert failed');

    // Review fix: records start in their initial state, and node/store/job/attempt/payout agree.
    const base = { ...earning, payoutRecordId: null };
    expect(
      await stateOf(
        db.db.insert(earnings).values({
          ...base,
          id: f.id(),
          status: 'payout_recorded',
          matureTxId: await entry('direct-mature'),
          payoutRecordId: payout.id,
        }),
      ),
    ).toBe('BJ005');
    const elsewhere = await f.node();
    const otherJob = await f.job({ status: 'completed' });
    const otherAttempt = await f.attempt({
      jobId: otherJob.id,
      nodeId: elsewhere.id,
      status: 'completed',
    });
    // An earning claiming another store than its node's.
    expect(
      await stateOf(
        db.db.insert(earnings).values({
          ...base,
          id: f.id(),
          nodeId: elsewhere.id,
          jobId: otherJob.id,
          attemptId: otherAttempt.id,
        }),
      ),
    ).toBe('23503');
    // An earning whose attempt belongs to another node.
    expect(
      await stateOf(
        db.db.insert(earnings).values({
          ...base,
          id: f.id(),
          jobId: otherJob.id,
          attemptId: otherAttempt.id,
        }),
      ),
    ).toBe('23503');
    const otherStorePayout = {
      ...payout,
      id: f.id(),
      storeId: elsewhere.storeId,
      recordTxId: await entry('record-other-store'),
    };
    await db.db.insert(payoutRecords).values(otherStorePayout);
    expect(
      await stateOf(
        db.db.insert(payoutRecords).values({
          ...payout,
          id: f.id(),
          status: 'settled',
          recordTxId: await entry('record-settled'),
          settledAt: clock.now(),
          settledBy: operator.id,
          settleTxId: await entry('settle-direct'),
          krwAmount: 1n,
        }),
      ),
    ).toBe('BJ005');

    // M10: only a matured earning can be linked.
    expect(await upd({ status: 'payout_recorded', payoutRecordId: payout.id })).toBe('BJ005');
    // Matured needs its ledger transaction.
    expect(await upd({ status: 'matured' })).toBe('23514');
    expect(await upd({ status: 'matured', matureTxId: await entry('mature') })).toBe('ok');
    expect(await upd({ matureTxId: await entry('mature-again') })).toBe('BJ005');
    // A payout record of another store cannot take this store's earning.
    expect(await upd({ status: 'payout_recorded', payoutRecordId: otherStorePayout.id })).toBe(
      '23503',
    );
    expect(await upd({ status: 'payout_recorded', payoutRecordId: payout.id })).toBe('ok');
    // The link is set once.
    const other = { ...payout, id: f.id(), recordTxId: await entry('record-2') };
    await db.db.insert(payoutRecords).values(other);
    expect(await upd({ payoutRecordId: other.id })).toBe('BJ005');
    expect(await upd({ status: 'settled' })).toBe('ok');
    expect(await upd({ status: 'clawed_back', clawbackTxId: await entry('claw') })).toBe('BJ005');
    expect(await stateOf(db.db.delete(earnings).where(eq(earnings.id, earning.id)))).toBe('BJ005');

    // Payout records: amount fixed, settled is final, never deleted.
    const updP = (set: Partial<typeof payoutRecords.$inferInsert>): Promise<string> =>
      stateOf(db.db.update(payoutRecords).set(set).where(eq(payoutRecords.id, payout.id)));
    expect(await updP({ amountUcr: 1n })).toBe('BJ005');
    expect(
      await updP({
        status: 'settled',
        settledAt: clock.now(),
        settledBy: operator.id,
        settleTxId: await entry('settle'),
        krwAmount: 980n,
      }),
    ).toBe('ok');
    expect(await updP({ reference: 'edited later' })).toBe('BJ005');
    expect(await stateOf(db.db.delete(payoutRecords).where(eq(payoutRecords.id, payout.id)))).toBe(
      'BJ005',
    );
  });
});

describe('dev seed', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await openTestDb();
  });
  afterAll(async () => {
    await db.cleanup();
  });

  it('seeds once; a second run changes nothing', async () => {
    const clock = new FakeClock();
    const first = await seedDatabase({ url: db.url, clock, random: createSeededRandom('seed') });
    expect(first.status).toBe('seeded');
    const snapshot = async (): Promise<unknown> => ({
      users: (await db.db.select({ n: sql<number>`count(*)::int` }).from(users))[0]?.n,
      nodes: (await db.db.select({ n: sql<number>`count(*)::int` }).from(nodes))[0]?.n,
      accounts: (await db.db.select({ n: sql<number>`count(*)::int` }).from(ledgerAccounts))[0]?.n,
    });
    const before = await snapshot();
    expect(before).toEqual({ users: 3, nodes: 3, accounts: 8 });
    expect(await seedDatabase({ url: db.url, clock })).toEqual({ status: 'already_seeded' });
    expect(await snapshot()).toEqual(before);

    // The buyer's wallet holds the TEST_TOPUP, and every currency still sums to zero.
    const rows = await db.db.execute<{ currency: string; total: string }>(
      sql`SELECT currency, sum(balance)::text AS total FROM account_balances GROUP BY currency ORDER BY currency`,
    );
    expect(rows.rows).toEqual([
      { currency: 'CR', total: '0' },
      { currency: 'KRW', total: '0' },
      { currency: 'TCR', total: '0' },
    ]);
    const wallet = await db.db.execute<{ balance: string }>(
      sql`SELECT b.balance::text AS balance FROM account_balances b
            JOIN ledger_accounts a ON a.id = b.account_id
            JOIN users u ON u.id = a.owner_id
           WHERE u.email = 'buyer@spareon.test' AND a.currency = 'CR'`,
    );
    expect(wallet.rows[0]?.balance).toBe((10n * MICRO_CR_PER_CR).toString());
  });

  it('the CLI refuses non-local databases and reports a second run as a no-op', async () => {
    expect(isLocalDatabaseUrl('postgres://u:p@127.0.0.1:5432/x')).toBe(true);
    expect(isLocalDatabaseUrl('postgres://u:p@localhost/x')).toBe(true);
    expect(isLocalDatabaseUrl('postgres://u:p@db.example.supabase.co:5432/postgres')).toBe(false);
    // Review fix: the target could be decided elsewhere (PGHOST, host= parameter).
    expect(isLocalDatabaseUrl('postgres:///x')).toBe(false);
    expect(isLocalDatabaseUrl('postgres://u:p@localhost/x?host=db.example.com')).toBe(false);
    const io = { out: [] as string[], err: [] as string[] };
    const sink = { out: (l: string) => io.out.push(l), err: (l: string) => io.err.push(l) };
    const remote = await runSeedCli(
      { DATABASE_URL: 'postgres://u:secret-pw@db.example.com/postgres' },
      new FakeClock(),
      sink,
    );
    expect(remote).toBe(2);
    expect(io.err.join('\n')).toContain('non-local');
    expect(io.err.join('\n')).not.toContain('secret-pw');
    expect(await runSeedCli({ DATABASE_URL: db.url }, new FakeClock(), sink)).toBe(0);
    expect(io.out.at(-1)).toBe('already seeded: nothing changed');
  });
});

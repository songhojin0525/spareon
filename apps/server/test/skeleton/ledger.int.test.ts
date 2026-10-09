import { createSeededRandom, FakeClock } from '@binjari/testkit';
import { eq } from 'drizzle-orm';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbHandle, withTransaction } from '../../src/db/client.js';
import { earnings, holds } from '../../src/db/schema/index.js';
import {
  captureJob,
  holdJob,
  InsufficientCreditError,
  releaseJob,
  SKELETON_JOB_PRICE_UCR,
  splitCost,
} from '../../src/ledger/skeleton.js';
import { createIds } from '../../src/lib/ids.js';
import { ensureSkeletonWorld, type SkeletonWorld } from '../../src/skeleton/bootstrap.js';
import { createFactories } from '../../src/testing/factories.js';
import { openTestDb, type TestDb } from '../support/db.js';
import { balanceOf, ledgerBalanced } from '../support/ledger.js';

const CR = 1_000_000n;

describe('skeleton ledger (runs as binjari_app)', () => {
  let testDb: TestDb;
  let app: DbHandle;
  const clock = new FakeClock();
  const random = createSeededRandom('s04-ledger');
  const deps = { clock, ids: createIds(clock, (n) => random.bytes(n)) };
  let world: SkeletonWorld;
  let f: ReturnType<typeof createFactories>;

  beforeAll(async () => {
    testDb = await openTestDb();
    app = createDb({ url: testDb.url, role: 'binjari_app', maxConnections: 4 });
    world = await ensureSkeletonWorld(app.db, deps, { topupCr: 1n });
    f = createFactories({ db: app.db, clock, random });
  });
  afterAll(async () => {
    await app.close();
    await testDb.cleanup();
  });

  /** A running job with an attempt on a node of the dev store (the rows an earning must reference). */
  async function jobWithAttempt() {
    const node = await f.node({ storeId: world.storeId, state: 'running' });
    const job = await f.job({
      buyerId: world.buyerId,
      status: 'running',
      priceVersionId: world.priceVersionId,
    });
    const attempt = await f.attempt({ jobId: job.id, nodeId: node.id, status: 'running' });
    return { job, node, attempt };
  }

  const hold = (jobId: string, amount: bigint) =>
    withTransaction(app.db, (tx) =>
      holdJob(tx, deps, {
        jobId,
        buyerId: world.buyerId,
        currency: 'CR',
        amount,
        expiresAt: new Date(clock.nowMs() + 60_000),
      }),
    );

  it('bootstraps once: the buyer has the top-up and every currency sums to zero', async () => {
    expect(await balanceOf(testDb, 'buyer_wallet', world.buyerId)).toBe(1n * CR);
    expect(await balanceOf(testDb, 'reserve', null, 'KRW')).toBe(1_400n);
    const again = await ensureSkeletonWorld(app.db, deps, { topupCr: 50n });
    expect(again).toEqual(world);
    expect(await balanceOf(testDb, 'buyer_wallet', world.buyerId)).toBe(1n * CR);
    expect(await ledgerBalanced(testDb)).toBe(true);
  });

  it('hold → capture pays the store 70% and the platform 30%, exactly once', async () => {
    const { job, node, attempt } = await jobWithAttempt();
    const before = await balanceOf(testDb, 'buyer_wallet', world.buyerId);
    const { holdId } = await hold(job.id, SKELETON_JOB_PRICE_UCR);
    expect(await balanceOf(testDb, 'buyer_wallet', world.buyerId)).toBe(before - 10_000n);
    expect(await balanceOf(testDb, 'buyer_hold', world.buyerId)).toBe(10_000n);

    const input = {
      jobId: job.id,
      holdId,
      storeId: world.storeId,
      nodeId: node.id,
      attemptId: attempt.id,
    };
    const first = await withTransaction(app.db, (tx) => captureJob(tx, deps, input));
    expect(first).toMatchObject({ cost: 10_000n, storeShare: 7_000n, platformShare: 3_000n });
    // Replays (duplicate completion, a retry after a crash) move nothing.
    expect(await withTransaction(app.db, (tx) => captureJob(tx, deps, input))).toBeNull();
    expect(
      await withTransaction(app.db, (tx) => releaseJob(tx, deps, { jobId: job.id, holdId })),
    ).toBeNull();

    expect(await balanceOf(testDb, 'buyer_hold', world.buyerId)).toBe(0n);
    expect(await balanceOf(testDb, 'store_pending', world.storeId)).toBe(7_000n);
    expect(await balanceOf(testDb, 'platform_revenue', null)).toBe(3_000n);
    const [row] = await app.db.select().from(holds).where(eq(holds.id, holdId));
    expect(row).toMatchObject({ status: 'captured', capturedAmount: 10_000n, releasedAmount: 0n });
    const earned = await app.db.select().from(earnings).where(eq(earnings.jobId, job.id));
    expect(earned).toHaveLength(1);
    expect(earned[0]).toMatchObject({
      status: 'pending',
      amountUcr: 7_000n,
      storeId: world.storeId,
    });
    expect(await ledgerBalanced(testDb)).toBe(true);
  });

  it('hold → release returns everything to the wallet, exactly once', async () => {
    const { job, node, attempt } = await jobWithAttempt();
    const before = await balanceOf(testDb, 'buyer_wallet', world.buyerId);
    const { holdId } = await hold(job.id, 10_000n);
    const released = await withTransaction(app.db, (tx) =>
      releaseJob(tx, deps, { jobId: job.id, holdId }),
    );
    expect(released?.amount).toBe(10_000n);
    expect(
      await withTransaction(app.db, (tx) => releaseJob(tx, deps, { jobId: job.id, holdId })),
    ).toBeNull();
    expect(
      await withTransaction(app.db, (tx) =>
        captureJob(tx, deps, {
          jobId: job.id,
          holdId,
          storeId: world.storeId,
          nodeId: node.id,
          attemptId: attempt.id,
        }),
      ),
    ).toBeNull();
    expect(await balanceOf(testDb, 'buyer_wallet', world.buyerId)).toBe(before);
    expect(await ledgerBalanced(testDb)).toBe(true);
  });

  it('refuses a hold the wallet cannot cover and leaves nothing behind', async () => {
    const { job } = await jobWithAttempt();
    const before = await balanceOf(testDb, 'buyer_wallet', world.buyerId);
    await expect(hold(job.id, before + 1n)).rejects.toBeInstanceOf(InsufficientCreditError);
    expect(await balanceOf(testDb, 'buyer_wallet', world.buyerId)).toBe(before);
    expect(await app.db.select().from(holds).where(eq(holds.referenceId, job.id))).toHaveLength(0);
  });

  it('concurrent holds cannot overdraw: exactly the ones that fit succeed', async () => {
    const before = await balanceOf(testDb, 'buyer_wallet', world.buyerId);
    const amount = before / 3n + 1n; // two fit, the third does not
    const jobsList = await Promise.all([1, 2, 3].map(() => jobWithAttempt()));
    const results = await Promise.allSettled(jobsList.map(({ job }) => hold(job.id, amount)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const reasons = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toBeInstanceOf(InsufficientCreditError);
    expect(await balanceOf(testDb, 'buyer_wallet', world.buyerId)).toBe(before - 2n * amount);
  });
});

describe('splitCost', () => {
  it('store + platform = cost and store = floor(cost × bps / 10000)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.bigInt({ min: 0n, max: 10_000n }),
        (cost, bps) => {
          const { store, platform } = splitCost(cost, bps);
          expect(store + platform).toBe(cost);
          expect(store).toBe((cost * bps) / 10_000n);
          expect(store >= 0n && platform >= 0n).toBe(true);
        },
      ),
      { seed: 20261010, numRuns: 200 },
    );
  });

  it('rejects out-of-range input', () => {
    expect(() => splitCost(-1n, 7_000n)).toThrow(RangeError);
    expect(() => splitCost(1n, 10_001n)).toThrow(RangeError);
  });
});

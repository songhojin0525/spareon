import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { balanceOf, ledgerSums } from '../support/ledger.js';
import { chatBody, type Harness, startHarness, waitFor } from '../support/skeleton.js';

/**
 * S04 acceptance 3: two nodes, twenty requests, one node drops in the middle. Every request ends either
 * completed (charged once) or clearly failed (charged nothing); no double charge; the ledger sums to zero.
 */
describe('E2E: 2 nodes, 20 requests, one node drops mid-way', () => {
  let h: Harness;

  beforeAll(async () => {
    // The default 30 s capacity wait (T19): 20 requests queue behind two (then one) busy nodes.
    h = await startHarness({ topupCr: 10n, scheduler: { queueWaitMs: 30_000 } });
  });
  afterAll(async () => {
    await h.close();
  });

  it('completes or clearly fails every request, with no double charge and a balanced ledger', async () => {
    const a = await h.agent('e2e-a', { behavior: { delayMs: 150 } });
    const b = await h.agent('e2e-b', { behavior: { delayMs: 150 } });

    const responses = Array.from({ length: 20 }, (_, i) =>
      h.chat(chatBody(`request ${String(i)}`)).then(async (res) => ({
        status: res.status,
        body: (await res.json()) as { id?: string; error?: { code: string } },
      })),
    );
    // Drop node A while it is in the middle of a job (no goodbye: like a crash or a pulled cable).
    await waitFor(() => a.stats.completed >= 2 && a.runningAttempts.length === 1, 15_000, 'A busy');
    await a.kill();
    const results = await Promise.all(responses);

    const ok = results.filter((r) => r.status === 200);
    const failed = results.filter((r) => r.status !== 200);
    // Every request has a definite answer: 200, or an error that says nothing was charged.
    for (const f of failed)
      expect(['node_failed', 'no_capacity', 'deadline_exceeded']).toContain(f.body.error?.code);
    // B survives, so in practice every request completes (the dropped job is retried on B).
    expect(failed.map((f) => f.body.error?.code)).toEqual([]);
    expect(ok.length).toBe(20);
    expect(b.stats.completed).toBeGreaterThan(0);

    // The dropped attempt was lost and its job retried elsewhere.
    const lost = await h.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM job_attempts WHERE status = 'lost' AND end_reason = 'connection_lost'`,
    );
    expect(lost[0]?.n).toBe(1);

    // No double charge: one capture per completed job, none for the others.
    const captures = await h.query<{ job_id: string; n: number }>(
      `SELECT j.id AS job_id, count(t.id)::int AS n
         FROM jobs j LEFT JOIN ledger_transactions t
           ON t.kind = 'JOB_CAPTURE' AND t.idempotency_key = 'job:' || j.id || ':capture'
        GROUP BY j.id, j.status`,
    );
    const completedIds = new Set(ok.map((r) => (r.body.id ?? '').replace(/^chatcmpl-/, '')));
    expect(captures).toHaveLength(20);
    for (const c of captures) expect(c.n).toBe(completedIds.has(c.job_id) ? 1 : 0);

    // Nothing left in flight, ledger balanced per currency, money conserved.
    await waitFor(async () => {
      const open = await h.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM job_attempts WHERE status IN ('offered', 'running')`,
      );
      return open[0]?.n === 0;
    });
    const activeHolds = await h.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM holds WHERE status = 'active'`,
    );
    expect(activeHolds[0]?.n).toBe(0);
    const sums = await ledgerSums(h.db);
    for (const total of Object.values(sums)) expect(total).toBe(0n);
    const charged = BigInt(ok.length) * 10_000n;
    expect(await balanceOf(h.db, 'buyer_wallet', h.world.buyerId)).toBe(10_000_000n - charged);
    expect(await balanceOf(h.db, 'store_pending', h.world.storeId)).toBe((charged * 7n) / 10n);
    expect(await balanceOf(h.db, 'platform_revenue', null)).toBe((charged * 3n) / 10n);
  });
});

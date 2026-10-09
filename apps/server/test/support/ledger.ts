import type pg from 'pg';

import type { TestDb } from './db.js';

/** Sum of all postings per currency (M1 across the whole ledger: every value must be 0n). */
export async function ledgerSums(db: TestDb): Promise<Record<string, bigint>> {
  return db.withClient(async (c: pg.Client) => {
    const { rows } = await c.query<{ currency: string; total: string }>(
      'SELECT currency, sum(amount)::text AS total FROM ledger_postings GROUP BY currency',
    );
    return Object.fromEntries(rows.map((r) => [r.currency, BigInt(r.total)]));
  });
}

export async function ledgerBalanced(db: TestDb): Promise<boolean> {
  return Object.values(await ledgerSums(db)).every((v) => v === 0n);
}

/** Balance of one account by kind/owner/currency (0n when the account does not exist yet). */
export async function balanceOf(
  db: TestDb,
  kind: string,
  ownerId: string | null,
  currency = 'CR',
): Promise<bigint> {
  return db.withClient(async (c: pg.Client) => {
    const { rows } = await c.query<{ balance: string }>(
      `SELECT b.balance::text AS balance FROM ledger_accounts a JOIN account_balances b ON b.account_id = a.id
        WHERE a.kind = $1 AND a.owner_id IS NOT DISTINCT FROM $2 AND a.currency = $3 AND a.shard = 0`,
      [kind, ownerId, currency],
    );
    return BigInt(rows[0]?.balance ?? '0');
  });
}

/** Number of ledger transactions of a kind for one job (idempotency keys `job:<jobId>:...`). */
export async function txCountForJob(db: TestDb, jobId: string, kind: string): Promise<number> {
  return db.withClient(async (c: pg.Client) => {
    const { rows } = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_transactions WHERE kind = $1 AND idempotency_key LIKE $2`,
      [kind, `job:${jobId}:%`],
    );
    return rows[0]?.n ?? 0;
  });
}

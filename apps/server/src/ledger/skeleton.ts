/**
 * Minimal ledger calls for the S04 walking skeleton: hold a buyer's credit when a job is created, capture
 * it when the job completes (store share + platform share), release it when the job ends without a
 * result. Every balance change is one double-entry transaction that sums to zero per currency (the DB
 * enforces it, M1) and carries an idempotency key (M7), so a replayed call cannot move money twice.
 *
 * SKELETON(S06): the ledger service replaces this module (transaction kinds with allowed accounts, lock
 * order, maturing, reconciliation). Callers must run these functions inside the DB transaction that also
 * changes the job, so job state and money never disagree.
 */
import { and, eq, isNull } from 'drizzle-orm';

import type { Tx } from '../db/client.js';
import { DbError, toDbError } from '../db/errors.js';
import {
  ACCOUNT_RULES,
  type AccountKind,
  type CreditCurrency,
  type Currency,
  earnings,
  holds,
  ledgerAccounts,
  ledgerPostings,
  ledgerTransactions,
  type LedgerTxKind,
} from '../db/schema/index.js';
import type { Clock } from '../lib/clock.js';
import type { Ids } from '../lib/ids.js';

/** SKELETON(S08): one fixed price per request (0.01 CR) instead of the price list and token counts. */
export const SKELETON_JOB_PRICE_UCR = 10_000n;
/** SKELETON(S08): the store's share of a job's cost in basis points (70%). */
export const SKELETON_NODE_PAYOUT_BPS = 7_000n;
/** Earnings mature 72 hours after capture (T26). Maturing itself is S06. */
const MATURITY_MS = 259_200_000;

export interface LedgerDeps {
  readonly clock: Clock;
  readonly ids: Ids;
}

export class InsufficientCreditError extends Error {
  readonly code = 'insufficient_credit';
  constructor() {
    super('insufficient credit');
    this.name = 'InsufficientCreditError';
  }
}

/** Store share = floor(cost × bps / 10,000), platform share = the rest (ARCHITECTURE 9.3). */
export function splitCost(cost: bigint, payoutBps: bigint): { store: bigint; platform: bigint } {
  if (cost < 0n || payoutBps < 0n || payoutBps > 10_000n)
    throw new RangeError('splitCost: bad input');
  const store = (cost * payoutBps) / 10_000n;
  return { store, platform: cost - store };
}

interface AccountSpec {
  readonly kind: AccountKind;
  /** users.id or stores.id; null for platform accounts. */
  readonly ownerId: string | null;
  readonly currency: Currency;
}

/** Get or create a ledger account (accounts are append-only and unique by kind/owner/currency/shard). */
export async function ensureAccount(tx: Tx, deps: LedgerDeps, spec: AccountSpec): Promise<string> {
  const rule = ACCOUNT_RULES[spec.kind];
  if ((rule.owner === 'platform') !== (spec.ownerId === null)) {
    throw new Error(`ensureAccount: ${spec.kind} owner mismatch`);
  }
  await tx
    .insert(ledgerAccounts)
    .values({
      id: deps.ids.newId(),
      kind: spec.kind,
      ownerType: rule.owner,
      ownerId: spec.ownerId,
      currency: spec.currency,
      allowNegative: rule.negative,
      createdAt: deps.clock.now(),
    })
    .onConflictDoNothing();
  const [row] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.kind, spec.kind),
        eq(ledgerAccounts.ownerType, rule.owner),
        spec.ownerId === null
          ? isNull(ledgerAccounts.ownerId)
          : eq(ledgerAccounts.ownerId, spec.ownerId),
        eq(ledgerAccounts.currency, spec.currency),
        eq(ledgerAccounts.shard, 0),
      ),
    );
  if (row === undefined) throw new Error(`ensureAccount: ${spec.kind} not found after insert`);
  return row.id;
}

export interface Posting {
  readonly accountId: string;
  readonly currency: Currency;
  readonly amount: bigint;
}

/**
 * One ledger transaction. Zero amounts are dropped (the DB rejects them). Postings are inserted in
 * account-id order so concurrent transactions lock balance rows in the same order (no deadlock between
 * a hold and a release of the same buyer).
 */
export async function postEntry(
  tx: Tx,
  deps: LedgerDeps,
  entry: {
    kind: LedgerTxKind;
    idempotencyKey: string;
    memo?: string;
    postings: readonly Posting[];
  },
): Promise<string> {
  const postings = entry.postings
    .filter((p) => p.amount !== 0n)
    .slice()
    .sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
  if (postings.length === 0) throw new Error('postEntry: no postings');
  const txId = deps.ids.newId();
  await tx.insert(ledgerTransactions).values({
    id: txId,
    kind: entry.kind,
    idempotencyKey: entry.idempotencyKey,
    memo: entry.memo ?? null,
    createdAt: deps.clock.now(),
  });
  await tx.insert(ledgerPostings).values(postings.map((p) => ({ txId, ...p })));
  return txId;
}

function isOverdraft(err: unknown): boolean {
  const e = err instanceof DbError ? err : toDbError(err);
  return e.code === 'check_violation' && e.constraint === 'account_balances_non_negative_check';
}

/**
 * JOB_HOLD: buyer wallet → buyer hold, plus the holds row. Throws InsufficientCreditError when the wallet
 * would go negative (the DB CHECK decides, so concurrent requests cannot overdraw). The failed statement
 * aborts the surrounding transaction: callers let it roll back.
 */
export async function holdJob(
  tx: Tx,
  deps: LedgerDeps,
  input: {
    jobId: string;
    buyerId: string;
    currency: CreditCurrency;
    amount: bigint;
    expiresAt: Date;
  },
): Promise<{ holdId: string; txId: string }> {
  if (input.amount <= 0n) throw new RangeError('holdJob: amount must be positive');
  const wallet = await ensureAccount(tx, deps, {
    kind: 'buyer_wallet',
    ownerId: input.buyerId,
    currency: input.currency,
  });
  const holdAccount = await ensureAccount(tx, deps, {
    kind: 'buyer_hold',
    ownerId: input.buyerId,
    currency: input.currency,
  });
  let txId: string;
  try {
    txId = await postEntry(tx, deps, {
      kind: 'JOB_HOLD',
      idempotencyKey: `job:${input.jobId}:hold`,
      postings: [
        { accountId: wallet, currency: input.currency, amount: -input.amount },
        { accountId: holdAccount, currency: input.currency, amount: input.amount },
      ],
    });
  } catch (err) {
    if (isOverdraft(err)) throw new InsufficientCreditError();
    throw err;
  }
  const holdId = deps.ids.newId();
  await tx.insert(holds).values({
    id: holdId,
    // The buyer's hold account: M4 reconciliation = its balance equals the sum of its active holds.
    buyerAccountId: holdAccount,
    currency: input.currency,
    amount: input.amount,
    status: 'active',
    purpose: 'job',
    referenceId: input.jobId,
    holdTxId: txId,
    expiresAt: input.expiresAt,
    createdAt: deps.clock.now(),
  });
  return { holdId, txId };
}

interface ActiveHold {
  id: string;
  buyerAccountId: string;
  currency: CreditCurrency;
  amount: bigint;
}

async function lockActiveHold(tx: Tx, holdId: string): Promise<ActiveHold | undefined> {
  const [row] = await tx
    .select({
      id: holds.id,
      buyerAccountId: holds.buyerAccountId,
      currency: holds.currency,
      amount: holds.amount,
    })
    .from(holds)
    .where(and(eq(holds.id, holdId), eq(holds.status, 'active')))
    .for('update');
  return row;
}

async function ownerOfAccount(tx: Tx, accountId: string): Promise<string> {
  const [row] = await tx
    .select({ ownerId: ledgerAccounts.ownerId })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.id, accountId));
  if (row?.ownerId === null || row?.ownerId === undefined) {
    throw new Error('hold account has no owner');
  }
  return row.ownerId;
}

export interface CaptureResult {
  readonly txId: string;
  readonly cost: bigint;
  readonly storeShare: bigint;
  readonly platformShare: bigint;
  readonly earningId: string;
}

/**
 * JOB_CAPTURE: hold → store pending earnings (store share) + platform revenue (the rest), hold →
 * captured, one pending earning for the attempt. Returns null when the hold is no longer active (already
 * captured or released): the caller's conditional job update must then have failed too.
 */
export async function captureJob(
  tx: Tx,
  deps: LedgerDeps,
  input: { jobId: string; holdId: string; storeId: string; nodeId: string; attemptId: string },
): Promise<CaptureResult | null> {
  const hold = await lockActiveHold(tx, input.holdId);
  if (hold === undefined) return null;
  // SKELETON(S08): cost = the fixed price that was held; the real cost comes from server-counted tokens.
  const cost = hold.amount;
  const { store, platform } = splitCost(cost, SKELETON_NODE_PAYOUT_BPS);
  const storePending = await ensureAccount(tx, deps, {
    kind: 'store_pending',
    ownerId: input.storeId,
    currency: hold.currency,
  });
  const revenue = await ensureAccount(tx, deps, {
    kind: 'platform_revenue',
    ownerId: null,
    currency: hold.currency,
  });
  const txId = await postEntry(tx, deps, {
    kind: 'JOB_CAPTURE',
    idempotencyKey: `job:${input.jobId}:capture`,
    postings: [
      { accountId: hold.buyerAccountId, currency: hold.currency, amount: -cost },
      { accountId: storePending, currency: hold.currency, amount: store },
      { accountId: revenue, currency: hold.currency, amount: platform },
    ],
  });
  const now = deps.clock.now();
  const updated = await tx
    .update(holds)
    .set({ status: 'captured', capturedAmount: cost, resolvedAt: now })
    .where(and(eq(holds.id, hold.id), eq(holds.status, 'active')))
    .returning({ id: holds.id });
  if (updated.length !== 1) throw new Error('captureJob: hold changed under lock');
  const earningId = deps.ids.newId();
  await tx.insert(earnings).values({
    id: earningId,
    nodeId: input.nodeId,
    storeId: input.storeId,
    jobId: input.jobId,
    attemptId: input.attemptId,
    kind: 'job',
    currency: hold.currency,
    amountUcr: store,
    status: 'pending',
    maturesAt: new Date(now.getTime() + MATURITY_MS),
    txId,
    createdAt: now,
    statusChangedAt: now,
  });
  return { txId, cost, storeShare: store, platformShare: platform, earningId };
}

/**
 * JOB_RELEASE: the whole hold goes back to the buyer's wallet, hold → released. Returns null when the
 * hold is not active any more (idempotent: a second release moves nothing).
 */
export async function releaseJob(
  tx: Tx,
  deps: LedgerDeps,
  input: { jobId: string; holdId: string },
): Promise<{ txId: string; amount: bigint } | null> {
  const hold = await lockActiveHold(tx, input.holdId);
  if (hold === undefined) return null;
  const buyerId = await ownerOfAccount(tx, hold.buyerAccountId);
  const wallet = await ensureAccount(tx, deps, {
    kind: 'buyer_wallet',
    ownerId: buyerId,
    currency: hold.currency,
  });
  const txId = await postEntry(tx, deps, {
    kind: 'JOB_RELEASE',
    idempotencyKey: `job:${input.jobId}:release`,
    postings: [
      { accountId: hold.buyerAccountId, currency: hold.currency, amount: -hold.amount },
      { accountId: wallet, currency: hold.currency, amount: hold.amount },
    ],
  });
  const updated = await tx
    .update(holds)
    .set({ status: 'released', releasedAmount: hold.amount, resolvedAt: deps.clock.now() })
    .where(and(eq(holds.id, hold.id), eq(holds.status, 'active')))
    .returning({ id: holds.id });
  if (updated.length !== 1) throw new Error('releaseJob: hold changed under lock');
  return { txId, amount: hold.amount };
}

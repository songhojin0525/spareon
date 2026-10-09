import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { CREDIT_CURRENCIES, int64, oneOf, tstz } from './common.js';
import { nodes, stores } from './fleet.js';
import { jobAttempts, jobs } from './jobs.js';
import { ledgerTransactions } from './ledger.js';
import { users } from './people.js';
import { fxRates } from './pricing.js';

export const EARNING_KINDS = ['job', 'verification'] as const;
/** Earning states (ARCHITECTURE 5.5). */
export const EARNING_STATUSES = [
  'pending',
  'held',
  'matured',
  'under_review',
  'payout_recorded',
  'settled',
  'clawed_back',
] as const;
export type EarningStatus = (typeof EARNING_STATUSES)[number];

export const PAYOUT_STATUSES = ['recorded', 'settled'] as const;
export const PAYOUT_METHODS = ['manual_bank_transfer'] as const;

/**
 * Manual payout RECORDS (CR only). There is no cash-out code: an operator records a bank transfer made
 * outside the system (CLAUDE.md rule 2). Linked earnings carry payout_record_id (M10).
 */
export const payoutRecords = pgTable(
  'payout_records',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id),
    currency: text('currency', { enum: ['CR'] })
      .notNull()
      .default('CR'),
    /** Sum of the linked earnings, µCR. */
    amountUcr: int64('amount_ucr').notNull(),
    /** Won actually sent, filled when settled. */
    krwAmount: int64('krw_amount'),
    fxRateId: uuid('fx_rate_id').references(() => fxRates.id),
    method: text('method', { enum: PAYOUT_METHODS }).notNull(),
    reference: text('reference'),
    status: text('status', { enum: PAYOUT_STATUSES }).notNull(),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => users.id),
    recordedAt: tstz('recorded_at').notNull(),
    recordTxId: uuid('record_tx_id')
      .notNull()
      .references(() => ledgerTransactions.id),
    settledBy: uuid('settled_by').references(() => users.id),
    settledAt: tstz('settled_at'),
    settleTxId: uuid('settle_tx_id').references(() => ledgerTransactions.id),
  },
  (t) => [
    index('payout_records_store_idx').on(t.storeId, t.recordedAt.desc()),
    // Target of earnings (payout_record_id, store_id): a payout record links only its own store's earnings.
    unique('payout_records_id_store_key').on(t.id, t.storeId),
    check('payout_records_currency_check', sql`${t.currency} = 'CR'`),
    check('payout_records_amount_check', sql`${t.amountUcr} > 0`),
    check('payout_records_method_check', oneOf(t.method, PAYOUT_METHODS)),
    check('payout_records_status_check', oneOf(t.status, PAYOUT_STATUSES)),
    check('payout_records_reference_check', sql`char_length(${t.reference}) <= 200`),
    check(
      'payout_records_settled_check',
      sql`(${t.status} = 'settled') = (${t.settledAt} IS NOT NULL)
        AND (${t.settledAt} IS NULL) = (${t.settledBy} IS NULL)
        AND (${t.settledAt} IS NULL) = (${t.settleTxId} IS NULL)
        AND (${t.settledAt} IS NULL) = (${t.krwAmount} IS NULL)
        AND (${t.krwAmount} IS NULL OR ${t.krwAmount} > 0)`,
    ),
  ],
);

/**
 * A node's share of one attempt (or of a verification run). Amount and identity are immutable, a
 * payout link is set once from `matured` and never removed, and clawed_back/settled are final (trigger).
 */
export const earnings = pgTable(
  'earnings',
  {
    id: uuid('id').primaryKey(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => jobAttempts.id),
    kind: text('kind', { enum: EARNING_KINDS }).notNull(),
    currency: text('currency', { enum: CREDIT_CURRENCIES }).notNull(),
    /** Minimal units of `currency` (µCR or µTCR). */
    amountUcr: int64('amount_ucr').notNull(),
    status: text('status', { enum: EARNING_STATUSES }).notNull(),
    maturesAt: tstz('matures_at').notNull(),
    /** The JOB_CAPTURE / VERIFICATION_COST transaction that created the pending earning. */
    txId: uuid('tx_id')
      .notNull()
      .references(() => ledgerTransactions.id),
    matureTxId: uuid('mature_tx_id').references(() => ledgerTransactions.id),
    clawbackTxId: uuid('clawback_tx_id').references(() => ledgerTransactions.id),
    payoutRecordId: uuid('payout_record_id').references((): AnyPgColumn => payoutRecords.id),
    createdAt: tstz('created_at').notNull(),
    statusChangedAt: tstz('status_changed_at').notNull(),
  },
  (t) => [
    // One earning per attempt: a capture replay cannot pay the same attempt twice.
    uniqueIndex('earnings_attempt_key').on(t.attemptId),
    // Consistency the payout and reconciliation code relies on (M10): node, store, job and attempt agree.
    foreignKey({
      name: 'earnings_node_store_fk',
      columns: [t.nodeId, t.storeId],
      foreignColumns: [nodes.id, nodes.storeId],
    }),
    foreignKey({
      name: 'earnings_attempt_job_node_fk',
      columns: [t.attemptId, t.jobId, t.nodeId],
      foreignColumns: [jobAttempts.id, jobAttempts.jobId, jobAttempts.nodeId],
    }),
    foreignKey({
      name: 'earnings_payout_record_store_fk',
      columns: [t.payoutRecordId, t.storeId],
      foreignColumns: [payoutRecords.id, payoutRecords.storeId],
    }),
    index('earnings_store_status_idx').on(t.storeId, t.status),
    index('earnings_node_status_idx').on(t.nodeId, t.status),
    index('earnings_pending_matures_idx')
      .on(t.maturesAt)
      .where(sql`${t.status} = 'pending'`),
    index('earnings_payout_record_idx')
      .on(t.payoutRecordId)
      .where(sql`${t.payoutRecordId} IS NOT NULL`),
    check('earnings_kind_check', oneOf(t.kind, EARNING_KINDS)),
    check('earnings_currency_check', oneOf(t.currency, CREDIT_CURRENCIES)),
    check('earnings_status_check', oneOf(t.status, EARNING_STATUSES)),
    check('earnings_amount_check', sql`${t.amountUcr} > 0`),
    // M10: only CR earnings in payout_recorded/settled carry a payout link, and those always do.
    check(
      'earnings_payout_link_check',
      sql`(${t.status} IN ('payout_recorded', 'settled')) = (${t.payoutRecordId} IS NOT NULL)
        AND (${t.payoutRecordId} IS NULL OR ${t.currency} = 'CR')`,
    ),
    check(
      'earnings_tx_check',
      sql`(${t.status} <> 'clawed_back' OR ${t.clawbackTxId} IS NOT NULL)
        AND (${t.status} NOT IN ('matured', 'under_review', 'payout_recorded', 'settled') OR ${t.matureTxId} IS NOT NULL)`,
    ),
  ],
);

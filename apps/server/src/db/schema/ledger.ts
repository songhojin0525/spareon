import { type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  CREDIT_CURRENCIES,
  CURRENCIES,
  type Currency,
  int64,
  matches,
  oneOf,
  tstz,
  xid8,
} from './common.js';
import { users } from './people.js';
import { fxRates } from './pricing.js';

/**
 * Ledger account kinds (ARCHITECTURE 9.1). For each kind: who owns it, which currencies it may hold
 * (M8: TCR never reaches payout/external/reserve accounts) and whether its balance may go negative
 * (only cost, source and conversion accounts). These rules are CHECK constraints, so a misconfigured
 * account (a buyer wallet allowed to go negative, a TCR reserve) cannot even be created.
 */
export const ACCOUNT_RULES = {
  buyer_wallet: { owner: 'user', currencies: ['CR', 'TCR'], negative: false },
  buyer_hold: { owner: 'user', currencies: ['CR', 'TCR'], negative: false },
  store_pending: { owner: 'store', currencies: ['CR', 'TCR'], negative: false },
  store_matured: { owner: 'store', currencies: ['CR', 'TCR'], negative: false },
  payout_in_progress: { owner: 'store', currencies: ['CR'], negative: false },
  platform_revenue: { owner: 'platform', currencies: ['CR', 'TCR'], negative: false },
  platform_verification: { owner: 'platform', currencies: ['CR', 'TCR'], negative: false },
  external_exchange: { owner: 'platform', currencies: ['CR'], negative: false },
  suspense: { owner: 'platform', currencies: ['CR', 'TCR'], negative: false },
  reserve: { owner: 'platform', currencies: ['KRW'], negative: false },
  external_spend: { owner: 'platform', currencies: ['KRW', 'USD'], negative: true },
  payout_paid: { owner: 'platform', currencies: ['KRW'], negative: true },
  fx_conversion: { owner: 'platform', currencies: ['CR', 'KRW', 'USD'], negative: true },
  test_topup_source: { owner: 'platform', currencies: ['KRW'], negative: true },
  sandbox_issuance: { owner: 'platform', currencies: ['TCR'], negative: true },
} as const satisfies Record<
  string,
  {
    owner: 'user' | 'store' | 'platform';
    currencies: readonly Currency[];
    negative: boolean;
  }
>;
export type AccountKind = keyof typeof ACCOUNT_RULES;
export const ACCOUNT_KINDS = Object.keys(ACCOUNT_RULES) as AccountKind[];
export const ACCOUNT_OWNER_TYPES = ['user', 'store', 'platform'] as const;

function kindsWhere(pred: (rule: (typeof ACCOUNT_RULES)[AccountKind]) => boolean): AccountKind[] {
  return ACCOUNT_KINDS.filter((k) => pred(ACCOUNT_RULES[k]));
}

function accountRuleChecks(t: {
  kind: AnyPgColumn;
  ownerType: AnyPgColumn;
  currency: AnyPgColumn;
  allowNegative: AnyPgColumn;
}): { owner: SQL; currency: SQL; negative: SQL } {
  const owner = sql.join(
    ACCOUNT_OWNER_TYPES.map(
      (o) =>
        sql`(${oneOf(
          t.kind,
          kindsWhere((r) => r.owner === o),
        )} AND ${t.ownerType} = ${sql.raw(`'${o}'`)})`,
    ),
    sql` OR `,
  );
  const currency = sql.join(
    CURRENCIES.map(
      (c) =>
        sql`(${t.currency} = ${sql.raw(`'${c}'`)} AND ${oneOf(
          t.kind,
          kindsWhere((r) => (r.currencies as readonly Currency[]).includes(c)),
        )})`,
    ),
    sql` OR `,
  );
  const negative = sql`NOT ${t.allowNegative} OR ${oneOf(
    t.kind,
    kindsWhere((r) => r.negative),
  )}`;
  return { owner, currency, negative };
}

/** Ledger accounts. Immutable after insert (trigger): flipping allow_negative later would bypass M3. */
export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind', { enum: ACCOUNT_KINDS as [AccountKind, ...AccountKind[]] }).notNull(),
    ownerType: text('owner_type', { enum: ACCOUNT_OWNER_TYPES }).notNull(),
    /** users.id or stores.id depending on owner_type; NULL for platform accounts. No FK: the ledger knows no domains. */
    ownerId: uuid('owner_id'),
    currency: text('currency', { enum: CURRENCIES }).notNull(),
    /** Hot platform accounts can be split into shards later (ARCHITECTURE 8, stage C). */
    shard: smallint('shard').notNull().default(0),
    allowNegative: boolean('allow_negative').notNull().default(false),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => {
    const rules = accountRuleChecks(t);
    return [
      unique('ledger_accounts_identity_key')
        .on(t.kind, t.ownerType, t.ownerId, t.currency, t.shard)
        .nullsNotDistinct(),
      // Targets of the composite foreign keys below (posting currency = account currency, balance sign rule).
      unique('ledger_accounts_id_currency_key').on(t.id, t.currency),
      unique('ledger_accounts_id_currency_negative_key').on(t.id, t.currency, t.allowNegative),
      index('ledger_accounts_owner_idx').on(t.ownerType, t.ownerId),
      check('ledger_accounts_kind_check', oneOf(t.kind, ACCOUNT_KINDS)),
      check('ledger_accounts_owner_type_check', oneOf(t.ownerType, ACCOUNT_OWNER_TYPES)),
      check('ledger_accounts_currency_check', oneOf(t.currency, CURRENCIES)),
      check(
        'ledger_accounts_owner_id_check',
        sql`(${t.ownerType} = 'platform') = (${t.ownerId} IS NULL)`,
      ),
      check('ledger_accounts_shard_check', sql`${t.shard} BETWEEN 0 AND 255`),
      check('ledger_accounts_kind_owner_check', rules.owner),
      check('ledger_accounts_kind_currency_check', rules.currency),
      check('ledger_accounts_negative_check', rules.negative),
    ];
  },
);

/**
 * Transaction kinds known so far (ARCHITECTURE 9.2–9.3). S06 owns the final list and may change this
 * CHECK in its own migration. Money is created only by TEST_TOPUP and SANDBOX_TOPUP (M9).
 */
export const LEDGER_TX_KINDS = [
  'TEST_TOPUP',
  'SANDBOX_TOPUP',
  'JOB_HOLD',
  'JOB_CAPTURE',
  'JOB_RELEASE',
  'HOLD_EXPIRE',
  'EARNING_MATURE',
  'EARNING_CLAWBACK',
  'REFUND',
  'MANUAL_PAYOUT_RECORD',
  'PAYOUT_SETTLED',
  'VERIFICATION_RESERVE',
  'VERIFICATION_COST',
  'VERIFICATION_RELEASE',
  'EXTERNAL_EXCHANGE',
  'REVERSAL',
] as const;
export type LedgerTxKind = (typeof LEDGER_TX_KINDS)[number];

/**
 * Ledger transactions (append-only). Postings of one transaction must sum to zero per currency at
 * commit (deferred constraint triggers) and can only be added in the DB transaction that created it.
 */
export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind', { enum: LEDGER_TX_KINDS }).notNull(),
    /** Every ledger call is idempotent by this key (M7), e.g. `job:<jobId>:capture`. */
    idempotencyKey: text('idempotency_key').notNull().unique('ledger_transactions_idempotency_key'),
    memo: text('memo'),
    /** The transaction this one reverses; a transaction can be reversed at most once. */
    reversesTxId: uuid('reverses_tx_id')
      .references((): AnyPgColumn => ledgerTransactions.id)
      .unique('ledger_transactions_reverses_key'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: tstz('created_at').notNull(),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** FX snapshot used by a cross-currency transaction. */
    fxRateId: uuid('fx_rate_id').references(() => fxRates.id),
    /** Top-level DB transaction that inserted the row; set by a trigger (not writable by the app). */
    createdXid: xid8('created_xid')
      .notNull()
      .default(sql`pg_current_xact_id()`),
  },
  (t) => [
    index('ledger_transactions_created_idx').on(t.createdAt),
    check('ledger_transactions_kind_check', oneOf(t.kind, LEDGER_TX_KINDS)),
    check(
      'ledger_transactions_idempotency_key_check',
      matches(t.idempotencyKey, '^[\\x21-\\x7e]{1,200}$'),
    ),
    check('ledger_transactions_memo_check', sql`char_length(${t.memo}) <= 500`),
    check('ledger_transactions_metadata_check', sql`pg_column_size(${t.metadata}) <= 4096`),
    check('ledger_transactions_reverses_check', sql`${t.reversesTxId} <> ${t.id}`),
  ],
);

/**
 * Ledger postings (append-only). Signed amount in minimal units of `currency`, which must equal the
 * account's currency (composite FK). Inserting a posting updates account_balances (trigger).
 * bigint identity id: ordering inside a transaction matters (the balance check runs on the last one).
 */
export const ledgerPostings = pgTable(
  'ledger_postings',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    txId: uuid('tx_id')
      .notNull()
      .references(() => ledgerTransactions.id),
    accountId: uuid('account_id').notNull(),
    currency: text('currency', { enum: CURRENCIES }).notNull(),
    amount: int64('amount').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'ledger_postings_account_currency_fk',
      columns: [t.accountId, t.currency],
      foreignColumns: [ledgerAccounts.id, ledgerAccounts.currency],
    }),
    index('ledger_postings_tx_idx').on(t.txId, t.id),
    index('ledger_postings_account_idx').on(t.accountId, t.id),
    check('ledger_postings_amount_check', sql`${t.amount} <> 0`),
  ],
);

/**
 * Current balance per account: a cache of SUM(postings), maintained only by the posting trigger
 * (direct writes are rejected). allow_negative is copied from the account through a composite FK so the
 * sign rule (M3) is a plain CHECK that fires the moment a posting would overdraw the account.
 */
export const accountBalances = pgTable(
  'account_balances',
  {
    accountId: uuid('account_id').primaryKey(),
    currency: text('currency', { enum: CURRENCIES }).notNull(),
    allowNegative: boolean('allow_negative').notNull(),
    balance: int64('balance')
      .notNull()
      .default(sql`0`),
    /** Increments with every posting (optimistic checks, cache invalidation). */
    version: int64('version')
      .notNull()
      .default(sql`0`),
  },
  (t) => [
    foreignKey({
      name: 'account_balances_account_fk',
      columns: [t.accountId, t.currency, t.allowNegative],
      foreignColumns: [ledgerAccounts.id, ledgerAccounts.currency, ledgerAccounts.allowNegative],
    }),
    check('account_balances_non_negative_check', sql`${t.allowNegative} OR ${t.balance} >= 0`),
    check('account_balances_version_check', sql`${t.version} >= 0`),
  ],
);

export const HOLD_STATUSES = ['active', 'captured', 'released', 'expired'] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];
/** What a hold is for. The ledger does not reference domain tables; (purpose, reference_id) is unique. */
export const HOLD_PURPOSES = ['job', 'batch', 'external'] as const;

/**
 * Credit holds (ARCHITECTURE 5.4). captured + released never exceeds amount (M6) and a finished hold is
 * fully resolved. Amounts only grow and a finished hold never reopens (trigger).
 */
export const holds = pgTable(
  'holds',
  {
    id: uuid('id').primaryKey(),
    buyerAccountId: uuid('buyer_account_id').notNull(),
    currency: text('currency', { enum: CREDIT_CURRENCIES }).notNull(),
    amount: int64('amount').notNull(),
    capturedAmount: int64('captured_amount')
      .notNull()
      .default(sql`0`),
    releasedAmount: int64('released_amount')
      .notNull()
      .default(sql`0`),
    status: text('status', { enum: HOLD_STATUSES }).notNull(),
    purpose: text('purpose', { enum: HOLD_PURPOSES }).notNull(),
    referenceId: uuid('reference_id').notNull(),
    holdTxId: uuid('hold_tx_id')
      .notNull()
      .references(() => ledgerTransactions.id),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: tstz('created_at').notNull(),
    resolvedAt: tstz('resolved_at'),
  },
  (t) => [
    foreignKey({
      name: 'holds_buyer_account_fk',
      columns: [t.buyerAccountId, t.currency],
      foreignColumns: [ledgerAccounts.id, ledgerAccounts.currency],
    }),
    unique('holds_purpose_reference_key').on(t.purpose, t.referenceId),
    index('holds_buyer_account_idx').on(t.buyerAccountId),
    index('holds_active_expires_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'active'`),
    check('holds_currency_check', oneOf(t.currency, CREDIT_CURRENCIES)),
    check('holds_status_check', oneOf(t.status, HOLD_STATUSES)),
    check('holds_purpose_check', oneOf(t.purpose, HOLD_PURPOSES)),
    check(
      'holds_amounts_check',
      sql`${t.amount} > 0 AND ${t.capturedAmount} >= 0 AND ${t.releasedAmount} >= 0
        AND ${t.capturedAmount} + ${t.releasedAmount} <= ${t.amount}`,
    ),
    check(
      'holds_resolved_check',
      sql`(${t.status} = 'active') = (${t.resolvedAt} IS NULL)
        AND (${t.status} = 'active' OR ${t.capturedAmount} + ${t.releasedAmount} = ${t.amount})`,
    ),
    check('holds_expiry_check', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

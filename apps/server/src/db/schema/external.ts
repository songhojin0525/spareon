import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { CREDIT_CURRENCIES, int64, oneOf, tstz } from './common.js';
import { jobs } from './jobs.js';
import { apiKeys, users } from './people.js';
import { models } from './registry.js';

export const EXTERNAL_USAGE_STATUSES = ['pending', 'settled', 'unconfirmed', 'failed'] as const;

/**
 * External model calls (S16): metadata only — the request and response content is never stored here
 * (ADR 0010). TCR calls are always mocked (D12).
 */
export const externalUsage = pgTable(
  'external_usage',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id').references(() => jobs.id),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => users.id),
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id),
    modelId: uuid('model_id')
      .notNull()
      .references(() => models.id),
    provider: text('provider').notNull(),
    currency: text('currency', { enum: CREDIT_CURRENCIES }).notNull(),
    /** true = answered by the mock adapter, no real provider call. */
    mock: boolean('mock').notNull(),
    status: text('status', { enum: EXTERNAL_USAGE_STATUSES }).notNull(),
    providerRequestId: text('provider_request_id'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    /** Provider cost in µUSD (estimated when unconfirmed). */
    costUusd: int64('cost_uusd'),
    /** Credits charged, minimal units of `currency`. */
    costUcr: int64('cost_ucr'),
    startedAt: tstz('started_at').notNull(),
    endedAt: tstz('ended_at'),
  },
  (t) => [
    index('external_usage_buyer_started_idx').on(t.buyerId, t.startedAt.desc()),
    index('external_usage_started_idx').on(t.startedAt),
    check('external_usage_currency_check', oneOf(t.currency, CREDIT_CURRENCIES)),
    check('external_usage_status_check', oneOf(t.status, EXTERNAL_USAGE_STATUSES)),
    // D12: sandbox credit never pays for a real provider call.
    check('external_usage_tcr_mock_check', sql`${t.currency} = 'CR' OR ${t.mock}`),
    check('external_usage_provider_check', sql`${t.provider} ~ '^[a-z][a-z0-9_]{0,31}$'`),
    check('external_usage_request_id_check', sql`char_length(${t.providerRequestId}) <= 200`),
    check(
      'external_usage_amounts_check',
      sql`(${t.tokensIn} IS NULL OR ${t.tokensIn} >= 0) AND (${t.tokensOut} IS NULL OR ${t.tokensOut} >= 0)
        AND (${t.costUusd} IS NULL OR ${t.costUusd} >= 0) AND (${t.costUcr} IS NULL OR ${t.costUcr} >= 0)`,
    ),
    check('external_usage_ended_check', sql`(${t.status} = 'pending') = (${t.endedAt} IS NULL)`),
  ],
);

export const RESERVATION_STATUSES = ['active', 'settled', 'released'] as const;

/**
 * Reserve reservations for external exchange (ARCHITECTURE 9.4): KRW does not move until settlement, so
 * the reserve guard subtracts the sum of active reservations.
 */
export const reserveReservations = pgTable(
  'reserve_reservations',
  {
    id: uuid('id').primaryKey(),
    externalUsageId: uuid('external_usage_id')
      .notNull()
      .references(() => externalUsage.id),
    amountKrw: int64('amount_krw').notNull(),
    status: text('status', { enum: RESERVATION_STATUSES }).notNull(),
    createdAt: tstz('created_at').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    resolvedAt: tstz('resolved_at'),
  },
  (t) => [
    uniqueIndex('reserve_reservations_usage_key').on(t.externalUsageId),
    index('reserve_reservations_active_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'active'`),
    check('reserve_reservations_status_check', oneOf(t.status, RESERVATION_STATUSES)),
    check('reserve_reservations_amount_check', sql`${t.amountKrw} > 0`),
    check(
      'reserve_reservations_resolved_check',
      sql`(${t.status} = 'active') = (${t.resolvedAt} IS NULL)`,
    ),
    check('reserve_reservations_expiry_check', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

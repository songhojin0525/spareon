import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';

import { int64, tstz } from './common.js';
import { users } from './people.js';
import { models } from './registry.js';

/**
 * Price list versions. Append-only (trigger): a job fixes its price version at creation, so editing a
 * version would change how past jobs were billed. Price changes are new versions.
 */
export const priceVersions = pgTable(
  'price_versions',
  {
    id: uuid('id').primaryKey(),
    version: integer('version').notNull().unique('price_versions_version_key'),
    notes: text('notes'),
    effectiveAt: tstz('effective_at').notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => [
    index('price_versions_effective_idx').on(t.effectiveAt),
    check('price_versions_version_check', sql`${t.version} >= 1`),
    check('price_versions_notes_check', sql`char_length(${t.notes}) <= 1000`),
  ],
);

/** Per-model prices inside a version (append-only). Same list for CR and TCR (ADR 0005). */
export const priceEntries = pgTable(
  'price_entries',
  {
    priceVersionId: uuid('price_version_id')
      .notNull()
      .references(() => priceVersions.id),
    modelId: uuid('model_id')
      .notNull()
      .references(() => models.id),
    /** µCR per 1,000,000 input tokens. */
    inputUcrPerMtok: int64('input_ucr_per_mtok').notNull(),
    /** µCR per 1,000,000 output tokens. */
    outputUcrPerMtok: int64('output_ucr_per_mtok').notNull(),
    /** Node share of the job cost in basis points (0..10,000). */
    nodePayoutBps: integer('node_payout_bps').notNull(),
    /** External provider cost in µUSD per 1,000,000 tokens (external models only). */
    providerCostUusdPerMtokIn: int64('provider_cost_uusd_per_mtok_in'),
    providerCostUusdPerMtokOut: int64('provider_cost_uusd_per_mtok_out'),
  },
  (t) => [
    primaryKey({ name: 'price_entries_pkey', columns: [t.priceVersionId, t.modelId] }),
    index('price_entries_model_idx').on(t.modelId),
    check(
      'price_entries_prices_check',
      sql`${t.inputUcrPerMtok} >= 0 AND ${t.outputUcrPerMtok} >= 0`,
    ),
    check('price_entries_payout_bps_check', sql`${t.nodePayoutBps} BETWEEN 0 AND 10000`),
    check(
      'price_entries_provider_cost_check',
      sql`(${t.providerCostUusdPerMtokIn} IS NULL OR ${t.providerCostUusdPerMtokIn} >= 0)
        AND (${t.providerCostUusdPerMtokOut} IS NULL OR ${t.providerCostUusdPerMtokOut} >= 0)`,
    ),
  ],
);

/**
 * Exchange-rate snapshots (append-only). `rate_micros` = units of the quote currency per one unit of
 * the base currency, times 1,000,000. Example: pair USD/KRW, rate_micros 1_380_000_000 = 1,380 KRW per USD.
 */
export const fxRates = pgTable(
  'fx_rates',
  {
    id: uuid('id').primaryKey(),
    pair: text('pair').notNull(),
    rateMicros: int64('rate_micros').notNull(),
    source: text('source').notNull(),
    effectiveAt: tstz('effective_at').notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => [
    index('fx_rates_pair_effective_idx').on(t.pair, t.effectiveAt.desc()),
    check('fx_rates_pair_check', sql`${t.pair} ~ '^[A-Z]{3}/[A-Z]{3}$'`),
    check('fx_rates_rate_check', sql`${t.rateMicros} > 0`),
    check('fx_rates_source_check', sql`char_length(${t.source}) BETWEEN 1 AND 100`),
  ],
);

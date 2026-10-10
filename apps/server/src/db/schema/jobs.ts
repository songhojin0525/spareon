import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  bytea,
  CREDIT_CURRENCIES,
  HEX32_RE,
  int64,
  KEY_ID_RE,
  matches,
  oneOf,
  tstz,
} from './common.js';
import { nodes } from './fleet.js';
import { holds } from './ledger.js';
import { apiKeys, users } from './people.js';
import { priceVersions } from './pricing.js';
import { models } from './registry.js';

export const BATCH_STATUSES = [
  'validating',
  'queued',
  'running',
  'completed',
  'failed',
  'canceled',
  'expired',
] as const;

/** Batch requests (S15): one JSONL upload split into batch_item jobs that share one hold. */
export const batches = pgTable(
  'batches',
  {
    id: uuid('id').primaryKey(),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => users.id),
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id),
    modelId: uuid('model_id')
      .notNull()
      .references(() => models.id),
    currency: text('currency', { enum: CREDIT_CURRENCIES }).notNull(),
    status: text('status', { enum: BATCH_STATUSES }).notNull(),
    priceVersionId: uuid('price_version_id')
      .notNull()
      .references(() => priceVersions.id),
    holdId: uuid('hold_id').references(() => holds.id),
    itemCount: integer('item_count').notNull().default(0),
    completedCount: integer('completed_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    deadlineAt: tstz('deadline_at').notNull(),
    createdAt: tstz('created_at').notNull(),
    endedAt: tstz('ended_at'),
  },
  (t) => [
    index('batches_buyer_created_idx').on(t.buyerId, t.createdAt.desc()),
    check('batches_currency_check', oneOf(t.currency, CREDIT_CURRENCIES)),
    check('batches_status_check', oneOf(t.status, BATCH_STATUSES)),
    check(
      'batches_counts_check',
      sql`${t.itemCount} >= 0 AND ${t.completedCount} >= 0 AND ${t.failedCount} >= 0
        AND ${t.completedCount} + ${t.failedCount} <= ${t.itemCount}`,
    ),
    check(
      'batches_ended_check',
      sql`(${t.status} IN ('completed', 'failed', 'canceled', 'expired')) = (${t.endedAt} IS NOT NULL)`,
    ),
    check('batches_deadline_check', sql`${t.deadlineAt} > ${t.createdAt}`),
  ],
);

export const BATCH_FILE_KINDS = ['input', 'output', 'errors'] as const;

/** Batch files: AES-256-GCM ciphertext only, either inline or in object storage; deleted at expires_at (ADR 0010). */
export const batchFiles = pgTable(
  'batch_files',
  {
    id: uuid('id').primaryKey(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => batches.id),
    kind: text('kind', { enum: BATCH_FILE_KINDS }).notNull(),
    ciphertext: bytea('ciphertext'),
    storageKey: text('storage_key'),
    /** Encryption key id (DATA_ENCRYPTION_KEY rotation). */
    keyId: text('key_id').notNull(),
    plaintextBytes: int64('plaintext_bytes').notNull(),
    lineCount: integer('line_count').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => [
    unique('batch_files_batch_kind_key').on(t.batchId, t.kind),
    index('batch_files_expires_idx').on(t.expiresAt),
    check('batch_files_kind_check', oneOf(t.kind, BATCH_FILE_KINDS)),
    check(
      'batch_files_location_check',
      sql`(${t.ciphertext} IS NULL) <> (${t.storageKey} IS NULL)
        AND (${t.ciphertext} IS NULL OR octet_length(${t.ciphertext}) >= 28)
        AND char_length(${t.storageKey}) <= 512`,
    ),
    check('batch_files_key_id_check', matches(t.keyId, KEY_ID_RE)),
    check('batch_files_sizes_check', sql`${t.plaintextBytes} >= 0 AND ${t.lineCount} >= 0`),
  ],
);

export const JOB_KINDS = ['chat', 'batch_item', 'canary', 'verification'] as const;
export type JobKind = (typeof JOB_KINDS)[number];
/** Job states (ARCHITECTURE 5.2). */
export const JOB_STATUSES = [
  'queued',
  'offered',
  'running',
  'completed',
  'failed',
  'canceled',
  'expired',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const JOB_RETENTIONS = ['default', 'none'] as const;

/**
 * Inference jobs — also the work queue (ADR 0002). Holds metadata only: buyer content lives encrypted
 * in job_payloads (ADR 0010). Canary/verification jobs are platform jobs without a buyer.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey(),
    buyerId: uuid('buyer_id').references(() => users.id),
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id),
    kind: text('kind', { enum: JOB_KINDS }).notNull(),
    /** Billing currency (CR or sandbox TCR; D14 restricts where TCR jobs run). */
    currency: text('currency', { enum: CREDIT_CURRENCIES }).notNull(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => models.id),
    status: text('status', { enum: JOB_STATUSES }).notNull(),
    /** Higher = more urgent (-100..100). */
    priority: smallint('priority').notNull().default(0),
    stream: boolean('stream').notNull().default(false),
    /** Sampling parameters and the server-chosen seed (ADR 0007). Never prompt text. */
    params: jsonb('params').notNull(),
    /** `none` = do not keep the result after delivery (x-spareon-retention, ADR 0010). */
    retention: text('retention', { enum: JOB_RETENTIONS }).notNull().default('default'),
    inputBytes: integer('input_bytes').notNull(),
    maxTokens: integer('max_tokens').notNull(),
    priceVersionId: uuid('price_version_id')
      .notNull()
      .references(() => priceVersions.id),
    holdId: uuid('hold_id').references(() => holds.id),
    batchId: uuid('batch_id').references(() => batches.id),
    batchLine: integer('batch_line'),
    /** Verification jobs point at the job they re-run. */
    parentJobId: uuid('parent_job_id').references((): AnyPgColumn => jobs.id),
    deadlineAt: tstz('deadline_at').notNull(),
    /** Retry and continuation counters (T23). */
    attempts: smallint('attempts').notNull().default(0),
    continuations: smallint('continuations').notNull().default(0),
    /** Server-counted billing tokens (ADR 0009); tokens_out = output delivered to the buyer. */
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    /** Captured cost in minimal units of `currency` (µCR or µTCR). */
    costUcr: int64('cost_ucr'),
    failureCode: text('failure_code'),
    createdAt: tstz('created_at').notNull(),
    statusChangedAt: tstz('status_changed_at').notNull(),
    /** When the job reached a final state (completed, failed, canceled, expired). */
    endedAt: tstz('ended_at'),
  },
  (t) => [
    // The queue (ADR 0002): SELECT ... WHERE status = 'queued' ORDER BY priority DESC, created_at FOR UPDATE SKIP LOCKED.
    // Claim for one model (a node serves the model it has loaded): same order within the model.
    index('jobs_queue_model_idx')
      .on(t.modelId, t.priority.desc(), t.createdAt, t.id)
      .where(sql`${t.status} = 'queued'`),
    index('jobs_queue_idx')
      .on(t.priority.desc(), t.createdAt, t.id)
      .where(sql`${t.status} = 'queued'`),
    // Deadline sweeper over unfinished jobs.
    index('jobs_active_deadline_idx')
      .on(t.deadlineAt)
      .where(sql`${t.status} IN ('queued', 'offered', 'running')`),
    index('jobs_buyer_created_idx').on(t.buyerId, t.createdAt.desc()),
    index('jobs_parent_idx')
      .on(t.parentJobId)
      .where(sql`${t.parentJobId} IS NOT NULL`),
    index('jobs_hold_idx').on(t.holdId),
    unique('jobs_batch_line_key').on(t.batchId, t.batchLine),
    check('jobs_kind_check', oneOf(t.kind, JOB_KINDS)),
    check('jobs_currency_check', oneOf(t.currency, CREDIT_CURRENCIES)),
    check('jobs_status_check', oneOf(t.status, JOB_STATUSES)),
    check('jobs_retention_check', oneOf(t.retention, JOB_RETENTIONS)),
    check(
      'jobs_buyer_check',
      sql`(${t.kind} IN ('chat', 'batch_item')) = (${t.buyerId} IS NOT NULL)
        AND (${t.apiKeyId} IS NULL OR ${t.buyerId} IS NOT NULL)`,
    ),
    check(
      'jobs_batch_check',
      sql`(${t.kind} = 'batch_item') = (${t.batchId} IS NOT NULL)
        AND (${t.batchId} IS NULL) = (${t.batchLine} IS NULL)
        AND (${t.batchLine} IS NULL OR ${t.batchLine} >= 0)`,
    ),
    check(
      'jobs_parent_check',
      sql`(${t.kind} <> 'verification' OR ${t.parentJobId} IS NOT NULL) AND ${t.parentJobId} <> ${t.id}`,
    ),
    check('jobs_priority_check', sql`${t.priority} BETWEEN -100 AND 100`),
    check(
      'jobs_sizes_check',
      sql`${t.inputBytes} >= 0 AND ${t.maxTokens} > 0
        AND ${t.attempts} >= 0 AND ${t.continuations} >= 0
        AND (${t.tokensIn} IS NULL OR ${t.tokensIn} >= 0)
        AND (${t.tokensOut} IS NULL OR ${t.tokensOut} >= 0)
        AND (${t.costUcr} IS NULL OR ${t.costUcr} >= 0)`,
    ),
    check('jobs_params_check', sql`pg_column_size(${t.params}) <= 4096`),
    check(
      'jobs_failure_code_check',
      sql`${t.failureCode} IS NULL OR ${t.failureCode} ~ '^[a-z][a-z0-9_.]{0,63}$'`,
    ),
    check(
      'jobs_ended_check',
      sql`(${t.status} IN ('completed', 'failed', 'canceled', 'expired')) = (${t.endedAt} IS NOT NULL)`,
    ),
    check('jobs_deadline_check', sql`${t.deadlineAt} > ${t.createdAt}`),
  ],
);

/** Attempt states (ARCHITECTURE 5.3). */
export const ATTEMPT_STATUSES = [
  'offered',
  'running',
  'completed',
  'failed',
  'preempted',
  'rejected',
  'timed_out',
  'canceled',
  'lost',
  'superseded',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export const ACTIVE_ATTEMPT_STATUSES = ['offered', 'running'] as const;

/** One run of a job on one node. A job has at most one active (offered/running) attempt. */
export const jobAttempts = pgTable(
  'job_attempts',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id),
    /** 0, 1, 2 ... within the job. */
    seq: smallint('seq').notNull(),
    status: text('status', { enum: ATTEMPT_STATUSES }).notNull(),
    offeredAt: tstz('offered_at').notNull(),
    acceptedAt: tstz('accepted_at'),
    leaseExpiresAt: tstz('lease_expires_at'),
    lastProgressAt: tstz('last_progress_at'),
    endedAt: tstz('ended_at'),
    endReason: text('end_reason'),
    /** Node-reported token counts (cross-check only, ADR 0009). */
    reportedTokensIn: integer('reported_tokens_in'),
    reportedTokensOut: integer('reported_tokens_out'),
    /** Server-counted output tokens this attempt delivered to the buyer (continuation split, 9.3). */
    deliveredTokensOut: integer('delivered_tokens_out').notNull().default(0),
    outputSha256: text('output_sha256'),
    timings: jsonb('timings'),
    continuationOfAttemptId: uuid('continuation_of_attempt_id').references(
      (): AnyPgColumn => jobAttempts.id,
    ),
  },
  (t) => [
    unique('job_attempts_job_seq_key').on(t.jobId, t.seq),
    // Target of earnings (attempt_id, job_id, node_id): an earning matches its attempt's job and node.
    unique('job_attempts_id_job_node_key').on(t.id, t.jobId, t.nodeId),
    uniqueIndex('job_attempts_one_active_key')
      .on(t.jobId)
      .where(sql`${t.status} IN ('offered', 'running')`),
    index('job_attempts_node_active_idx')
      .on(t.nodeId)
      .where(sql`${t.status} IN ('offered', 'running')`),
    // Offer-timeout sweeper (T-budget for unanswered offers, S12).
    index('job_attempts_offered_sweep_idx')
      .on(t.offeredAt)
      .where(sql`${t.status} = 'offered'`),
    index('job_attempts_lease_idx')
      .on(t.leaseExpiresAt)
      .where(sql`${t.status} = 'running'`),
    index('job_attempts_node_offered_idx').on(t.nodeId, t.offeredAt.desc()),
    check('job_attempts_status_check', oneOf(t.status, ATTEMPT_STATUSES)),
    check('job_attempts_seq_check', sql`${t.seq} >= 0`),
    check(
      'job_attempts_active_check',
      sql`(${t.status} IN ('offered', 'running')) = (${t.endedAt} IS NULL)`,
    ),
    check(
      'job_attempts_running_check',
      sql`${t.status} <> 'running' OR (${t.acceptedAt} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)`,
    ),
    check(
      'job_attempts_tokens_check',
      sql`${t.deliveredTokensOut} >= 0
        AND (${t.reportedTokensIn} IS NULL OR ${t.reportedTokensIn} >= 0)
        AND (${t.reportedTokensOut} IS NULL OR ${t.reportedTokensOut} >= 0)`,
    ),
    check(
      'job_attempts_output_sha256_check',
      sql`${t.outputSha256} IS NULL OR ${t.outputSha256} ~ '${sql.raw(HEX32_RE)}'`,
    ),
    check(
      'job_attempts_end_reason_check',
      sql`${t.endReason} IS NULL OR ${t.endReason} ~ '^[a-z][a-z0-9_.]{0,63}$'`,
    ),
    check(
      'job_attempts_timings_check',
      sql`${t.timings} IS NULL OR pg_column_size(${t.timings}) <= 2048`,
    ),
    check('job_attempts_continuation_check', sql`${t.continuationOfAttemptId} <> ${t.id}`),
  ],
);

export const JOB_PAYLOAD_KINDS = ['input', 'output', 'continuation_prefix'] as const;

/**
 * Buyer content of a job (prompt, output, continuation prefix) — AES-256-GCM ciphertext only, with a
 * deadline after which the retention job deletes the row (ADR 0010, ARCHITECTURE 6).
 */
export const jobPayloads = pgTable(
  'job_payloads',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    kind: text('kind', { enum: JOB_PAYLOAD_KINDS }).notNull(),
    /** nonce ‖ ciphertext ‖ tag. */
    ciphertext: bytea('ciphertext').notNull(),
    keyId: text('key_id').notNull(),
    plaintextBytes: integer('plaintext_bytes').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => [
    unique('job_payloads_job_kind_key').on(t.jobId, t.kind),
    index('job_payloads_expires_idx').on(t.expiresAt),
    check('job_payloads_kind_check', oneOf(t.kind, JOB_PAYLOAD_KINDS)),
    // At least a 12-byte nonce and a 16-byte tag: an empty or plaintext-looking blob is rejected.
    check('job_payloads_ciphertext_check', sql`octet_length(${t.ciphertext}) >= 28`),
    check('job_payloads_key_id_check', matches(t.keyId, KEY_ID_RE)),
    check('job_payloads_size_check', sql`${t.plaintextBytes} >= 0`),
  ],
);

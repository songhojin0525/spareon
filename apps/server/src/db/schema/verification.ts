import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { CODE_RE, HEX32_RE, matches, oneOf, tstz } from './common.js';
import { nodes } from './fleet.js';
import { jobAttempts, jobs } from './jobs.js';

export const VERIFICATION_KINDS = ['canary', 'redundancy', 'fingerprint'] as const;
export const VERDICTS = ['pass', 'fail', 'inconclusive'] as const;

/**
 * Verification of one attempt (ADR 0007, D17: the sample unit is the attempt). Scores are parts per
 * million; compared outputs are not stored, only hashes and scores (ADR 0010).
 */
export const verifications = pgTable(
  'verifications',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    kind: text('kind', { enum: VERIFICATION_KINDS }).notNull(),
    subjectAttemptId: uuid('subject_attempt_id')
      .notNull()
      .references(() => jobAttempts.id),
    referenceAttemptId: uuid('reference_attempt_id').references(() => jobAttempts.id),
    expectedSha256: text('expected_sha256'),
    method: text('method').notNull(),
    scorePpm: integer('score_ppm'),
    /** NULL while pending. */
    verdict: text('verdict', { enum: VERDICTS }),
    adjudicatedAt: tstz('adjudicated_at'),
    details: jsonb('details')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: tstz('created_at').notNull(),
    /** T25: judge by this time or settle as inconclusive. */
    deadlineAt: tstz('deadline_at').notNull(),
  },
  (t) => [
    index('verifications_subject_idx').on(t.subjectAttemptId),
    index('verifications_job_idx').on(t.jobId),
    index('verifications_pending_idx')
      .on(t.deadlineAt)
      .where(sql`${t.verdict} IS NULL`),
    check('verifications_kind_check', oneOf(t.kind, VERIFICATION_KINDS)),
    check(
      'verifications_verdict_check',
      sql`${t.verdict} IS NULL OR ${oneOf(t.verdict, VERDICTS)}`,
    ),
    check(
      'verifications_adjudicated_check',
      sql`(${t.verdict} IS NULL) = (${t.adjudicatedAt} IS NULL)`,
    ),
    check('verifications_method_check', matches(t.method, CODE_RE)),
    check(
      'verifications_score_check',
      sql`${t.scorePpm} IS NULL OR ${t.scorePpm} BETWEEN 0 AND 1000000`,
    ),
    check(
      'verifications_expected_check',
      sql`${t.expectedSha256} IS NULL OR ${t.expectedSha256} ~ '${sql.raw(HEX32_RE)}'`,
    ),
    check(
      'verifications_reference_check',
      sql`${t.referenceAttemptId} IS NULL OR ${t.referenceAttemptId} <> ${t.subjectAttemptId}`,
    ),
    check('verifications_details_check', sql`pg_column_size(${t.details}) <= 8192`),
    check('verifications_deadline_check', sql`${t.deadlineAt} > ${t.createdAt}`),
  ],
);

/** Inputs to the reputation score (S13): confirmed outcomes with weights in thousandths. */
export const reputationEvents = pgTable(
  'reputation_events',
  {
    id: uuid('id').primaryKey(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id),
    verificationId: uuid('verification_id').references(() => verifications.id),
    kind: text('kind').notNull(),
    /** Signed weight in thousandths (success > 0, failure < 0). */
    weightMilli: integer('weight_milli').notNull(),
    data: jsonb('data')
      .notNull()
      .default(sql`'{}'::jsonb`),
    at: tstz('at').notNull(),
  },
  (t) => [
    index('reputation_events_node_at_idx').on(t.nodeId, t.at),
    check('reputation_events_kind_check', matches(t.kind, CODE_RE)),
    check('reputation_events_weight_check', sql`${t.weightMilli} BETWEEN -1000000 AND 1000000`),
    check('reputation_events_data_check', sql`pg_column_size(${t.data}) <= 4096`),
  ],
);

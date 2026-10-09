import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { CODE_RE, HEX32_RE, matches, oneOf, tstz } from './common.js';
import { users } from './people.js';

/** Runtime settings and feature flags (e.g. `ledger_frozen`, `peg_basket`). */
export const settings = pgTable(
  'settings',
  {
    key: text('key').primaryKey(),
    value: jsonb('value').notNull(),
    updatedAt: tstz('updated_at').notNull(),
    updatedBy: uuid('updated_by').references(() => users.id),
  },
  (t) => [
    check('settings_key_check', matches(t.key, CODE_RE)),
    check('settings_value_check', sql`pg_column_size(${t.value}) <= 16384`),
  ],
);

export const AUDIT_ACTOR_KINDS = ['operator', 'owner', 'buyer', 'system', 'node'] as const;

/** Audit trail of sensitive actions (append-only: UPDATE, DELETE and TRUNCATE are rejected). */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    at: tstz('at').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    actorKind: text('actor_kind', { enum: AUDIT_ACTOR_KINDS }).notNull(),
    action: text('action').notNull(),
    targetKind: text('target_kind'),
    targetId: text('target_id'),
    /** Metadata only: never prompts, outputs, passwords or keys. */
    data: jsonb('data')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** HMAC of the client IP. */
    ipHash: text('ip_hash'),
  },
  (t) => [
    index('audit_log_at_idx').on(t.at),
    index('audit_log_actor_idx').on(t.actorUserId, t.at),
    index('audit_log_target_idx').on(t.targetKind, t.targetId, t.at),
    check('audit_log_actor_kind_check', oneOf(t.actorKind, AUDIT_ACTOR_KINDS)),
    check(
      'audit_log_actor_user_check',
      sql`${t.actorKind} NOT IN ('operator', 'owner', 'buyer') OR ${t.actorUserId} IS NOT NULL`,
    ),
    check('audit_log_action_check', matches(t.action, CODE_RE)),
    check(
      'audit_log_target_check',
      sql`(${t.targetKind} IS NULL OR ${t.targetKind} ~ '^[a-z][a-z0-9_.]{0,63}$')
        AND char_length(${t.targetId}) <= 100`,
    ),
    check('audit_log_data_check', sql`pg_column_size(${t.data}) <= 8192`),
    check(
      'audit_log_ip_hash_check',
      sql`${t.ipHash} IS NULL OR ${t.ipHash} ~ '${sql.raw(HEX32_RE)}'`,
    ),
  ],
);

/**
 * Transactional outbox (ARCHITECTURE 2.2): written in the same transaction as the change, published
 * after commit (NOTIFY carries ids only, < 8000 bytes). bigint identity keeps publish order.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    topic: text('topic').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: tstz('created_at').notNull(),
    publishedAt: tstz('published_at'),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [
    index('outbox_events_unpublished_idx')
      .on(t.id)
      .where(sql`${t.publishedAt} IS NULL`),
    check('outbox_events_topic_check', matches(t.topic, CODE_RE)),
    check('outbox_events_payload_check', sql`pg_column_size(${t.payload}) <= 4000`),
    check('outbox_events_attempts_check', sql`${t.attempts} >= 0`),
  ],
);

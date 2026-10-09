import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea, KEY_ID_RE, matches, oneOf, tstz } from './common.js';

export const USER_ROLES = ['operator', 'owner', 'buyer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** People who log in to the web (operator, PC-bang owner, buyer). */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    /** argon2id hash (S05). Never the password itself. */
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: USER_ROLES }).notNull(),
    displayName: text('display_name').notNull(),
    locale: text('locale').notNull().default('ko'),
    termsVersion: text('terms_version'),
    termsAcceptedAt: tstz('terms_accepted_at'),
    disabledAt: tstz('disabled_at'),
    createdAt: tstz('created_at').notNull(),
    updatedAt: tstz('updated_at').notNull(),
  },
  (t) => [
    // Case-insensitive uniqueness: Foo@x.com and foo@x.com are the same account.
    uniqueIndex('users_email_lower_key').on(sql`lower(${t.email})`),
    check('users_role_check', oneOf(t.role, USER_ROLES)),
    check(
      'users_email_check',
      sql`char_length(${t.email}) BETWEEN 3 AND 320 AND ${t.email} LIKE '%_@_%'`,
    ),
    check('users_password_hash_check', sql`char_length(${t.passwordHash}) BETWEEN 1 AND 512`),
    check('users_display_name_check', sql`char_length(${t.displayName}) BETWEEN 1 AND 100`),
    check('users_locale_check', matches(t.locale, '^[a-z]{2}(-[A-Z]{2})?$')),
    check(
      'users_terms_check',
      sql`(${t.termsVersion} IS NULL) = (${t.termsAcceptedAt} IS NULL) AND char_length(${t.termsVersion}) <= 32`,
    ),
  ],
);

/** Web login sessions (cookie). Only a hash of the session token is stored. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** SHA-256 of the random session token. */
    tokenHash: bytea('token_hash').notNull().unique('sessions_token_hash_key'),
    createdAt: tstz('created_at').notNull(),
    lastSeenAt: tstz('last_seen_at').notNull(),
    /** Absolute expiry (T34: 30 days). Idle expiry is last_seen_at + 7 days. */
    expiresAt: tstz('expires_at').notNull(),
    revokedAt: tstz('revoked_at'),
    /** HMAC of the client IP (never the IP itself). */
    ipHash: bytea('ip_hash'),
  },
  (t) => [
    index('sessions_user_idx').on(t.userId),
    index('sessions_expires_idx').on(t.expiresAt),
    check('sessions_token_hash_check', sql`octet_length(${t.tokenHash}) = 32`),
    check('sessions_expiry_check', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

/** Buyer API keys. The secret is shown once; only an HMAC (server pepper) is stored. */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    /** Public, non-secret prefix shown in the UI and used to find the key. */
    prefix: text('prefix').notNull().unique('api_keys_prefix_key'),
    /** HMAC-SHA256(pepper[hash_key_id], secret). */
    keyHash: bytea('key_hash').notNull().unique('api_keys_key_hash_key'),
    hashKeyId: text('hash_key_id').notNull(),
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Requests per minute; NULL = account default. */
    rateLimitRpm: integer('rate_limit_rpm'),
    createdAt: tstz('created_at').notNull(),
    lastUsedAt: tstz('last_used_at'),
    expiresAt: tstz('expires_at'),
    revokedAt: tstz('revoked_at'),
  },
  (t) => [
    index('api_keys_user_idx').on(t.userId),
    check('api_keys_name_check', sql`char_length(${t.name}) BETWEEN 1 AND 100`),
    check('api_keys_prefix_check', matches(t.prefix, '^[A-Za-z0-9_]{8,32}$')),
    check('api_keys_key_hash_check', sql`octet_length(${t.keyHash}) = 32`),
    check('api_keys_hash_key_id_check', matches(t.hashKeyId, KEY_ID_RE)),
    check('api_keys_scopes_check', sql`cardinality(${t.scopes}) <= 16`),
    check('api_keys_rate_limit_check', sql`${t.rateLimitRpm} IS NULL OR ${t.rateLimitRpm} > 0`),
  ],
);

export const IDEMPOTENCY_STATUSES = ['in_progress', 'completed'] as const;

/**
 * Idempotency for HTTP/API requests (M7). The response column holds metadata only (status, ids) —
 * never buyer content (ADR 0010); content is re-read from the job by id.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    /** Who and what the key is for, e.g. `buyer:<userId>:chat`. Keys are unique per scope. */
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    /** SHA-256 of the canonical request, so the same key with a different body is rejected. */
    requestHash: bytea('request_hash').notNull(),
    status: text('status', { enum: IDEMPOTENCY_STATUSES }).notNull(),
    responseStatus: integer('response_status'),
    response: jsonb('response'),
    createdAt: tstz('created_at').notNull(),
    completedAt: tstz('completed_at'),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'idempotency_keys_pkey', columns: [t.scope, t.key] }),
    index('idempotency_keys_expires_idx').on(t.expiresAt),
    check('idempotency_keys_scope_check', sql`char_length(${t.scope}) BETWEEN 1 AND 200`),
    check('idempotency_keys_key_check', matches(t.key, '^[\\x21-\\x7e]{1,255}$')),
    check('idempotency_keys_request_hash_check', sql`octet_length(${t.requestHash}) = 32`),
    check('idempotency_keys_status_check', oneOf(t.status, IDEMPOTENCY_STATUSES)),
    check(
      'idempotency_keys_completed_check',
      sql`(${t.status} = 'completed') = (${t.completedAt} IS NOT NULL)`,
    ),
    check(
      'idempotency_keys_response_check',
      sql`${t.response} IS NULL OR pg_column_size(${t.response}) <= 4096`,
    ),
    check('idempotency_keys_expiry_check', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

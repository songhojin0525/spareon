import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea, CODE_RE, HEX32_RE, int64, matches, oneOf, TOKEN_RE, tstz } from './common.js';
import { users } from './people.js';

/** A PC-bang (store). Owned by one owner account. */
export const stores = pgTable(
  'stores',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    timezone: text('timezone').notNull().default('Asia/Seoul'),
    /** Electricity price in won per kWh (integer won). NULL = not entered (S07 uses its default). */
    electricityWonPerKwh: int64('electricity_won_per_kwh'),
    /** Store policy (packages/protocol/schemas/defs/policy.json), validated by S10. */
    policy: jsonb('policy').notNull(),
    policyVersion: integer('policy_version').notNull().default(1),
    /** Salt for fpStore = HMAC(storeSalt, hardware id) (ADR 0008). Sent to agents in enroll.start. */
    storeSalt: text('store_salt').notNull(),
    /** D14: this store's nodes may receive TCR (sandbox credit) jobs. Default on while unverified (D13). */
    acceptTcrJobs: boolean('accept_tcr_jobs').notNull().default(true),
    /** D13: operator confirmed the store is real. Until then its nodes earn no CR. */
    verifiedAt: tstz('verified_at'),
    verifiedBy: uuid('verified_by').references(() => users.id),
    pausedAt: tstz('paused_at'),
    /** HMAC of the store's most recent public IP (D19 reattach rule); never the IP itself. */
    lastPublicIpHmac: text('last_public_ip_hmac'),
    lastPublicIpAt: tstz('last_public_ip_at'),
    createdAt: tstz('created_at').notNull(),
    updatedAt: tstz('updated_at').notNull(),
  },
  (t) => [
    index('stores_owner_idx').on(t.ownerId),
    check('stores_name_check', sql`char_length(${t.name}) BETWEEN 1 AND 100`),
    check('stores_timezone_check', matches(t.timezone, '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$')),
    check(
      'stores_electricity_check',
      sql`${t.electricityWonPerKwh} IS NULL OR ${t.electricityWonPerKwh} >= 0`,
    ),
    check('stores_policy_version_check', sql`${t.policyVersion} >= 1`),
    check('stores_policy_size_check', sql`pg_column_size(${t.policy}) <= 16384`),
    check('stores_store_salt_check', matches(t.storeSalt, HEX32_RE)),
    check('stores_verified_check', sql`(${t.verifiedAt} IS NULL) = (${t.verifiedBy} IS NULL)`),
    check(
      'stores_last_public_ip_check',
      sql`(${t.lastPublicIpHmac} IS NULL) = (${t.lastPublicIpAt} IS NULL) AND (${t.lastPublicIpHmac} IS NULL OR ${t.lastPublicIpHmac} ~ '^[0-9a-f]{64}$')`,
    ),
  ],
);

export const ENROLLMENT_CODE_KINDS = ['single', 'image'] as const;

/** Enrollment codes (ADR 0008): `single` = one PC, `image` = many PCs of one store image. Only a hash is stored. */
export const enrollmentCodes = pgTable(
  'enrollment_codes',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id),
    /** HMAC-SHA256 of the normalized code. */
    codeHash: bytea('code_hash').notNull().unique('enrollment_codes_code_hash_key'),
    kind: text('kind', { enum: ENROLLMENT_CODE_KINDS }).notNull(),
    maxUses: integer('max_uses').notNull(),
    uses: integer('uses').notNull().default(0),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: tstz('created_at').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    revokedAt: tstz('revoked_at'),
  },
  (t) => [
    index('enrollment_codes_store_idx').on(t.storeId),
    check('enrollment_codes_kind_check', oneOf(t.kind, ENROLLMENT_CODE_KINDS)),
    check('enrollment_codes_code_hash_check', sql`octet_length(${t.codeHash}) = 32`),
    check(
      'enrollment_codes_uses_check',
      sql`${t.maxUses} >= 1 AND ${t.uses} >= 0 AND ${t.uses} <= ${t.maxUses}`,
    ),
    check('enrollment_codes_single_check', sql`${t.kind} <> 'single' OR ${t.maxUses} = 1`),
    check('enrollment_codes_expiry_check', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

/** Server-side node states (ARCHITECTURE 5.1). Whether work can be offered is the separate `eligible` flag. */
export const NODE_STATES = [
  'pending',
  'offline',
  'idle',
  'customer',
  'running',
  'paused',
  'quarantined',
  'excluded',
  'disabled',
] as const;
export type NodeState = (typeof NODE_STATES)[number];

/** One PC with the agent installed. */
export const nodes = pgTable(
  'nodes',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id),
    displayName: text('display_name').notNull(),
    /** ed25519 public key, lowercase hex exactly as received (S02). Reattach replaces it. */
    devicePubkey: text('device_pubkey').notNull().unique('nodes_device_pubkey_key'),
    /** HMAC(storeSalt, hardware id): reattach within a store (ADR 0008, D3). */
    fpStore: text('fp_store').notNull(),
    /** HMAC(globalSalt, hardware id): same hardware across stores (D3). */
    fpGlobal: text('fp_global').notNull(),
    state: text('state', { enum: NODE_STATES }).notNull(),
    /** Can receive offers right now (no customer AND schedule, temperature, helper ... all certainly ok). */
    eligible: boolean('eligible').notNull().default(false),
    ineligibleReason: text('ineligible_reason'),
    stateChangedAt: tstz('state_changed_at').notNull(),
    lastSeenAt: tstz('last_seen_at'),
    agentVersion: text('agent_version'),
    runtimeVersion: text('runtime_version'),
    osBuild: text('os_build'),
    gpuSummary: jsonb('gpu_summary'),
    /** Reputation as parts per million (0..1,000,000); S13 computes it. Not a float on purpose. */
    reputationPpm: integer('reputation_ppm').notNull().default(500_000),
    quarantinedAt: tstz('quarantined_at'),
    quarantineReason: text('quarantine_reason'),
    excludedAt: tstz('excluded_at'),
    excludedReason: text('excluded_reason'),
    disabledAt: tstz('disabled_at'),
    /** Last identity reattach (D19: raised verification rate for 24 hours). */
    reattachedAt: tstz('reattached_at'),
    createdAt: tstz('created_at').notNull(),
    updatedAt: tstz('updated_at').notNull(),
  },
  (t) => [
    // ADR 0008: one node per hardware fingerprint per store (reattach finds it here).
    unique('nodes_store_fp_store_key').on(t.storeId, t.fpStore),
    index('nodes_fp_global_idx').on(t.fpGlobal),
    index('nodes_store_state_idx').on(t.storeId, t.state),
    check('nodes_state_check', oneOf(t.state, NODE_STATES)),
    check('nodes_display_name_check', sql`char_length(${t.displayName}) BETWEEN 1 AND 128`),
    check('nodes_device_pubkey_check', matches(t.devicePubkey, HEX32_RE)),
    check('nodes_fp_store_check', matches(t.fpStore, HEX32_RE)),
    check('nodes_fp_global_check', matches(t.fpGlobal, HEX32_RE)),
    check(
      'nodes_ineligible_reason_check',
      sql`${t.ineligibleReason} IS NULL OR ${t.ineligibleReason} ~ '^[a-z][a-z0-9_.]{0,63}$'`,
    ),
    check(
      'nodes_versions_check',
      sql`(${t.agentVersion} IS NULL OR ${t.agentVersion} ~ '${sql.raw(TOKEN_RE)}')
        AND (${t.runtimeVersion} IS NULL OR ${t.runtimeVersion} ~ '${sql.raw(TOKEN_RE)}')
        AND (${t.osBuild} IS NULL OR ${t.osBuild} ~ '${sql.raw(TOKEN_RE)}')`,
    ),
    check(
      'nodes_gpu_summary_check',
      sql`${t.gpuSummary} IS NULL OR pg_column_size(${t.gpuSummary}) <= 8192`,
    ),
    check('nodes_reputation_check', sql`${t.reputationPpm} BETWEEN 0 AND 1000000`),
    check(
      'nodes_state_timestamps_check',
      sql`(${t.state} <> 'quarantined' OR ${t.quarantinedAt} IS NOT NULL)
        AND (${t.state} <> 'excluded' OR ${t.excludedAt} IS NOT NULL)
        AND (${t.state} <> 'disabled' OR ${t.disabledAt} IS NOT NULL)`,
    ),
    check(
      'nodes_reasons_check',
      sql`char_length(${t.quarantineReason}) <= 500 AND char_length(${t.excludedReason}) <= 500`,
    ),
  ],
);

/** Audit/debug trail per node (state changes, reattach, clone suspicion ...). Metadata only. */
export const nodeEvents = pgTable(
  'node_events',
  {
    id: uuid('id').primaryKey(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id),
    at: tstz('at').notNull(),
    kind: text('kind').notNull(),
    data: jsonb('data')
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    index('node_events_node_at_idx').on(t.nodeId, t.at),
    check('node_events_kind_check', matches(t.kind, CODE_RE)),
    check('node_events_data_check', sql`pg_column_size(${t.data}) <= 8192`),
  ],
);

/** Presence kinds: no customer and eligible / no customer but not eligible (schedule, heat ...) / customer / paused / offline. */
export const PRESENCE_KINDS = ['eligible', 'ineligible', 'customer', 'paused', 'offline'] as const;

/** When a node was free or busy (customer-free time prediction, owner reports). Times only — no input content. */
export const presenceIntervals = pgTable(
  'presence_intervals',
  {
    id: uuid('id').primaryKey(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id),
    kind: text('kind', { enum: PRESENCE_KINDS }).notNull(),
    startedAt: tstz('started_at').notNull(),
    /** NULL = still open. */
    endedAt: tstz('ended_at'),
  },
  (t) => [
    // At most one open interval per node.
    uniqueIndex('presence_intervals_open_key')
      .on(t.nodeId)
      .where(sql`${t.endedAt} IS NULL`),
    index('presence_intervals_node_started_idx').on(t.nodeId, t.startedAt),
    check('presence_intervals_kind_check', oneOf(t.kind, PRESENCE_KINDS)),
    check(
      'presence_intervals_range_check',
      sql`${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt}`,
    ),
  ],
);

export const KILL_SWITCH_SCOPES = ['global', 'store', 'node'] as const;

/** Kill switches (ARCHITECTURE 4.9). Active while released_at IS NULL. */
export const killSwitches = pgTable(
  'kill_switches',
  {
    id: uuid('id').primaryKey(),
    scope: text('scope', { enum: KILL_SWITCH_SCOPES }).notNull(),
    storeId: uuid('store_id').references(() => stores.id),
    nodeId: uuid('node_id').references((): AnyPgColumn => nodes.id),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: tstz('created_at').notNull(),
    releasedAt: tstz('released_at'),
    releasedBy: uuid('released_by').references(() => users.id),
  },
  (t) => [
    // One active switch per target.
    uniqueIndex('kill_switches_active_key')
      .on(
        t.scope,
        sql`coalesce(${t.storeId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`coalesce(${t.nodeId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      .where(sql`${t.releasedAt} IS NULL`),
    check('kill_switches_scope_check', oneOf(t.scope, KILL_SWITCH_SCOPES)),
    check(
      'kill_switches_target_check',
      sql`(${t.scope} = 'global' AND ${t.storeId} IS NULL AND ${t.nodeId} IS NULL)
        OR (${t.scope} = 'store' AND ${t.storeId} IS NOT NULL AND ${t.nodeId} IS NULL)
        OR (${t.scope} = 'node' AND ${t.nodeId} IS NOT NULL AND ${t.storeId} IS NULL)`,
    ),
    check('kill_switches_reason_check', sql`char_length(${t.reason}) BETWEEN 1 AND 500`),
    check(
      'kill_switches_release_check',
      sql`(${t.releasedAt} IS NULL) = (${t.releasedBy} IS NULL)`,
    ),
  ],
);

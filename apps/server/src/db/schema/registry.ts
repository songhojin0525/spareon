import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  HEX32_RE,
  HEX64_RE,
  int64,
  KEY_ID_RE,
  matches,
  MODEL_SLUG_RE,
  oneOf,
  SEMVER_RE,
  TOKEN_RE,
  tstz,
} from './common.js';

export const MODEL_STATUSES = ['draft', 'active', 'retired'] as const;
/** `node` = open model run on PC-bang nodes; others are external providers (S16). */
export const MODEL_PROVIDERS = ['node', 'anthropic'] as const;

/** Models buyers can call (open models on nodes and external models). */
export const models = pgTable(
  'models',
  {
    id: uuid('id').primaryKey(),
    /** Public model id (protocol modelId). */
    slug: text('slug').notNull().unique('models_slug_key'),
    displayName: text('display_name').notNull(),
    family: text('family').notNull(),
    provider: text('provider', { enum: MODEL_PROVIDERS }).notNull().default('node'),
    /** Provider's model name for external models; NULL for node models. */
    providerModel: text('provider_model'),
    /** Parameter count in millions (integer; 500 = 0.5B). */
    paramsMillions: integer('params_millions'),
    quantization: text('quantization'),
    contextLen: integer('context_len').notNull(),
    minVramMb: integer('min_vram_mb'),
    license: text('license').notNull(),
    licenseUrl: text('license_url'),
    sourceUrl: text('source_url'),
    commercialUseOk: boolean('commercial_use_ok').notNull(),
    status: text('status', { enum: MODEL_STATUSES }).notNull(),
    createdAt: tstz('created_at').notNull(),
    updatedAt: tstz('updated_at').notNull(),
    activatedAt: tstz('activated_at'),
    retiredAt: tstz('retired_at'),
  },
  (t) => [
    check('models_slug_check', matches(t.slug, MODEL_SLUG_RE)),
    check('models_display_name_check', sql`char_length(${t.displayName}) BETWEEN 1 AND 100`),
    check('models_family_check', sql`char_length(${t.family}) BETWEEN 1 AND 64`),
    check('models_provider_check', oneOf(t.provider, MODEL_PROVIDERS)),
    check(
      'models_provider_model_check',
      sql`(${t.provider} = 'node') = (${t.providerModel} IS NULL) AND char_length(${t.providerModel}) <= 100`,
    ),
    check(
      'models_sizes_check',
      sql`(${t.paramsMillions} IS NULL OR ${t.paramsMillions} > 0) AND ${t.contextLen} > 0
        AND (${t.minVramMb} IS NULL OR ${t.minVramMb} >= 0)`,
    ),
    check(
      'models_texts_check',
      sql`char_length(${t.license}) BETWEEN 1 AND 100 AND char_length(${t.quantization}) <= 32
        AND char_length(${t.licenseUrl}) <= 800 AND char_length(${t.sourceUrl}) <= 800`,
    ),
    check('models_status_check', oneOf(t.status, MODEL_STATUSES)),
    check(
      'models_status_times_check',
      sql`(${t.status} <> 'active' OR ${t.activatedAt} IS NOT NULL)
        AND (${t.status} <> 'retired' OR ${t.retiredAt} IS NOT NULL)`,
    ),
  ],
);

export const MODEL_ARTIFACT_KINDS = ['gguf', 'tokenizer', 'chat_template'] as const;

/** Files that make up a node model (weights, tokenizer, chat template), content-addressed and signed (S09). */
export const modelArtifacts = pgTable(
  'model_artifacts',
  {
    id: uuid('id').primaryKey(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => models.id),
    kind: text('kind', { enum: MODEL_ARTIFACT_KINDS }).notNull(),
    sha256: text('sha256').notNull(),
    sizeBytes: int64('size_bytes').notNull(),
    storageKey: text('storage_key').notNull(),
    /** ed25519 signature (hex) over the model manifest that lists this file; NULL while draft. */
    signature: text('signature'),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => [
    unique('model_artifacts_model_sha256_key').on(t.modelId, t.sha256),
    check('model_artifacts_kind_check', oneOf(t.kind, MODEL_ARTIFACT_KINDS)),
    check('model_artifacts_sha256_check', matches(t.sha256, HEX32_RE)),
    check('model_artifacts_size_check', sql`${t.sizeBytes} > 0`),
    check('model_artifacts_storage_key_check', sql`char_length(${t.storageKey}) BETWEEN 1 AND 512`),
    check(
      'model_artifacts_signature_check',
      sql`${t.signature} IS NULL OR ${t.signature} ~ '${sql.raw(HEX64_RE)}'`,
    ),
  ],
);

export const RUNTIME_NAMES = ['llamacpp', 'ollama'] as const;
export const RUNTIME_RELEASE_STATUSES = ['draft', 'active', 'retired'] as const;

/** Signed inference runtime builds (llama.cpp llama-server, ADR 0004). */
export const runtimeReleases = pgTable(
  'runtime_releases',
  {
    id: uuid('id').primaryKey(),
    name: text('name', { enum: RUNTIME_NAMES }).notNull(),
    version: text('version').notNull(),
    /** Build target, e.g. windows-x64-cuda12. */
    platform: text('platform').notNull(),
    sha256: text('sha256').notNull(),
    sizeBytes: int64('size_bytes').notNull(),
    storageKey: text('storage_key').notNull(),
    signature: text('signature'),
    status: text('status', { enum: RUNTIME_RELEASE_STATUSES }).notNull(),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => [
    unique('runtime_releases_name_version_platform_key').on(t.name, t.version, t.platform),
    check('runtime_releases_name_check', oneOf(t.name, RUNTIME_NAMES)),
    check('runtime_releases_version_check', matches(t.version, TOKEN_RE)),
    check('runtime_releases_platform_check', matches(t.platform, TOKEN_RE)),
    check('runtime_releases_sha256_check', matches(t.sha256, HEX32_RE)),
    check('runtime_releases_size_check', sql`${t.sizeBytes} > 0`),
    check(
      'runtime_releases_storage_key_check',
      sql`char_length(${t.storageKey}) BETWEEN 1 AND 512`,
    ),
    check(
      'runtime_releases_signature_check',
      sql`${t.signature} IS NULL OR ${t.signature} ~ '${sql.raw(HEX64_RE)}'`,
    ),
    check('runtime_releases_status_check', oneOf(t.status, RUNTIME_RELEASE_STATUSES)),
    check(
      'runtime_releases_signed_check',
      sql`${t.status} = 'draft' OR ${t.signature} IS NOT NULL`,
    ),
  ],
);

/** Agent release states (ARCHITECTURE 5.6). */
export const AGENT_RELEASE_STATUSES = [
  'draft',
  'signed',
  'rolling_out',
  'paused',
  'completed',
  'rolled_back',
  'revoked',
] as const;

/** Agent builds and their staged rollout (ADR 0015, S21). */
export const agentReleases = pgTable(
  'agent_releases',
  {
    id: uuid('id').primaryKey(),
    version: text('version').notNull().unique('agent_releases_version_key'),
    sha256: text('sha256').notNull(),
    sizeBytes: int64('size_bytes').notNull(),
    storageKey: text('storage_key').notNull(),
    /** Signed release manifest (protocol signedManifest), NULL while draft. */
    manifest: jsonb('manifest'),
    signature: text('signature'),
    signingKeyId: text('signing_key_id'),
    status: text('status', { enum: AGENT_RELEASE_STATUSES }).notNull(),
    rolloutPercent: smallint('rollout_percent').notNull().default(0),
    /** Empty = every store (subject to rollout_percent). */
    targetStoreIds: uuid('target_store_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdAt: tstz('created_at').notNull(),
    signedAt: tstz('signed_at'),
    rolloutStartedAt: tstz('rollout_started_at'),
    completedAt: tstz('completed_at'),
  },
  (t) => [
    index('agent_releases_status_idx').on(t.status),
    check('agent_releases_version_check', matches(t.version, SEMVER_RE)),
    check('agent_releases_sha256_check', matches(t.sha256, HEX32_RE)),
    check('agent_releases_size_check', sql`${t.sizeBytes} > 0`),
    check('agent_releases_storage_key_check', sql`char_length(${t.storageKey}) BETWEEN 1 AND 512`),
    check('agent_releases_status_check', oneOf(t.status, AGENT_RELEASE_STATUSES)),
    check('agent_releases_rollout_check', sql`${t.rolloutPercent} BETWEEN 0 AND 100`),
    check('agent_releases_targets_check', sql`cardinality(${t.targetStoreIds}) <= 1000`),
    check(
      'agent_releases_signed_check',
      sql`${t.status} IN ('draft', 'revoked')
        OR (${t.signature} IS NOT NULL AND ${t.manifest} IS NOT NULL AND ${t.signingKeyId} IS NOT NULL AND ${t.signedAt} IS NOT NULL)`,
    ),
    check(
      'agent_releases_signature_check',
      sql`(${t.signature} IS NULL OR ${t.signature} ~ '${sql.raw(HEX64_RE)}')
        AND (${t.signingKeyId} IS NULL OR ${t.signingKeyId} ~ '${sql.raw(KEY_ID_RE)}')
        AND (${t.manifest} IS NULL OR pg_column_size(${t.manifest}) <= 131072)`,
    ),
  ],
);

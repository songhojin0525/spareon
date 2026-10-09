import { type AnyColumn, type SQL, sql } from 'drizzle-orm';
import { bigint, customType, timestamp } from 'drizzle-orm/pg-core';

/**
 * Shared column helpers and value lists for the schema. Conventions (docs/DB.md):
 * - Every instant is timestamptz (UTC). No DB-side now() defaults: the server writes times from its
 *   injected Clock, so tests control time.
 * - Money is bigint in minimal units of the row's currency (µCR, µTCR, KRW won, µUSD). Never numeric/float.
 * - Enumerations are text + CHECK (easy to extend and roll back), not Postgres enum types.
 */

/** timestamptz column mapped to a JS Date. */
export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** bigint column mapped to a JS bigint (minimal units for money). */
export const int64 = (name: string) => bigint(name, { mode: 'bigint' });

/** bytea column mapped to a Node Buffer. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * xid8 column (transaction id). Used only by ledger_transactions.created_xid, which a trigger fills
 * with pg_current_xact_id(); the app never writes it.
 */
export const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => 'xid8',
});

const SAFE_LITERAL = /^[A-Za-z0-9_./ -]+$/;

function literal(value: string): string {
  if (!SAFE_LITERAL.test(value)) throw new Error(`unsafe SQL literal in schema: ${value}`);
  return `'${value}'`;
}

/** `column IN ('a', 'b', ...)` for CHECK constraints and partial indexes. */
export function oneOf(column: AnyColumn, values: readonly string[]): SQL {
  return sql`${column} IN (${sql.raw(values.map(literal).join(', '))})`;
}

/** `column ~ '<regex>'`. The regex must not contain a quote. */
export function matches(column: AnyColumn, regex: string): SQL {
  if (regex.includes("'")) throw new Error('regex must not contain a quote');
  return sql`${column} ~ ${sql.raw(`'${regex}'`)}`;
}

/** Lowercase hex of 32 bytes (SHA-256, ed25519 public keys, HMAC fingerprints) — same spelling as the protocol. */
export const HEX32_RE = '^[0-9a-f]{64}$';
/** Lowercase hex of 64 bytes (ed25519 signatures). */
export const HEX64_RE = '^[0-9a-f]{128}$';
/** Protocol modelId. */
export const MODEL_SLUG_RE = '^[a-z0-9][a-z0-9._-]{0,63}$';
/** Protocol semver. */
export const SEMVER_RE =
  '^(0|[1-9][0-9]{0,4})\\.(0|[1-9][0-9]{0,4})\\.(0|[1-9][0-9]{0,4})(-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$';
/** Protocol token (versions, short identifiers). */
export const TOKEN_RE = '^[A-Za-z0-9._+-]{1,64}$';
/** Protocol keyId (encryption and signing key ids). */
export const KEY_ID_RE = '^[a-z0-9][a-z0-9-]{0,31}$';
/** Machine-readable codes and topics: lower snake case with dots. */
export const CODE_RE = '^[a-z][a-z0-9_.]{0,63}$';

export const CURRENCIES = ['CR', 'TCR', 'KRW', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];
/** Currencies a buyer can pay jobs with (TCR = sandbox credit, ADR 0005). */
export const CREDIT_CURRENCIES = ['CR', 'TCR'] as const;
export type CreditCurrency = (typeof CREDIT_CURRENCIES)[number];

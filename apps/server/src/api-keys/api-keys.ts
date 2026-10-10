/**
 * Buyer API keys. Format `sp_test_<8 base62>_<32 base62>` (ADR 0021); the database keeps the public
 * prefix `sp_test_<8>` and `HMAC-SHA256(pepper, key)`, never the key. The key is returned once, by
 * createApiKey. Authentication looks the key up by its HMAC, so no secret is compared in application
 * code (nothing to time).
 */
import { and, count, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';

import type { Db, Tx } from '../db/client.js';
import { toDbError } from '../db/errors.js';
import { apiKeys, users } from '../db/schema/index.js';
import type { Clock } from '../lib/clock.js';
import { hmacSha256, randomBase62 } from '../lib/crypto.js';
import type { Ids } from '../lib/ids.js';

export const API_KEY_SCOPES = ['chat', 'batch', 'models:read'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export const DEFAULT_SCOPES: readonly ApiKeyScope[] = API_KEY_SCOPES;

/** Keys a buyer may hold at once (revoked keys do not count). */
export const MAX_ACTIVE_KEYS_PER_USER = 20;

export const API_KEY_RE = /^sp_(test|live)_([0-9A-Za-z]{8})_([0-9A-Za-z]{32})$/;

export type PaymentsMode = 'test' | 'live';

export interface ApiKeyDeps {
  readonly clock: Clock;
  readonly ids: Ids;
  readonly pepper: string;
  readonly pepperId: string;
  /** Only test keys exist in v0.1 (PAYMENTS_MODE=live refuses to start). */
  readonly mode: PaymentsMode;
}

export function hashApiKey(pepper: string, key: string): Buffer {
  return hmacSha256(pepper, key);
}

export function generateApiKey(mode: PaymentsMode): { key: string; prefix: string } {
  const prefix = `sp_${mode}_${randomBase62(8)}`;
  return { key: `${prefix}_${randomBase62(32)}`, prefix };
}

export class ApiKeyOwnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiKeyOwnerError';
  }
}

export class ApiKeyLimitError extends Error {
  constructor() {
    super(`at most ${String(MAX_ACTIVE_KEYS_PER_USER)} active keys per buyer`);
    this.name = 'ApiKeyLimitError';
  }
}

export interface NewApiKey {
  readonly userId: string;
  readonly name: string;
  readonly scopes?: readonly ApiKeyScope[];
  readonly rateLimitRpm?: number;
}

export interface ApiKeyInfo {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly rateLimitRpm: number | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

const infoColumns = {
  id: apiKeys.id,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  scopes: apiKeys.scopes,
  rateLimitRpm: apiKeys.rateLimitRpm,
  createdAt: apiKeys.createdAt,
  lastUsedAt: apiKeys.lastUsedAt,
  revokedAt: apiKeys.revokedAt,
};

/**
 * Create a key for an active buyer. Returns the full key: show it once, never store or log it.
 * Run inside the transaction that records the audit entry.
 */
export async function createApiKey(
  tx: Tx,
  deps: ApiKeyDeps,
  input: NewApiKey,
): Promise<ApiKeyInfo & { key: string }> {
  const [owner] = await tx
    .select({ role: users.role, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, input.userId))
    .for('update');
  if (owner?.role !== 'buyer') throw new ApiKeyOwnerError('API keys belong to buyer accounts');
  if (owner.disabledAt !== null) throw new ApiKeyOwnerError('the account is disabled');
  const [active] = await tx
    .select({ n: count() })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, input.userId), isNull(apiKeys.revokedAt)));
  if ((active?.n ?? 0) >= MAX_ACTIVE_KEYS_PER_USER) throw new ApiKeyLimitError();

  const now = deps.clock.now();
  const scopes = [...new Set(input.scopes ?? DEFAULT_SCOPES)];
  // A prefix collision (48 random bits) is astronomically rare; retry once with a savepoint.
  for (let attempt = 0; ; attempt++) {
    const { key, prefix } = generateApiKey(deps.mode);
    const id = deps.ids.newId();
    try {
      await tx.transaction(async (sp) => {
        await sp.insert(apiKeys).values({
          id,
          userId: input.userId,
          name: input.name,
          prefix,
          keyHash: hashApiKey(deps.pepper, key),
          hashKeyId: deps.pepperId,
          scopes,
          rateLimitRpm: input.rateLimitRpm ?? null,
          createdAt: now,
        });
      });
      return {
        id,
        name: input.name,
        prefix,
        scopes,
        rateLimitRpm: input.rateLimitRpm ?? null,
        createdAt: now,
        lastUsedAt: null,
        revokedAt: null,
        key,
      };
    } catch (err) {
      if (attempt === 0 && toDbError(err).sqlState === '23505') continue;
      throw err;
    }
  }
}

export async function listApiKeys(db: Db, userId: string): Promise<ApiKeyInfo[]> {
  return db
    .select(infoColumns)
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt));
}

/**
 * Revoke a key. With `ownerUserId` only that user's key matches (anyone else's reads as not found).
 * Returns the revoked key, or undefined when no live key matched.
 */
export async function revokeApiKey(
  tx: Tx,
  deps: Pick<ApiKeyDeps, 'clock'>,
  input: { keyId: string; ownerUserId?: string },
): Promise<{ id: string; userId: string; prefix: string } | undefined> {
  const where = [eq(apiKeys.id, input.keyId), isNull(apiKeys.revokedAt)];
  if (input.ownerUserId !== undefined) where.push(eq(apiKeys.userId, input.ownerUserId));
  const [row] = await tx
    .update(apiKeys)
    .set({ revokedAt: deps.clock.now() })
    .where(and(...where))
    .returning({ id: apiKeys.id, userId: apiKeys.userId, prefix: apiKeys.prefix });
  return row;
}

export async function findApiKeyByPrefix(
  db: Db | Tx,
  prefix: string,
): Promise<{ id: string; userId: string; revokedAt: Date | null } | undefined> {
  const [row] = await db
    .select({ id: apiKeys.id, userId: apiKeys.userId, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(eq(apiKeys.prefix, prefix));
  return row;
}

export interface ApiKeyPrincipal {
  readonly apiKeyId: string;
  readonly userId: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly rateLimitRpm: number | null;
}

/** `Authorization: Bearer <key>` → the key's principal, or undefined (any reason: same answer). */
export async function authenticateApiKey(
  db: Db,
  deps: Pick<ApiKeyDeps, 'clock' | 'pepper' | 'mode'>,
  authorization: string | undefined,
  touchIntervalMs = 60_000,
): Promise<ApiKeyPrincipal | undefined> {
  if (authorization === undefined) return undefined;
  const m = /^Bearer ([\x21-\x7e]{1,200})$/.exec(authorization);
  const key = m?.[1];
  if (key === undefined) return undefined;
  const parts = API_KEY_RE.exec(key);
  // A key of the other mode never authenticates (a live key against a test server or vice versa).
  if (parts?.[1] !== deps.mode) return undefined;
  const now = deps.clock.now();
  const [row] = await db
    .select({
      apiKeyId: apiKeys.id,
      userId: apiKeys.userId,
      prefix: apiKeys.prefix,
      scopes: apiKeys.scopes,
      rateLimitRpm: apiKeys.rateLimitRpm,
      lastUsedAt: apiKeys.lastUsedAt,
    })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(
      and(
        eq(apiKeys.keyHash, hashApiKey(deps.pepper, key)),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
        isNull(users.disabledAt),
        eq(users.role, 'buyer'),
      ),
    );
  if (row === undefined) return undefined;
  if (row.lastUsedAt === null || now.getTime() - row.lastUsedAt.getTime() >= touchIntervalMs) {
    await db
      .update(apiKeys)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(apiKeys.id, row.apiKeyId),
          or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, now)),
        ),
      );
  }
  return {
    apiKeyId: row.apiKeyId,
    userId: row.userId,
    prefix: row.prefix,
    scopes: row.scopes,
    rateLimitRpm: row.rateLimitRpm,
  };
}

/**
 * `Idempotency-Key` support (THREAT_MODEL BUY-02, M7). A key is claimed per scope (e.g. one buyer's
 * chat requests) together with the SHA-256 of the canonical request:
 * - same key, different request → mismatch (409);
 * - same key while the first request runs → in_progress (409);
 * - same key, same request, finished → replay of the stored response metadata.
 * The stored response is metadata only (ids, status, counts), never buyer content (ADR 0010). A claim
 * left `in_progress` by a dead process can be taken over after `staleAfterMs`.
 */
import { and, eq, lte } from 'drizzle-orm';

import { type Db, withTransaction } from '../db/client.js';
import { idempotencyKeys } from '../db/schema/index.js';
import type { Clock } from './clock.js';
import { sha256 } from './crypto.js';

export const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;

export type ClaimResult =
  | { readonly kind: 'claimed' }
  | { readonly kind: 'replay'; readonly status: number; readonly response: unknown }
  | { readonly kind: 'mismatch' }
  | { readonly kind: 'in_progress' };

export interface IdempotencyConfig {
  /** How long a finished key is remembered (default 24 h, T27). */
  readonly ttlMs: number;
  /** An in_progress claim older than this belongs to a dead process (default: job deadline + 1 min). */
  readonly staleAfterMs: number;
}

export const DEFAULT_IDEMPOTENCY_CONFIG: IdempotencyConfig = {
  ttlMs: 24 * 60 * 60_000,
  staleAfterMs: 11 * 60_000,
};

/** JSON with object keys sorted at every level, so formatting and key order do not change the hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  // JSON.stringify(undefined) is undefined at run time despite its declared type.
  return value === undefined ? 'null' : JSON.stringify(value);
}

export function requestHash(value: unknown): Buffer {
  return sha256(canonicalJson(value));
}

export class Idempotency {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly config: IdempotencyConfig = DEFAULT_IDEMPOTENCY_CONFIG,
  ) {}

  async claim(scope: string, key: string, hash: Buffer): Promise<ClaimResult> {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.config.ttlMs);
    const inserted = await this.db
      .insert(idempotencyKeys)
      .values({ scope, key, requestHash: hash, status: 'in_progress', createdAt: now, expiresAt })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });
    if (inserted.length > 0) return { kind: 'claimed' };
    return withTransaction(this.db, async (tx) => {
      const [row] = await tx
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
        .for('update');
      const takeOver = async (): Promise<ClaimResult> => {
        await tx
          .update(idempotencyKeys)
          .set({
            requestHash: hash,
            status: 'in_progress',
            responseStatus: null,
            response: null,
            createdAt: now,
            completedAt: null,
            expiresAt,
          })
          .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
        return { kind: 'claimed' };
      };
      // Deleted between the insert and this read: claim it now.
      if (row === undefined) {
        await tx.insert(idempotencyKeys).values({
          scope,
          key,
          requestHash: hash,
          status: 'in_progress',
          createdAt: now,
          expiresAt,
        });
        return { kind: 'claimed' };
      }
      if (row.expiresAt.getTime() <= now.getTime()) return takeOver();
      if (!row.requestHash.equals(hash)) return { kind: 'mismatch' };
      if (row.status === 'completed') {
        return { kind: 'replay', status: row.responseStatus ?? 200, response: row.response };
      }
      if (now.getTime() - row.createdAt.getTime() >= this.config.staleAfterMs) return takeOver();
      return { kind: 'in_progress' };
    });
  }

  /** Remember the response (metadata only, at most 4 KB as JSON). */
  async complete(scope: string, key: string, status: number, response: unknown): Promise<void> {
    await this.db
      .update(idempotencyKeys)
      .set({ status: 'completed', responseStatus: status, response, completedAt: this.clock.now() })
      .where(
        and(
          eq(idempotencyKeys.scope, scope),
          eq(idempotencyKeys.key, key),
          eq(idempotencyKeys.status, 'in_progress'),
        ),
      );
  }

  /** Forget an unfinished claim: the request had no effect, so the same key may be retried. */
  async release(scope: string, key: string): Promise<void> {
    await this.db
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.scope, scope),
          eq(idempotencyKeys.key, key),
          eq(idempotencyKeys.status, 'in_progress'),
        ),
      );
  }

  async purgeExpired(): Promise<number> {
    const rows = await this.db
      .delete(idempotencyKeys)
      .where(lte(idempotencyKeys.expiresAt, this.clock.now()))
      .returning({ key: idempotencyKeys.key });
    return rows.length;
  }
}

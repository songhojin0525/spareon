/**
 * `Idempotency-Key` support (THREAT_MODEL BUY-02, M7). A key is claimed per scope (e.g. one buyer's
 * chat requests) together with a keyed hash of the canonical request:
 * - same key, different request → mismatch (409);
 * - same key while the first request runs → in_progress (409);
 * - same key, same request, finished → replay of the stored response metadata.
 *
 * Each claim carries a token (its claim time): complete/release/attach only act on the claim they own,
 * so a request that outlived a take-over cannot finish or free someone else's claim. While running, the
 * claim may record what it started (`attach`, e.g. the job id, in the job's own transaction); a later
 * request that finds the claim unfinished asks the caller's resolver what that record means (still
 * running, finished and charged, or ended without effect) instead of guessing from time alone.
 * Stored responses are metadata only (ids, status, counts), never buyer content (ADR 0010).
 */
import { and, eq, lte } from 'drizzle-orm';

import { type Db, type Tx, withTransaction } from '../db/client.js';
import { idempotencyKeys } from '../db/schema/index.js';
import type { Clock } from './clock.js';
import { hmacSha256 } from './crypto.js';

export const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;

/** Identifies one claim of a key (its claim time, unique per take-over). */
export type ClaimToken = Date;

export type ClaimResult =
  | { readonly kind: 'claimed'; readonly token: ClaimToken }
  | { readonly kind: 'replay'; readonly status: number; readonly response: unknown }
  | { readonly kind: 'mismatch' }
  | { readonly kind: 'in_progress' };

/** What to do with an unfinished claim found by another request. */
export type StaleDecision =
  | { readonly kind: 'take_over' }
  | { readonly kind: 'in_progress' }
  /** The first request finished but never recorded it: record this outcome and replay it. */
  | { readonly kind: 'complete'; readonly status: number; readonly response: unknown };

/**
 * Inspects an unfinished claim: `attached` is what the claim recorded (undefined: nothing yet), `stale`
 * whether it is older than `staleAfterMs` (its request should be over by now).
 */
export type ClaimResolver = (attached: unknown, stale: boolean, tx: Tx) => Promise<StaleDecision>;

export interface IdempotencyConfig {
  /** How long a finished key is remembered (default 24 h, T27). */
  readonly ttlMs: number;
  /**
   * An unfinished claim older than this belongs to a request that must be over (default 11 min). The
   * composition root derives it from the scheduler's deadline and waiter slack.
   */
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

/**
 * Keyed hash of the canonical request: a leaked database row cannot confirm a guessed prompt without
 * the server key (ADR 0010).
 */
export function requestHash(key: Uint8Array, value: unknown): Buffer {
  return hmacSha256(key, canonicalJson(value));
}

const defaultResolver: ClaimResolver = (_attached, stale) =>
  Promise.resolve(stale ? { kind: 'take_over' } : { kind: 'in_progress' });

/** attach() found the claim no longer ours (taken over): the work it was about to record must not happen. */
export class IdempotencyClaimLostError extends Error {
  constructor() {
    super('the idempotency claim was taken over');
    this.name = 'IdempotencyClaimLostError';
  }
}

export class Idempotency {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    readonly config: IdempotencyConfig = DEFAULT_IDEMPOTENCY_CONFIG,
  ) {}

  async claim(
    scope: string,
    key: string,
    hash: Buffer,
    resolve: ClaimResolver = defaultResolver,
  ): Promise<ClaimResult> {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.config.ttlMs);
    const inserted = await this.db
      .insert(idempotencyKeys)
      .values({ scope, key, requestHash: hash, status: 'in_progress', createdAt: now, expiresAt })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });
    if (inserted.length > 0) return { kind: 'claimed', token: now };
    return withTransaction(this.db, async (tx) => {
      const where = and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key));
      const [row] = await tx.select().from(idempotencyKeys).where(where).for('update');
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
          .where(where);
        return { kind: 'claimed', token: now };
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
        return { kind: 'claimed', token: now };
      }
      if (row.expiresAt.getTime() <= now.getTime()) return takeOver();
      if (!row.requestHash.equals(hash)) return { kind: 'mismatch' };
      if (row.status === 'completed') {
        return { kind: 'replay', status: row.responseStatus ?? 200, response: row.response };
      }
      const stale = now.getTime() - row.createdAt.getTime() >= this.config.staleAfterMs;
      // The resolver reads through this transaction's connection: borrowing a second pooled
      // connection while holding the row lock could exhaust the pool under concurrent retries.
      const decision = await resolve(row.response ?? undefined, stale, tx);
      if (decision.kind === 'take_over') return takeOver();
      if (decision.kind === 'in_progress') return { kind: 'in_progress' };
      await tx
        .update(idempotencyKeys)
        .set({
          status: 'completed',
          responseStatus: decision.status,
          response: decision.response,
          completedAt: now,
        })
        .where(where);
      return { kind: 'replay', status: decision.status, response: decision.response };
    });
  }

  #owned(scope: string, key: string, token: ClaimToken) {
    return and(
      eq(idempotencyKeys.scope, scope),
      eq(idempotencyKeys.key, key),
      eq(idempotencyKeys.status, 'in_progress'),
      eq(idempotencyKeys.createdAt, token),
    );
  }

  /**
   * Record what this claim started (metadata only) — call inside the transaction that starts it, so
   * the record exists exactly when the effect does. False when the claim is no longer ours.
   */
  async attach(
    tx: Tx,
    scope: string,
    key: string,
    token: ClaimToken,
    attached: unknown,
  ): Promise<boolean> {
    const rows = await tx
      .update(idempotencyKeys)
      .set({ response: attached })
      .where(this.#owned(scope, key, token))
      .returning({ key: idempotencyKeys.key });
    return rows.length > 0;
  }

  /** Remember the response (metadata only, at most 4 KB as JSON). No-op if the claim is not ours. */
  async complete(
    scope: string,
    key: string,
    token: ClaimToken,
    status: number,
    response: unknown,
  ): Promise<void> {
    await this.db
      .update(idempotencyKeys)
      .set({ status: 'completed', responseStatus: status, response, completedAt: this.clock.now() })
      .where(this.#owned(scope, key, token));
  }

  /** Forget our unfinished claim: the request had no effect, so the same key may be retried. */
  async release(scope: string, key: string, token: ClaimToken): Promise<void> {
    await this.db.delete(idempotencyKeys).where(this.#owned(scope, key, token));
  }

  async purgeExpired(): Promise<number> {
    const rows = await this.db
      .delete(idempotencyKeys)
      .where(lte(idempotencyKeys.expiresAt, this.clock.now()))
      .returning({ key: idempotencyKeys.key });
    return rows.length;
  }
}

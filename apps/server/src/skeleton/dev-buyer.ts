/**
 * Development and test only: a buyer account with a recorded test top-up and a fresh API key, made with
 * the real account and key functions (S05). Used by `pnpm dev:server`, `pnpm demo` and the integration
 * test harness. Never called by the production entry point (src/main.ts).
 *
 * It also raises the concurrency and per-buyer rate settings (DEV_LIMITS, development and test
 * databases only, audited): the demo and the scheduling tests send bursts of requests with this one
 * key. Tests of the limits themselves set their own values.
 */
import { MICRO_CR_PER_CR } from '@spareon/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { type ApiKeyDeps, createApiKey } from '../api-keys/api-keys.js';
import { recordAudit } from '../audit/audit.js';
import { UNUSABLE_PASSWORD_HASH } from '../auth/password.js';
import { createUser } from '../auth/users.js';
import { type Db, withTransaction } from '../db/client.js';
import { apiKeys, settings } from '../db/schema/index.js';
import { ensureAccount, postEntry } from '../ledger/skeleton.js';
import { writeSetting } from '../lib/settings.js';

export const DEV_BUYER_SETTING_KEY = 'dev.buyer';
export const DEV_KEY_NAME = 'dev-stack';
export const DEV_LIMITS = {
  'api_keys.default_concurrency': 64,
  'buyers.concurrency': 64,
  'buyers.rpm': 10_000,
} as const;
/** Recorded won per CR for the development top-up (dev seed rate, not a real quote). */
const DEV_KRW_PER_CR = 1_400n;

const recordSchema = z.object({ buyerId: z.uuid() });

export interface DevBuyer {
  readonly buyerId: string;
  /** A new key on every call (earlier dev-stack keys are revoked): only its hash is stored. */
  readonly apiKey: string;
}

export interface DevBuyerOptions {
  /** Test top-up in whole CR, recorded once when the buyer is created (default 100). */
  readonly topupCr?: bigint;
  readonly email?: string;
}

export async function ensureDevBuyer(
  db: Db,
  deps: ApiKeyDeps,
  options: DevBuyerOptions = {},
): Promise<DevBuyer> {
  return withTransaction(db, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${DEV_BUYER_SETTING_KEY}))`);
    const [existing] = await tx
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, DEV_BUYER_SETTING_KEY));
    let buyerId: string;
    if (existing === undefined) {
      buyerId = await createUser(tx, deps, {
        email: options.email ?? 'dev-buyer@spareon.test',
        role: 'buyer',
        displayName: '개발용 구매자',
        // Logs in with its API key only.
        passwordHash: UNUSABLE_PASSWORD_HASH,
      });
      // Operator TEST_TOPUP (ARCHITECTURE 9.2): recorded won into the reserve, the same value in CR to
      // the buyer. No real money moves (absolute rule 2).
      const topupCr = options.topupCr ?? 100n;
      if (topupCr > 0n) {
        const topupUcr = topupCr * MICRO_CR_PER_CR;
        const topupKrw = topupCr * DEV_KRW_PER_CR;
        const account = (
          kind: 'test_topup_source' | 'reserve' | 'fx_conversion' | 'buyer_wallet',
          currency: 'KRW' | 'CR',
          ownerId: string | null,
        ) => ensureAccount(tx, deps, { kind, ownerId, currency });
        await postEntry(tx, deps, {
          kind: 'TEST_TOPUP',
          idempotencyKey: `skeleton:topup:${buyerId}`,
          memo: 'development test top-up (no real money)',
          postings: [
            {
              accountId: await account('test_topup_source', 'KRW', null),
              currency: 'KRW',
              amount: -topupKrw,
            },
            { accountId: await account('reserve', 'KRW', null), currency: 'KRW', amount: topupKrw },
            {
              accountId: await account('fx_conversion', 'CR', null),
              currency: 'CR',
              amount: -topupUcr,
            },
            {
              accountId: await account('buyer_wallet', 'CR', buyerId),
              currency: 'CR',
              amount: topupUcr,
            },
          ],
        });
      }
      await tx.insert(settings).values({
        key: DEV_BUYER_SETTING_KEY,
        value: { buyerId },
        updatedAt: deps.clock.now(),
      });
    } else {
      buyerId = recordSchema.parse(existing.value).buyerId;
    }
    await tx
      .update(apiKeys)
      .set({ revokedAt: deps.clock.now() })
      .where(
        and(eq(apiKeys.userId, buyerId), eq(apiKeys.name, DEV_KEY_NAME), isNull(apiKeys.revokedAt)),
      );
    for (const [key, value] of Object.entries(DEV_LIMITS) as [keyof typeof DEV_LIMITS, number][]) {
      const w = await writeSetting(tx, deps.clock, key, value, null);
      if (w.previous !== w.value) {
        await recordAudit(tx, deps, {
          actor: { kind: 'system', via: 'dev-stack' },
          action: 'settings.set',
          targetKind: 'setting',
          targetId: key,
          data: { previous: w.previous, value: w.value },
        });
      }
    }
    const key = await createApiKey(tx, deps, { userId: buyerId, name: DEV_KEY_NAME });
    await recordAudit(tx, deps, {
      actor: { kind: 'system', via: 'dev-stack' },
      action: 'api_key.create',
      targetKind: 'api_key',
      targetId: key.id,
      data: { prefix: key.prefix, ownerUserId: buyerId },
    });
    return { buyerId, apiKey: key.key };
  });
}

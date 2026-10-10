/**
 * Development world for the S04 walking skeleton: one buyer with a recorded test top-up, one verified
 * development store that agents attach to, and a price version for jobs to reference. Idempotent (the
 * `dev.skeleton` setting remembers what was created) and runs with the server's least-privilege role.
 *
 * SKELETON(S05): real buyer accounts and API keys replace the single development buyer.
 * SKELETON(S10): store registration and node enrollment replace the single development store.
 */
import { randomBytes } from 'node:crypto';

import { MICRO_CR_PER_CR } from '@spareon/shared';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { type Db, withTransaction } from '../db/client.js';
import { models, priceVersions, settings, stores, users } from '../db/schema/index.js';
import { ensureAccount, type LedgerDeps, postEntry } from '../ledger/skeleton.js';

export const SKELETON_SETTING_KEY = 'dev.skeleton';
/** Users get an unusable password hash: nobody can log in until S05. */
const UNUSABLE_PASSWORD_HASH = '!unusable';
/** Recorded won per CR for the development top-up (dev seed rate, not a real quote). */
const DEV_KRW_PER_CR = 1_400n;

const worldSchema = z.object({
  version: z.literal(1),
  buyerId: z.uuid(),
  ownerId: z.uuid(),
  operatorId: z.uuid(),
  storeId: z.uuid(),
  priceVersionId: z.uuid(),
});
export type SkeletonWorld = z.infer<typeof worldSchema>;

export interface BootstrapOptions {
  /** Development top-up for the buyer in whole CR (default 100). Applied once, on first bootstrap. */
  readonly topupCr?: bigint;
}

/** Create (once) or load the development world. */
export async function ensureSkeletonWorld(
  db: Db,
  deps: LedgerDeps,
  options: BootstrapOptions = {},
): Promise<SkeletonWorld> {
  return withTransaction(db, async (tx) => {
    const now = deps.clock.now();
    // Serialize concurrent bootstraps (two server processes on one database).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${SKELETON_SETTING_KEY}))`);
    const [existing] = await tx
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, SKELETON_SETTING_KEY));
    if (existing !== undefined) return worldSchema.parse(existing.value);

    const id = (): string => deps.ids.newId();
    const user = async (role: 'operator' | 'owner' | 'buyer', name: string): Promise<string> => {
      const userId = id();
      await tx.insert(users).values({
        id: userId,
        email: `skeleton-${role}-${userId.slice(-12)}@spareon.test`,
        passwordHash: UNUSABLE_PASSWORD_HASH,
        role,
        displayName: name,
        createdAt: now,
        updatedAt: now,
      });
      return userId;
    };
    const operatorId = await user('operator', '개발용 운영자');
    const ownerId = await user('owner', '개발용 사장님');
    const buyerId = await user('buyer', '개발용 구매자');

    const storeId = id();
    await tx.insert(stores).values({
      id: storeId,
      ownerId,
      name: '개발용 매장 (S04)',
      policy: {},
      storeSalt: randomBytes(32).toString('hex'),
      // Verified so its nodes may run CR jobs (D13); a development store only.
      verifiedAt: now,
      verifiedBy: operatorId,
      createdAt: now,
      updatedAt: now,
    });

    const [maxVersion] = await tx
      .select({ v: sql<number>`coalesce(max(${priceVersions.version}), 0)::int` })
      .from(priceVersions);
    const priceVersionId = id();
    await tx.insert(priceVersions).values({
      id: priceVersionId,
      version: (maxVersion?.v ?? 0) + 1,
      notes: 'S04 skeleton: fixed price per request until S08',
      effectiveAt: now,
      createdBy: operatorId,
      createdAt: now,
    });

    // Operator TEST_TOPUP (ARCHITECTURE 9.2): recorded won into the reserve, the same value in CR to the
    // buyer. No real money moves (absolute rule 2).
    const topupCr = options.topupCr ?? 100n;
    if (topupCr > 0n) {
      const topupUcr = topupCr * MICRO_CR_PER_CR;
      const topupKrw = topupCr * DEV_KRW_PER_CR;
      await postEntry(tx, deps, {
        kind: 'TEST_TOPUP',
        idempotencyKey: `skeleton:topup:${buyerId}`,
        memo: 'S04 development test top-up (no real money)',
        postings: [
          {
            accountId: await ensureAccount(tx, deps, {
              kind: 'test_topup_source',
              ownerId: null,
              currency: 'KRW',
            }),
            currency: 'KRW',
            amount: -topupKrw,
          },
          {
            accountId: await ensureAccount(tx, deps, {
              kind: 'reserve',
              ownerId: null,
              currency: 'KRW',
            }),
            currency: 'KRW',
            amount: topupKrw,
          },
          {
            accountId: await ensureAccount(tx, deps, {
              kind: 'fx_conversion',
              ownerId: null,
              currency: 'CR',
            }),
            currency: 'CR',
            amount: -topupUcr,
          },
          {
            accountId: await ensureAccount(tx, deps, {
              kind: 'buyer_wallet',
              ownerId: buyerId,
              currency: 'CR',
            }),
            currency: 'CR',
            amount: topupUcr,
          },
        ],
      });
    }

    const world: SkeletonWorld = {
      version: 1,
      buyerId,
      ownerId,
      operatorId,
      storeId,
      priceVersionId,
    };
    await tx.insert(settings).values({ key: SKELETON_SETTING_KEY, value: world, updatedAt: now });
    return world;
  });
}

/**
 * SKELETON(S09): an agent's reported model becomes a buyer-callable model on first sight (development
 * only); the model registry (signed manifests, license gate, tokenizer) replaces this.
 */
export async function ensureDevModel(db: Db, deps: LedgerDeps, slug: string): Promise<void> {
  const now = deps.clock.now();
  await db
    .insert(models)
    .values({
      id: deps.ids.newId(),
      slug,
      displayName: slug,
      family: 'dev',
      contextLen: 4096,
      license: 'unknown (dev)',
      commercialUseOk: false,
      status: 'active',
      activatedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

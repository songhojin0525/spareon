/**
 * The skeleton world every server needs until S08/S10: one verified store that agents attach to (with
 * its owner and the operator who verified it) and a price version for jobs to reference. Idempotent
 * (the `dev.skeleton` setting remembers what was created) and runs with the least-privilege role.
 * Buyers are real accounts with real API keys (S05); development tools create one with ensureDevBuyer.
 *
 * SKELETON(S10): store registration and node enrollment replace the single development store.
 */
import { randomBytes } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { UNUSABLE_PASSWORD_HASH } from '../auth/password.js';
import { type Db, withTransaction } from '../db/client.js';
import { models, priceVersions, settings, stores, users } from '../db/schema/index.js';
import type { LedgerDeps } from '../ledger/skeleton.js';

export const SKELETON_SETTING_KEY = 'dev.skeleton';

const worldSchema = z.object({
  // Version 1 worlds made before S05 also carry a buyerId; it is ignored (zod drops unknown keys).
  version: z.literal(1),
  ownerId: z.uuid(),
  operatorId: z.uuid(),
  storeId: z.uuid(),
  priceVersionId: z.uuid(),
});
export type SkeletonWorld = z.infer<typeof worldSchema>;

/** Create (once) or load the development world. */
export async function ensureSkeletonWorld(db: Db, deps: LedgerDeps): Promise<SkeletonWorld> {
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
    // Seed accounts cannot log in (unusable hash); operators log in with accounts made by the CLI.
    const user = async (role: 'operator' | 'owner', name: string): Promise<string> => {
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

    const world: SkeletonWorld = {
      version: 1,
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

import { randomBytes } from 'node:crypto';

import { MICRO_CR_PER_CR } from '@spareon/shared';
import { z } from 'zod';

import type { Clock } from '../lib/clock.js';
import { createFactories, type RandomBytes } from '../testing/factories.js';
import { createDb, withTransaction } from './client.js';
import { migrationStatus } from './migrate.js';
import { fxRates, settings } from './schema/index.js';

/**
 * Development seed (`pnpm --filter @spareon/server db:seed`): a small, believable data set for local
 * work — one operator, owner and buyer, one verified PC-bang with three nodes, two models, a price list,
 * the platform ledger accounts and an operator TEST_TOPUP for the buyer.
 *
 * - Idempotent: the `dev.seed` setting marks a seeded database; a second run changes nothing.
 * - Local only: refuses a non-local DATABASE_URL unless SPAREON_ALLOW_REMOTE_SEED=1 (never seed production).
 * - Users get an unusable password hash: they cannot log in (real accounts come from sign-up or the CLI).
 * - No real money: TEST_TOPUP is a recorded test top-up (ARCHITECTURE 9.2), not a payment.
 */

export const SEED_SETTING_KEY = 'dev.seed';
export const SEED_VERSION = 1;

/** 1 CR = 1 USD (ARCHITECTURE 9.5 risk 5); the seed records USD/KRW 1,400 as its rate snapshot. */
const SEED_USD_KRW_MICROS = 1_400_000_000n;
const SEED_TOPUP_CR = 10n;
const SEED_TOPUP_KRW = 14_000n;

const envSchema = z.object({
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgres:// URL'),
  SPAREON_ALLOW_REMOTE_SEED: z.enum(['0', '1']).optional(),
});

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Conservative, like testkit's test-database check: only an explicit loopback host counts. An empty
 * host (decided by PGHOST) or a `host=`/`hostaddr=` parameter (honoured by pg) may be remote.
 */
export function isLocalDatabaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('host') || parsed.searchParams.has('hostaddr')) return false;
    return LOCAL_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export type SeedResult =
  | { readonly status: 'seeded'; readonly counts: Record<string, number> }
  | { readonly status: 'already_seeded' };

export class SeedError extends Error {
  readonly code = 'SEED_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

const cryptoRandom: RandomBytes = { bytes: (n) => randomBytes(n) };

export async function seedDatabase(options: {
  url: string;
  clock: Clock;
  random?: RandomBytes;
}): Promise<SeedResult> {
  const status = await migrationStatus({ url: options.url });
  if (status.pending.length > 0) {
    throw new SeedError(
      `database has pending migrations (${status.pending.join(', ')}): run db:migrate first`,
    );
  }
  const handle = createDb({ url: options.url, maxConnections: 1, applicationName: 'spareon-seed' });
  try {
    return await withTransaction(handle.db, async (tx) => {
      const now = options.clock.now();
      // Claim the marker first: a concurrent second seed waits on this row and then does nothing.
      const claimed = await tx
        .insert(settings)
        .values({ key: SEED_SETTING_KEY, value: { version: SEED_VERSION }, updatedAt: now })
        .onConflictDoNothing()
        .returning({ key: settings.key });
      if (claimed.length === 0) return { status: 'already_seeded' } as const;

      const f = createFactories({
        db: tx,
        clock: options.clock,
        random: options.random ?? cryptoRandom,
      });
      const operator = await f.operator({
        email: 'operator@spareon.test',
        displayName: '운영자',
      });
      const owner = await f.owner({ email: 'owner@spareon.test', displayName: '사장님' });
      const buyer = await f.buyer({ email: 'buyer@spareon.test', displayName: '구매자' });

      const store = await f.store({
        ownerId: owner.id,
        name: 'Spareon PC방 (개발용)',
        electricityWonPerKwh: 150n,
        verifiedAt: now,
        verifiedBy: operator.id,
      });
      await f.node({ storeId: store.id, state: 'idle', displayName: 'PC-001' });
      await f.node({ storeId: store.id, state: 'customer', displayName: 'PC-002' });
      await f.node({ storeId: store.id, state: 'offline', displayName: 'PC-003' });

      const small = await f.model({
        slug: 'qwen2.5-0.5b-instruct-q4',
        displayName: 'Qwen2.5 0.5B Instruct (Q4)',
        family: 'qwen2.5',
        paramsMillions: 500,
        contextLen: 32768,
        minVramMb: 1024,
        license: 'Apache-2.0',
      });
      const draft = await f.model({
        slug: 'llama-3.1-8b-instruct-q4',
        displayName: 'Llama 3.1 8B Instruct (Q4)',
        family: 'llama3.1',
        paramsMillions: 8000,
        minVramMb: 6144,
        license: 'Llama 3.1 Community License',
        status: 'draft',
      });
      await f.priceVersion({
        version: 1,
        entries: [
          { modelId: small.id, inputUcrPerMtok: 50_000n, outputUcrPerMtok: 100_000n },
          { modelId: draft.id, inputUcrPerMtok: 150_000n, outputUcrPerMtok: 300_000n },
        ],
      });
      await tx.insert(fxRates).values({
        id: f.id(),
        pair: 'USD/KRW',
        rateMicros: SEED_USD_KRW_MICROS,
        source: 'dev seed (not a real quote)',
        effectiveAt: now,
        createdBy: operator.id,
        createdAt: now,
      });

      // Platform accounts (ARCHITECTURE 9.1) and the buyer's wallets.
      const platform = {
        revenueCr: await f.ledgerAccount({ kind: 'platform_revenue', currency: 'CR' }),
        convCr: await f.ledgerAccount({ kind: 'fx_conversion', currency: 'CR' }),
        convKrw: await f.ledgerAccount({ kind: 'fx_conversion', currency: 'KRW' }),
        reserve: await f.ledgerAccount({ kind: 'reserve', currency: 'KRW' }),
        topupSource: await f.ledgerAccount({ kind: 'test_topup_source', currency: 'KRW' }),
        sandbox: await f.ledgerAccount({ kind: 'sandbox_issuance', currency: 'TCR' }),
      };
      const wallet = await f.ledgerAccount({
        kind: 'buyer_wallet',
        currency: 'CR',
        ownerId: buyer.id,
      });
      await f.ledgerAccount({ kind: 'buyer_wallet', currency: 'TCR', ownerId: buyer.id });

      // Operator TEST_TOPUP: recorded won into the reserve, the same value in CR to the buyer.
      const topupUcr = SEED_TOPUP_CR * MICRO_CR_PER_CR;
      await f.ledgerEntry({
        kind: 'TEST_TOPUP',
        idempotencyKey: `seed:${String(SEED_VERSION)}:topup:${buyer.id}`,
        memo: 'dev seed test top-up',
        postings: [
          { accountId: platform.topupSource.id, currency: 'KRW', amount: -SEED_TOPUP_KRW },
          { accountId: platform.reserve.id, currency: 'KRW', amount: SEED_TOPUP_KRW },
          { accountId: platform.convCr.id, currency: 'CR', amount: -topupUcr },
          { accountId: wallet.id, currency: 'CR', amount: topupUcr },
        ],
      });
      return {
        status: 'seeded',
        counts: { users: 3, stores: 1, nodes: 3, models: 2, ledgerAccounts: 8, ledgerEntries: 1 },
      } as const;
    });
  } finally {
    await handle.close();
  }
}

export interface SeedCliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Returns the process exit code. Never prints the connection URL. */
export async function runSeedCli(
  env: Readonly<Record<string, string | undefined>>,
  clock: Clock,
  io: SeedCliIo,
): Promise<number> {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    io.err(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return 2;
  }
  const { DATABASE_URL: url, SPAREON_ALLOW_REMOTE_SEED: allowRemote } = parsed.data;
  if (!isLocalDatabaseUrl(url) && allowRemote !== '1') {
    io.err(
      'refusing to seed a non-local database (set SPAREON_ALLOW_REMOTE_SEED=1 if this really is a dev database)',
    );
    return 2;
  }
  try {
    const result = await seedDatabase({ url, clock });
    if (result.status === 'already_seeded') {
      io.out('already seeded: nothing changed');
    } else {
      io.out(
        `seeded: ${Object.entries(result.counts)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(', ')}`,
      );
    }
    return 0;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

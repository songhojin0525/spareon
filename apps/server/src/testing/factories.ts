import { uuidV7 } from '@binjari/shared';

import type { Db, Tx } from '../db/client.js';
import {
  ACCOUNT_RULES,
  type AccountKind,
  type AttemptStatus,
  type CreditCurrency,
  type Currency,
  jobAttempts,
  jobs,
  ledgerAccounts,
  ledgerPostings,
  ledgerTransactions,
  type LedgerTxKind,
  models,
  nodes,
  type NodeState,
  priceEntries,
  priceVersions,
  stores,
  type UserRole,
  users,
} from '../db/schema/index.js';
import type { Clock } from '../lib/clock.js';

/**
 * Row factories for tests and the dev seed (S03). Each returns the inserted row and fills every required
 * column with a valid default, so a test states only what it cares about.
 *
 * They live in the server (not packages/testkit) because they must follow the Drizzle table types: a
 * schema change then breaks them at compile time. testkit cannot import the server (circular).
 *
 * Not for production paths: the ledger helper here writes entries directly. Real money movements go
 * through the ledger service (S06), which adds locking order, idempotent replays and audit records.
 */

/** Source of random bytes; @binjari/testkit's createSeededRandom satisfies it (deterministic ids). */
export interface RandomBytes {
  bytes(length: number): Uint8Array;
}

export interface FactoryContext {
  readonly db: Db | Tx;
  readonly clock: Clock;
  readonly random: RandomBytes;
}

/** A placeholder that is not a valid password hash of any scheme: nobody can log in with it (S05 sets real ones). */
export const UNUSABLE_PASSWORD_HASH = '!unusable';

const DEFAULT_POLICY = {} as const;

function hex(random: RandomBytes, bytes: number): string {
  return Buffer.from(random.bytes(bytes)).toString('hex');
}

export type UserRow = typeof users.$inferSelect;
export type StoreRow = typeof stores.$inferSelect;
export type NodeRow = typeof nodes.$inferSelect;
export type ModelRow = typeof models.$inferSelect;
export type PriceVersionRow = typeof priceVersions.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type AttemptRow = typeof jobAttempts.$inferSelect;
export type LedgerAccountRow = typeof ledgerAccounts.$inferSelect;

export interface PostingSpec {
  readonly accountId: string;
  readonly currency: Currency;
  readonly amount: bigint;
}

export function createFactories(ctx: FactoryContext) {
  const { db, clock, random } = ctx;
  const id = (): string => uuidV7(clock.now().getTime(), random.bytes(10));
  let counter = 0;
  const next = (): number => ++counter;

  async function one<T>(rows: Promise<T[]>): Promise<T> {
    const [row] = await rows;
    if (row === undefined) throw new Error('factory insert returned no row');
    return row;
  }

  const factories = {
    id,

    user(overrides: Partial<typeof users.$inferInsert> & { role?: UserRole } = {}) {
      const now = clock.now();
      const n = next();
      const role = overrides.role ?? 'buyer';
      return one(
        db
          .insert(users)
          .values({
            id: id(),
            email: `${role}${String(n)}@example.test`,
            passwordHash: UNUSABLE_PASSWORD_HASH,
            role,
            displayName: `${role} ${String(n)}`,
            createdAt: now,
            updatedAt: now,
            ...overrides,
          })
          .returning(),
      );
    },
    operator: (o: Partial<typeof users.$inferInsert> = {}) =>
      factories.user({ ...o, role: 'operator' }),
    owner: (o: Partial<typeof users.$inferInsert> = {}) => factories.user({ ...o, role: 'owner' }),
    buyer: (o: Partial<typeof users.$inferInsert> = {}) => factories.user({ ...o, role: 'buyer' }),

    async store(overrides: Partial<typeof stores.$inferInsert> = {}): Promise<StoreRow> {
      const now = clock.now();
      const ownerId = overrides.ownerId ?? (await factories.owner()).id;
      return one(
        db
          .insert(stores)
          .values({
            id: id(),
            ownerId,
            name: `PC방 ${String(next())}`,
            policy: DEFAULT_POLICY,
            storeSalt: hex(random, 32),
            createdAt: now,
            updatedAt: now,
            ...overrides,
          })
          .returning(),
      );
    },

    async node(
      overrides: Partial<typeof nodes.$inferInsert> & { state?: NodeState } = {},
    ): Promise<NodeRow> {
      const now = clock.now();
      const storeId = overrides.storeId ?? (await factories.store()).id;
      const state = overrides.state ?? 'idle';
      return one(
        db
          .insert(nodes)
          .values({
            id: id(),
            storeId,
            displayName: `PC-${String(next()).padStart(3, '0')}`,
            devicePubkey: hex(random, 32),
            fpStore: hex(random, 32),
            fpGlobal: hex(random, 32),
            state,
            eligible: state === 'idle',
            stateChangedAt: now,
            lastSeenAt: now,
            quarantinedAt: state === 'quarantined' ? now : null,
            quarantineReason: state === 'quarantined' ? 'test' : null,
            excludedAt: state === 'excluded' ? now : null,
            disabledAt: state === 'disabled' ? now : null,
            createdAt: now,
            updatedAt: now,
            ...overrides,
          })
          .returning(),
      );
    },

    model(overrides: Partial<typeof models.$inferInsert> = {}): Promise<ModelRow> {
      const now = clock.now();
      const status = overrides.status ?? 'active';
      return one(
        db
          .insert(models)
          .values({
            id: id(),
            slug: `test-model-${String(next())}`,
            displayName: 'Test model',
            family: 'test',
            paramsMillions: 500,
            quantization: 'Q4_K_M',
            contextLen: 8192,
            minVramMb: 2048,
            license: 'Apache-2.0',
            commercialUseOk: true,
            status,
            activatedAt: status === 'draft' ? null : now,
            retiredAt: status === 'retired' ? now : null,
            createdAt: now,
            updatedAt: now,
            ...overrides,
          })
          .returning(),
      );
    },

    /** A price version with one entry per given model (append-only: create a new version to change prices). */
    async priceVersion(options: {
      version: number;
      entries: readonly {
        modelId: string;
        inputUcrPerMtok?: bigint;
        outputUcrPerMtok?: bigint;
        nodePayoutBps?: number;
      }[];
    }): Promise<PriceVersionRow> {
      const now = clock.now();
      const version = await one(
        db
          .insert(priceVersions)
          .values({ id: id(), version: options.version, effectiveAt: now, createdAt: now })
          .returning(),
      );
      if (options.entries.length > 0) {
        await db.insert(priceEntries).values(
          options.entries.map((e) => ({
            priceVersionId: version.id,
            modelId: e.modelId,
            inputUcrPerMtok: e.inputUcrPerMtok ?? 100_000n,
            outputUcrPerMtok: e.outputUcrPerMtok ?? 300_000n,
            nodePayoutBps: e.nodePayoutBps ?? 7_000,
          })),
        );
      }
      return version;
    },

    async job(
      overrides: Partial<typeof jobs.$inferInsert> & {
        currency?: CreditCurrency;
      } = {},
    ): Promise<JobRow> {
      const now = clock.now();
      const kind = overrides.kind ?? 'chat';
      const buyerId =
        overrides.buyerId !== undefined
          ? overrides.buyerId
          : kind === 'chat' || kind === 'batch_item'
            ? (await factories.buyer()).id
            : null;
      const modelId = overrides.modelId ?? (await factories.model()).id;
      const priceVersionId =
        overrides.priceVersionId ??
        (await factories.priceVersion({ version: 1000 + next(), entries: [{ modelId }] })).id;
      const status = overrides.status ?? 'queued';
      const final = ['completed', 'failed', 'canceled', 'expired'].includes(status);
      return one(
        db
          .insert(jobs)
          .values({
            id: id(),
            buyerId,
            kind,
            currency: 'CR',
            modelId,
            status,
            params: { temperatureMilli: 700 },
            inputBytes: 128,
            maxTokens: 256,
            priceVersionId,
            deadlineAt: new Date(now.getTime() + 10 * 60_000),
            createdAt: now,
            statusChangedAt: now,
            endedAt: final ? now : null,
            ...overrides,
          })
          .returning(),
      );
    },

    async attempt(
      overrides: Partial<typeof jobAttempts.$inferInsert> & {
        jobId: string;
        status?: AttemptStatus;
      },
    ): Promise<AttemptRow> {
      const now = clock.now();
      const nodeId = overrides.nodeId ?? (await factories.node()).id;
      const status = overrides.status ?? 'running';
      const active = status === 'offered' || status === 'running';
      return one(
        db
          .insert(jobAttempts)
          .values({
            id: id(),
            nodeId,
            seq: 0,
            status,
            offeredAt: now,
            acceptedAt: status === 'offered' ? null : now,
            leaseExpiresAt: status === 'offered' ? null : new Date(now.getTime() + 30_000),
            endedAt: active ? null : now,
            ...overrides,
          })
          .returning(),
      );
    },

    /**
     * A ledger account. Owner type and allow_negative follow ACCOUNT_RULES unless overridden; user and
     * store accounts get a fresh owner id unless one is given.
     */
    ledgerAccount(
      overrides: Partial<typeof ledgerAccounts.$inferInsert> & {
        kind: AccountKind;
        currency: Currency;
      },
    ): Promise<LedgerAccountRow> {
      const rule = ACCOUNT_RULES[overrides.kind];
      return one(
        db
          .insert(ledgerAccounts)
          .values({
            id: id(),
            ownerType: rule.owner,
            ownerId: rule.owner === 'platform' ? null : id(),
            allowNegative: rule.negative,
            createdAt: clock.now(),
            ...overrides,
          })
          .returning(),
      );
    },

    /**
     * Write one ledger transaction with its postings. Must run inside a DB transaction (pass a Tx):
     * the balance check runs at COMMIT. For tests and the seed only (see the file comment).
     */
    async ledgerEntry(options: {
      kind: LedgerTxKind;
      idempotencyKey: string;
      postings: readonly PostingSpec[];
      memo?: string;
    }): Promise<string> {
      const txId = id();
      await db.insert(ledgerTransactions).values({
        id: txId,
        kind: options.kind,
        idempotencyKey: options.idempotencyKey,
        memo: options.memo ?? null,
        createdAt: clock.now(),
      });
      await db.insert(ledgerPostings).values(options.postings.map((p) => ({ txId, ...p })));
      return txId;
    },
  };
  return factories;
}

export type Factories = ReturnType<typeof createFactories>;

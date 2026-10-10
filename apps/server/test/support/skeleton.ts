import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import * as protocol from '@spareon/protocol';
import { FakeAgent, type FakeAgentOptions } from '@spareon/testkit';
import type pg from 'pg';
import { expect } from 'vitest';

import { buildServer, type Server } from '../../src/app.js';
import { parseEnv } from '../../src/config.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import type { GatewayConfig } from '../../src/gateway/gateway.js';
import { systemClock } from '../../src/lib/clock.js';
import { createIds } from '../../src/lib/ids.js';
import { createPayloadCipher } from '../../src/lib/payload-cipher.js';
import type { SchedulerConfig } from '../../src/scheduler/scheduler.js';
import { ensureSkeletonWorld, type SkeletonWorld } from '../../src/skeleton/bootstrap.js';
import { openTestDb, type TestDb } from './db.js';
import { balanceOf, ledgerBalanced } from './ledger.js';

export const TEST_API_KEY = 'test-api-key-0123456789abcdef';
export const TEST_AGENT_SECRET = 'test-agent-secret-0123456789abcdef';

/** Short timings so lifecycle tests run in seconds (the production values are in DEFAULT_*_CONFIG). */
export const FAST_SCHEDULER: Partial<SchedulerConfig> = {
  offerTimeoutMs: 400,
  leaseMs: 1_500,
  queueWaitMs: 3_000,
  sweepIntervalMs: 50,
};

export interface Harness {
  readonly db: TestDb;
  readonly app: DbHandle;
  readonly server: Server;
  readonly world: SkeletonWorld;
  readonly baseUrl: string;
  readonly wsUrl: string;
  agent(name: string, opts?: Partial<FakeAgentOptions>): Promise<FakeAgent>;
  chat(body: unknown, init?: { apiKey?: string | null; signal?: AbortSignal }): Promise<Response>;
  query<T extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<T[]>;
  /**
   * Build another server process on the same database (same world, keys and settings), not yet
   * listening: restart and second-instance tests. The caller closes it.
   */
  anotherServer(): Promise<Server>;
  close(): Promise<void>;
}

export async function startHarness(
  options: {
    scheduler?: Partial<SchedulerConfig>;
    gateway?: Partial<GatewayConfig>;
    topupCr?: bigint;
    dashboard?: boolean;
  } = {},
): Promise<Harness> {
  const db = await openTestDb();
  // The server's own connection runs as the least-privilege role, exactly as in production (S03).
  const app = createDb({ url: db.url, role: 'spareon_app', maxConnections: 8 });
  const clock = systemClock;
  const ids = createIds(clock);
  const world = await ensureSkeletonWorld(
    app.db,
    { clock, ids },
    { topupCr: options.topupCr ?? 10n },
  );
  const env = parseEnv({
    NODE_ENV: 'test',
    DEV_API_KEY: TEST_API_KEY,
    DEV_AGENT_SECRET: TEST_AGENT_SECRET,
    ...(options.dashboard === true ? { DEV_DASHBOARD: '1' } : {}),
  });
  const cipher = createPayloadCipher(randomBytes(32).toString('hex'), 'test');
  const build = (): Promise<Server> =>
    buildServer({
      clock,
      ids,
      env,
      db: app.db,
      pool: app.pool,
      world,
      cipher,
      scheduler: { ...FAST_SCHEDULER, ...options.scheduler },
      ...(options.gateway === undefined ? {} : { gateway: options.gateway }),
    });
  const server = await build();
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = server.app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const wsUrl = `ws://127.0.0.1:${String(port)}/agent/v1/ws`;
  const agents: FakeAgent[] = [];
  return {
    db,
    app,
    server,
    world,
    baseUrl,
    wsUrl,
    async agent(name, opts = {}) {
      const a = await FakeAgent.connect({
        url: wsUrl,
        secret: TEST_AGENT_SECRET,
        name,
        protocol,
        heartbeatMs: 1_000,
        ...opts,
      });
      agents.push(a);
      return a;
    },
    chat(body, init = {}) {
      const key = init.apiKey === undefined ? TEST_API_KEY : init.apiKey;
      return fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key === null ? {} : { authorization: `Bearer ${key}` }),
        },
        body: JSON.stringify(body),
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      });
    },
    query: async <T extends pg.QueryResultRow>(text: string, values?: unknown[]) =>
      (await db.pool.query<T>(text, values)).rows,
    anotherServer: build,
    async close() {
      await Promise.all(agents.map((a) => a.kill()));
      await server.app.close();
      await app.close();
      await db.cleanup();
    },
  };
}

/** Poll until `check` returns a truthy value (fails the test after `timeoutMs`). */
export async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
  what = 'condition',
): Promise<void> {
  const end = performance.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export const chatBody = (content: string, extra: Record<string, unknown> = {}) => ({
  model: 'fake-echo',
  messages: [{ role: 'user', content }],
  max_tokens: 16,
  ...extra,
});

/** Facts every finished job must satisfy, whatever happened on the way. */
export async function expectSettled(h: Harness): Promise<void> {
  const open = await h.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM jobs WHERE status IN ('queued', 'offered', 'running')`,
  );
  expect(open[0]?.n).toBe(0);
  const activeAttempts = await h.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM job_attempts WHERE status IN ('offered', 'running')`,
  );
  expect(activeAttempts[0]?.n).toBe(0);
  const activeHolds = await h.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM holds WHERE status = 'active'`,
  );
  expect(activeHolds[0]?.n).toBe(0);
  // Completed jobs were captured exactly once, the others released exactly once (no double charge).
  const money = await h.query<{ status: string; captures: number; releases: number }>(
    `SELECT j.status,
            count(*) FILTER (WHERE t.kind = 'JOB_CAPTURE')::int AS captures,
            count(*) FILTER (WHERE t.kind = 'JOB_RELEASE')::int AS releases
       FROM jobs j LEFT JOIN ledger_transactions t ON t.idempotency_key LIKE 'job:' || j.id || ':%'
      GROUP BY j.id, j.status`,
  );
  for (const m of money) {
    if (m.status === 'completed') expect([m.captures, m.releases]).toEqual([1, 0]);
    else expect([m.captures, m.releases]).toEqual([0, 1]);
  }
  expect(await ledgerBalanced(h.db)).toBe(true);
  // Buyer total (wallet + hold) = top-up − captured costs.
  const captured = await h.query<{ total: string }>(
    `SELECT coalesce(sum(cost_ucr), 0)::text AS total FROM jobs WHERE status = 'completed'`,
  );
  const wallet = await balanceOf(h.db, 'buyer_wallet', h.world.buyerId);
  const hold = await balanceOf(h.db, 'buyer_hold', h.world.buyerId);
  expect(wallet + hold).toBe(10n * 1_000_000n - BigInt(captured[0]?.total ?? '0'));
}

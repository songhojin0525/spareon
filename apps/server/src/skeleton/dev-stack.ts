/**
 * Starts the whole walking-skeleton server for development and demos: a database (DATABASE_URL on this
 * machine, or a temporary embedded Postgres), migrations, the development world, and the server.
 * Used by `pnpm dev:server` (friend-PC demo, docs/DEMO_0.md) and `pnpm demo` (automatic demo).
 * Development only: it refuses NODE_ENV=production and remote databases.
 */
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';

import { startTestDatabase } from '@spareon/testkit';

import { buildServer, type Server } from '../app.js';
import { isNonLoopbackHost, parseEnv, type ServerEnv } from '../config.js';
import { assertSessionRole, createDb, type DbHandle } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { isLocalDatabaseUrl } from '../db/seed.js';
import type { GatewayConfig } from '../gateway/gateway.js';
import { AGENT_WS_PATH } from '../gateway/gateway.js';
import type { Clock } from '../lib/clock.js';
import { createIds } from '../lib/ids.js';
import { createLogger } from '../lib/logger.js';
import { createPayloadCipher } from '../lib/payload-cipher.js';
import type { SchedulerConfig } from '../scheduler/scheduler.js';
import { withGeneratedSecrets } from '../testing/env.js';
import { ensureSkeletonWorld, type SkeletonWorld } from './bootstrap.js';
import { ensureDevBuyer } from './dev-buyer.js';

export interface DevStackOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  /** Bind 0.0.0.0 so PCs on the same network can connect (explicit opt-in only). */
  readonly lan?: boolean;
  readonly port?: number;
  readonly topupCr?: bigint;
  readonly logger?: boolean;
  readonly scheduler?: Partial<SchedulerConfig>;
  readonly gateway?: Partial<GatewayConfig>;
  readonly log?: (line: string) => void;
}

/** The skeleton world plus the development buyer (real account and API key). */
export type DevWorld = SkeletonWorld & { readonly buyerId: string };

export interface DevStack {
  readonly server: Server;
  readonly env: ServerEnv;
  readonly world: DevWorld;
  readonly app: DbHandle;
  readonly httpUrl: string;
  readonly wsUrl: string;
  /** ws:// URLs other PCs on this network can use (LAN mode only). */
  readonly lanWsUrls: readonly string[];
  readonly apiKey: string;
  readonly agentSecret: string;
  /** Secrets generated for this run because the environment did not set them. */
  readonly generatedSecrets: readonly string[];
  readonly temporaryDatabase: boolean;
  readonly adminUrl: string;
  stop(): Promise<void>;
}

export class DevStackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevStackError';
  }
}

const devSecret = (prefix: string): string => `${prefix}-${randomBytes(16).toString('hex')}`;

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

export async function startDevStack(options: DevStackOptions): Promise<DevStack> {
  const log = options.log ?? (() => undefined);
  if (options.env['NODE_ENV'] === 'production') {
    throw new DevStackError('the development server refuses NODE_ENV=production');
  }
  // Blank counts as unset (as in parseEnv): a fresh secret is generated instead of an empty one.
  const given = (name: string): string | undefined => {
    const v = options.env[name];
    return v === undefined || v.trim() === '' ? undefined : v;
  };
  const agentSecret = given('DEV_AGENT_SECRET') ?? devSecret('dev-agent');
  if (options.lan !== true && given('HOST') !== undefined) {
    log('HOST is ignored by the development server: it listens on 127.0.0.1 unless --lan is given');
  }
  if (given('DEV_API_KEY') !== undefined) {
    log('DEV_API_KEY is ignored: since S05 the development server creates a real buyer API key');
  }

  let adminUrl = given('DATABASE_URL');
  let stopDb: () => Promise<void> = () => Promise.resolve();
  const temporaryDatabase = adminUrl === undefined;
  if (adminUrl === undefined) {
    log('starting a temporary embedded PostgreSQL (data is deleted when the server stops)...');
    const pg = await startTestDatabase({ env: {} });
    adminUrl = pg.adminUrl;
    stopDb = () => pg.stop();
  } else if (!isLocalDatabaseUrl(adminUrl)) {
    throw new DevStackError(
      'DATABASE_URL must point at this machine (localhost) for the development server',
    );
  }
  const port = options.port ?? (given('PORT') === undefined ? 8080 : Number(given('PORT')));
  const rest = Object.fromEntries(Object.entries(options.env).filter(([k]) => k !== 'DEV_API_KEY'));
  const filled = withGeneratedSecrets(
    { ...rest, DATABASE_URL: adminUrl },
    { databaseUrl: adminUrl, port },
  );
  let env: ServerEnv;
  try {
    env = parseEnv({
      ...filled.env,
      NODE_ENV: 'development',
      DEV_AGENT_SECRET: agentSecret,
      // Only the explicit --lan flag opens the server to other machines (S04 "하지 말 것").
      HOST: options.lan === true ? '0.0.0.0' : '127.0.0.1',
      PORT: String(port),
    });
  } catch (err) {
    await stopDb();
    throw err;
  }
  const generatedSecrets = [
    ...filled.generated.filter((k) => k !== 'DATABASE_URL'),
    ...(given('DEV_AGENT_SECRET') === undefined ? ['DEV_AGENT_SECRET'] : []),
  ];

  let app: DbHandle | undefined;
  let server: Server | undefined;
  try {
    await migrate({
      url: adminUrl,
      log: (line) => {
        log(line);
      },
    });
    // The server itself always runs with the least-privilege role (S03).
    app = createDb({ url: adminUrl, role: env.DB_ROLE, applicationName: 'spareon-dev-server' });
    await assertSessionRole(app, env.DB_ROLE);
    const ids = createIds(options.clock);
    const skeleton = await ensureSkeletonWorld(app.db, { clock: options.clock, ids });
    const apiKeyDeps = {
      clock: options.clock,
      ids,
      pepper: env.API_KEY_PEPPER,
      pepperId: env.API_KEY_PEPPER_ID,
      mode: env.PAYMENTS_MODE,
    };
    const buyer = await ensureDevBuyer(app.db, apiKeyDeps, { topupCr: options.topupCr ?? 100n });
    const world: DevWorld = { ...skeleton, buyerId: buyer.buyerId };
    if (generatedSecrets.includes('DATA_ENCRYPTION_KEY')) {
      // Ephemeral key: inputs stored before a restart cannot be read after it (harmless for demos).
      log('DATA_ENCRYPTION_KEY is not set: using a temporary key for this run');
    }
    server = await buildServer({
      clock: options.clock,
      ids,
      env,
      db: app.db,
      pool: app.pool,
      world,
      cipher: createPayloadCipher(env.DATA_ENCRYPTION_KEY, env.DATA_ENCRYPTION_KEY_ID),
      ...(options.logger === true ? { logger: createLogger({ level: env.LOG_LEVEL }) } : {}),
      ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
      ...(options.gateway === undefined ? {} : { gateway: options.gateway }),
    });
    // listen() runs onReady (instance lock, recovery, sweeps) before it opens the port: when the port
    // is taken, the catch below must close the server or the held lock keeps the pool from closing.
    await server.app.listen({ host: env.HOST, port: env.PORT });
    const { port } = server.app.server.address() as AddressInfo;
    const local = `127.0.0.1:${String(port)}`;
    const appHandle = app;
    const started = server;
    const lan = isNonLoopbackHost(env.HOST);
    return {
      server,
      env,
      world,
      app: appHandle,
      httpUrl: `http://${local}`,
      wsUrl: `ws://${local}${AGENT_WS_PATH}`,
      lanWsUrls: lan
        ? lanAddresses().map((ip) => `ws://${ip}:${String(port)}${AGENT_WS_PATH}`)
        : [],
      apiKey: buyer.apiKey,
      agentSecret,
      generatedSecrets,
      temporaryDatabase,
      adminUrl,
      async stop() {
        await started.app.close();
        await appHandle.close();
        await stopDb();
      },
    };
  } catch (err) {
    await server?.app.close();
    await app?.close();
    await stopDb();
    throw err;
  }
}

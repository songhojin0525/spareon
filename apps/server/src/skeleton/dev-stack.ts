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
import { createPayloadCipher } from '../lib/payload-cipher.js';
import type { SchedulerConfig } from '../scheduler/scheduler.js';
import { ensureSkeletonWorld, type SkeletonWorld } from './bootstrap.js';

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

export interface DevStack {
  readonly server: Server;
  readonly env: ServerEnv;
  readonly world: SkeletonWorld;
  readonly app: DbHandle;
  readonly httpUrl: string;
  readonly wsUrl: string;
  /** ws:// URLs other PCs on this network can use (LAN mode only). */
  readonly lanWsUrls: readonly string[];
  readonly apiKey: string;
  readonly agentSecret: string;
  readonly generatedSecrets: boolean;
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
  // Blank counts as unset (as in parseEnv): a fresh key is generated instead of an empty one.
  const given = (name: string): string | undefined => {
    const v = options.env[name];
    return v === undefined || v.trim() === '' ? undefined : v;
  };
  const apiKey = given('DEV_API_KEY') ?? devSecret('dev-key');
  const agentSecret = given('DEV_AGENT_SECRET') ?? devSecret('dev-agent');
  const generatedSecrets =
    given('DEV_API_KEY') === undefined || given('DEV_AGENT_SECRET') === undefined;
  if (options.lan !== true && given('HOST') !== undefined) {
    log('HOST is ignored by the development server: it listens on 127.0.0.1 unless --lan is given');
  }
  const env = parseEnv({
    ...options.env,
    NODE_ENV: 'development',
    DEV_API_KEY: apiKey,
    DEV_AGENT_SECRET: agentSecret,
    // Only the explicit --lan flag opens the server to other machines (S04 "하지 말 것").
    HOST: options.lan === true ? '0.0.0.0' : '127.0.0.1',
    PORT: String(options.port ?? options.env['PORT'] ?? 8080),
  });

  let adminUrl = env.DATABASE_URL;
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

  let app: DbHandle | undefined;
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
    const world = await ensureSkeletonWorld(
      app.db,
      { clock: options.clock, ids },
      {
        topupCr: options.topupCr ?? 100n,
      },
    );
    let keyHex = env.DATA_ENCRYPTION_KEY;
    if (keyHex === undefined) {
      // Ephemeral key: inputs stored before a restart cannot be read after it (harmless for demos).
      keyHex = randomBytes(32).toString('hex');
      log('DATA_ENCRYPTION_KEY is not set: using a temporary key for this run');
    }
    const server = await buildServer({
      clock: options.clock,
      ids,
      env,
      db: app.db,
      pool: app.pool,
      world,
      cipher: createPayloadCipher(keyHex, env.DATA_ENCRYPTION_KEY_ID),
      logger: options.logger ?? false,
      ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
      ...(options.gateway === undefined ? {} : { gateway: options.gateway }),
    });
    await server.app.listen({ host: env.HOST, port: env.PORT });
    const { port } = server.app.server.address() as AddressInfo;
    const local = `127.0.0.1:${String(port)}`;
    const appHandle = app;
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
      apiKey,
      agentSecret,
      generatedSecrets,
      temporaryDatabase,
      adminUrl,
      async stop() {
        await server.app.close();
        await appHandle.close();
        await stopDb();
      },
    };
  } catch (err) {
    await app?.close();
    await stopDb();
    throw err;
  }
}

import websocket from '@fastify/websocket';
import { LIMITS } from '@spareon/protocol';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';

import { registerChatCompletions } from './buyer-api/chat-completions.js';
import { devDashboardEnabled, type ServerEnv } from './config.js';
import type { Db } from './db/client.js';
import { registerDevDashboard } from './dev/dashboard.js';
import { DEFAULT_GATEWAY_CONFIG, type GatewayConfig, registerGateway } from './gateway/gateway.js';
import { SessionRegistry } from './gateway/session.js';
import type { Clock } from './lib/clock.js';
import { createIds, type Ids } from './lib/ids.js';
import type { PayloadCipher } from './lib/payload-cipher.js';
import { acquireInstanceLock, type InstanceLock } from './scheduler/instance-lock.js';
import {
  DEFAULT_SCHEDULER_CONFIG,
  Scheduler,
  type SchedulerConfig,
} from './scheduler/scheduler.js';
import { ensureDevModel, type SkeletonWorld } from './skeleton/bootstrap.js';

export interface AppDeps {
  readonly clock: Clock;
  readonly logger?: FastifyServerOptions['logger'];
}

export interface HealthResponse {
  readonly status: 'ok';
  readonly time: string;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });

  app.get('/healthz', (): HealthResponse => ({
    status: 'ok',
    time: deps.clock.now().toISOString(),
  }));

  return app;
}

export interface ServerDeps extends AppDeps {
  readonly env: ServerEnv;
  /** Database handle running as spareon_app (createDb({ role })). */
  readonly db: Db;
  /** The pool behind `db` (the scheduler instance lock holds one of its connections). */
  readonly pool: pg.Pool;
  readonly world: SkeletonWorld;
  readonly cipher: PayloadCipher;
  readonly ids?: Ids;
  readonly scheduler?: Partial<SchedulerConfig>;
  readonly gateway?: Partial<GatewayConfig>;
}

export interface Server {
  readonly app: FastifyInstance;
  readonly scheduler: Scheduler;
  readonly sessions: SessionRegistry;
}

/**
 * The walking-skeleton server: health, agent gateway, buyer chat completions and (development only) the
 * /dev dashboard. SKELETON(S05): the composition root with route permissions arrives with S05.
 */
export async function buildServer(deps: ServerDeps): Promise<Server> {
  const app = buildApp(deps);
  const ids = deps.ids ?? createIds(deps.clock);
  const sessions = new SessionRegistry();
  const scheduler = new Scheduler({
    db: deps.db,
    clock: deps.clock,
    ids,
    cipher: deps.cipher,
    sessions,
    buyerPriceVersionId: deps.world.priceVersionId,
    log: app.log,
    config: { ...DEFAULT_SCHEDULER_CONFIG, ...deps.scheduler },
  });

  await app.register(websocket, {
    // A little above the protocol limit so the codec (not the socket) reports message_too_large.
    options: { maxPayload: LIMITS.maxMessageBytes + 1024 },
  });
  registerGateway(app, {
    db: deps.db,
    clock: deps.clock,
    ids,
    sessions,
    sink: scheduler,
    storeId: deps.world.storeId,
    devAgentSecret: deps.env.DEV_AGENT_SECRET,
    onModelSeen: (slug) => ensureDevModel(deps.db, { clock: deps.clock, ids }, slug),
    log: app.log,
    config: { ...DEFAULT_GATEWAY_CONFIG, ...deps.gateway },
  });
  registerChatCompletions(app, {
    scheduler,
    devApiKey: deps.env.DEV_API_KEY,
    devBuyerId: deps.world.buyerId,
    clock: deps.clock,
  });
  if (devDashboardEnabled(deps.env)) {
    registerDevDashboard(app, { db: deps.db, clock: deps.clock, sessions, world: deps.world });
  }

  // One scheduling process per database (the instance lock): a second one would take the first one's
  // live jobs for leftovers of a dead process and cancel them. listen() fails when the lock is held.
  let lock: InstanceLock | undefined;
  app.addHook('onReady', async () => {
    lock = await acquireInstanceLock(deps.pool, app.log, () => {
      // Without the lock another process may start and cancel our jobs as leftovers: stop scheduling.
      scheduler.halt();
    });
    try {
      await scheduler.recoverAfterRestart();
      scheduler.start();
    } catch (err) {
      await scheduler.stop();
      await lock.release();
      lock = undefined;
      throw err;
    }
  });
  app.addHook('onClose', async () => {
    await scheduler.stop();
    await lock?.release();
    lock = undefined;
  });
  return { app, scheduler, sessions };
}

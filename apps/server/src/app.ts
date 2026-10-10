import websocket from '@fastify/websocket';
import { LIMITS } from '@spareon/protocol';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  LogController,
} from 'fastify';
import type pg from 'pg';
import { z } from 'zod';

import { type AuthConfig, AuthService, DEFAULT_AUTH_CONFIG } from './auth/service.js';
import { purgeSessions, type SessionConfig } from './auth/sessions.js';
import { devDashboardEnabled, secureCookies, type ServerEnv, trustProxyList } from './config.js';
import type { Db } from './db/client.js';
import { registerDevDashboard } from './dev/dashboard.js';
import { DEFAULT_GATEWAY_CONFIG, type GatewayConfig, registerGateway } from './gateway/gateway.js';
import { SessionRegistry } from './gateway/session.js';
import { cookieNames } from './http/cookies.js';
import { buildOpenApi } from './http/openapi.js';
import { type HttpContext, Router } from './http/router.js';
import { registerAuthRoutes } from './http/routes/auth.js';
import { registerBuyerRoutes } from './http/routes/buyer.js';
import { registerOpsRoutes } from './http/routes/ops.js';
import { registerResourceRoutes } from './http/routes/resources.js';
import type { Clock } from './lib/clock.js';
import { deriveKey } from './lib/crypto.js';
import { AppError, fromFrameworkError, internalError, openAiErrorType } from './lib/errors.js';
import {
  DEFAULT_IDEMPOTENCY_CONFIG,
  Idempotency,
  type IdempotencyConfig,
} from './lib/idempotency.js';
import { createIds, type Ids } from './lib/ids.js';
import type { Logger } from './lib/logger.js';
import type { PayloadCipher } from './lib/payload-cipher.js';
import { ConcurrencyLimiter, MemoryRateLimiter, type RateLimiter } from './lib/rate-limit.js';
import { safeErrorText } from './lib/safe-error.js';
import { SettingsStore } from './lib/settings.js';
import { acquireInstanceLock, type InstanceLock } from './scheduler/instance-lock.js';
import {
  DEFAULT_SCHEDULER_CONFIG,
  Scheduler,
  type SchedulerConfig,
} from './scheduler/scheduler.js';
import { ensureDevModel, type SkeletonWorld } from './skeleton/bootstrap.js';

export interface AppDeps {
  readonly clock: Clock;
  readonly ids?: Ids;
  /** A pino logger from lib/logger.ts (redaction paths applied). Omitted: no logging. */
  readonly logger?: Logger;
  /** Proxies allowed to set X-Forwarded-For (ADR 0012). */
  readonly trustProxy?: string[] | false;
}

export interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
}

const routesByApp = new WeakMap<FastifyInstance, RegisteredRoute[]>();

/** Every route registered on an app built by buildApp (the route ↔ permission table test reads it). */
export function registeredRoutes(app: FastifyInstance): readonly RegisteredRoute[] {
  return routesByApp.get(app) ?? [];
}

export interface HealthResponse {
  readonly status: 'ok';
  readonly time: string;
}

/** One error shape everywhere; the buyer API adds the OpenAI `type`. Never internal details. */
function sendAppError(req: FastifyRequest, reply: FastifyReply, e: AppError): FastifyReply {
  for (const [k, v] of Object.entries(e.headers ?? {})) void reply.header(k, v);
  const isBuyerApi = req.url.startsWith('/v1/');
  return reply.code(e.httpStatus).send({
    error: {
      code: e.code,
      message: e.publicMessage,
      requestId: req.id,
      ...(isBuyerApi ? { type: openAiErrorType(e.httpStatus) } : {}),
      ...(e.details === undefined ? {} : { details: e.details }),
    },
  });
}

/**
 * The bare HTTP application: logging (minimal request lines, redaction), request ids, the error
 * format and /healthz. buildServer adds every other route.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const ids = deps.ids ?? createIds(deps.clock);
  const app = Fastify({
    ...(deps.logger === undefined ? { logger: false } : { loggerInstance: deps.logger }),
    // Our own request line below logs method, route and status only (never headers or bodies).
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'requestId',
    }),
    // Server-made ids only: a client-supplied request id could be used to forge log lines.
    genReqId: () => ids.newId(),
    trustProxy: deps.trustProxy ?? false,
  }) as unknown as FastifyInstance;

  const routes: RegisteredRoute[] = [];
  routesByApp.set(app, routes);
  app.addHook('onRoute', (opts) => {
    for (const method of [opts.method].flat()) {
      // HEAD routes are added automatically for every GET.
      if (method !== 'HEAD') routes.push({ method, url: opts.url });
    }
  });

  app.addHook('onRequest', (req, reply, done) => {
    void reply.header('x-request-id', req.id);
    done();
  });
  app.addHook('onResponse', (req, reply, done) => {
    req.log.info(
      {
        method: req.method,
        route: req.routeOptions.url ?? 'unknown',
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
      'request',
    );
    done();
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.httpStatus >= 500) req.log.error({ code: err.code }, 'request failed');
      else req.log.info({ code: err.code, status: err.httpStatus }, 'request rejected');
      return sendAppError(req, reply, err);
    }
    const client = fromFrameworkError(err);
    if (client !== undefined) {
      // Framework client errors (malformed JSON, too large): the code only — their messages can
      // quote the body.
      req.log.info({ code: client.code, status: client.httpStatus }, 'request rejected');
      return sendAppError(req, reply, client);
    }
    // The error serializer (lib/logger.ts) keeps a log-safe message and the stack; never the request.
    req.log.error({ err }, 'request failed');
    return sendAppError(req, reply, internalError());
  });
  app.setNotFoundHandler((req, reply) =>
    sendAppError(req, reply, new AppError('not_found', 404, 'Not found.')),
  );

  app.get('/healthz', (): HealthResponse => ({
    status: 'ok',
    time: deps.clock.now().toISOString(),
  }));

  return app;
}

export interface ServerDeps {
  readonly clock: Clock;
  readonly logger?: Logger;
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
  readonly auth?: Partial<AuthConfig>;
  readonly idempotency?: Partial<IdempotencyConfig>;
  readonly limiter?: RateLimiter;
  /** Sessions and idempotency keys past their life are deleted this often (default 10 min). */
  readonly maintenanceIntervalMs?: number;
}

export interface Server {
  readonly app: FastifyInstance;
  readonly scheduler: Scheduler;
  readonly sessions: SessionRegistry;
  readonly router: Router;
  readonly http: HttpContext;
  readonly idempotency: Idempotency;
}

const DAY_MS = 86_400_000;

/**
 * The composition root: health, the people and buyer HTTP API (permission table, sessions, API keys,
 * audit, idempotency), the agent gateway and (development only) the /dev dashboard.
 */
export async function buildServer(deps: ServerDeps): Promise<Server> {
  const ids = deps.ids ?? createIds(deps.clock);
  const { env, clock } = deps;
  const app = buildApp({
    clock,
    ids,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    trustProxy: trustProxyList(env),
  });
  const sessions = new SessionRegistry();
  const scheduler = new Scheduler({
    db: deps.db,
    clock,
    ids,
    cipher: deps.cipher,
    sessions,
    buyerPriceVersionId: deps.world.priceVersionId,
    log: app.log,
    config: { ...DEFAULT_SCHEDULER_CONFIG, ...deps.scheduler },
  });

  const sessionConfig: SessionConfig = {
    idleMs: env.SESSION_IDLE_DAYS * DAY_MS,
    absoluteMs: env.SESSION_ABSOLUTE_DAYS * DAY_MS,
    touchIntervalMs: 60_000,
  };
  const secure = secureCookies(env);
  const http: HttpContext = {
    db: deps.db,
    clock,
    ids,
    env,
    limiter: deps.limiter ?? new MemoryRateLimiter({ clock }),
    concurrency: new ConcurrencyLimiter(),
    settings: new SettingsStore(deps.db, clock),
    session: sessionConfig,
    cookies: cookieNames(secure),
    secureCookies: secure,
    csrfKey: deriveKey(env.SESSION_SECRET, 'csrf'),
    ipKey: deriveKey(env.SESSION_SECRET, 'ip-hash'),
    apiKeys: {
      clock,
      ids,
      pepper: env.API_KEY_PEPPER,
      pepperId: env.API_KEY_PEPPER_ID,
      mode: env.PAYMENTS_MODE,
    },
  };
  const auth = new AuthService({
    db: deps.db,
    clock,
    ids,
    limiter: http.limiter,
    session: sessionConfig,
    config: { ...DEFAULT_AUTH_CONFIG, ...deps.auth },
  });
  const idempotencyConfig = { ...DEFAULT_IDEMPOTENCY_CONFIG, ...deps.idempotency };
  const idempotency = new Idempotency(deps.db, clock, idempotencyConfig);
  const router = new Router(app, http);

  router.add({
    action: 'health.ready',
    summary: 'Ready to serve: the database answers',
    tags: ['health'],
    errors: [503],
    response: z.object({ status: z.literal('ready') }),
    handler: async () => {
      try {
        await deps.pool.query('SELECT 1');
      } catch {
        throw new AppError('not_ready', 503, 'The database is not reachable.');
      }
      return { status: 'ready' as const };
    },
  });
  router.add({
    action: 'docs.openapi',
    summary: 'This OpenAPI 3.1 document',
    tags: ['docs'],
    handler: () =>
      Promise.resolve(
        buildOpenApi(router.defs, { version: '0.1.0-dev', serverUrl: env.PUBLIC_BASE_URL }),
      ),
  });
  registerAuthRoutes(router, auth);
  registerResourceRoutes(router);
  registerOpsRoutes(router);
  registerBuyerRoutes(router, {
    scheduler,
    clock,
    idempotency,
    payloads: { db: deps.db, clock, ids, cipher: deps.cipher },
    replayRetentionMs: idempotencyConfig.ttlMs,
  });

  await app.register(websocket, {
    // A little above the protocol limit so the codec (not the socket) reports message_too_large.
    options: { maxPayload: LIMITS.maxMessageBytes + 1024 },
  });
  registerGateway(app, {
    db: deps.db,
    clock,
    ids,
    sessions,
    sink: scheduler,
    storeId: deps.world.storeId,
    devAgentSecret: env.DEV_AGENT_SECRET,
    onModelSeen: (slug) => ensureDevModel(deps.db, { clock, ids }, slug),
    log: app.log,
    config: { ...DEFAULT_GATEWAY_CONFIG, ...deps.gateway },
  });
  if (devDashboardEnabled(env)) {
    registerDevDashboard(app, { db: deps.db, clock, sessions, world: deps.world });
  }

  // Housekeeping: dead sessions and expired idempotency keys (DB.md: deleted after expiry).
  let maintenance: NodeJS.Timeout | undefined;
  const runMaintenance = async (): Promise<void> => {
    try {
      await purgeSessions(deps.db, { clock, ids, config: sessionConfig });
      await idempotency.purgeExpired();
    } catch (err) {
      app.log.error({ err: safeErrorText(err) }, 'maintenance failed');
    }
  };

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
    maintenance = setInterval(() => void runMaintenance(), deps.maintenanceIntervalMs ?? 600_000);
    maintenance.unref();
  });
  app.addHook('onClose', async () => {
    clearInterval(maintenance);
    await scheduler.stop();
    await lock?.release();
    lock = undefined;
  });
  return { app, scheduler, sessions, router, http, idempotency };
}

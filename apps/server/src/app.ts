import Fastify, { type FastifyInstance } from 'fastify';

import type { Clock } from './lib/clock.js';

export interface AppDeps {
  readonly clock: Clock;
  readonly logger?: boolean;
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

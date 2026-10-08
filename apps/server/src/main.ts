import { buildApp } from './app.js';
import { parseEnv } from './config.js';
import { systemClock } from './lib/clock.js';

const env = parseEnv(process.env);
const app = buildApp({ clock: systemClock, logger: true });

const shutdown = (signal: string): void => {
  app.log.info({ signal }, 'shutting down');
  app.close().then(
    () => process.exit(0),
    (err: unknown) => {
      app.log.error({ err }, 'shutdown failed');
      process.exit(1);
    },
  );
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ host: env.HOST, port: env.PORT });

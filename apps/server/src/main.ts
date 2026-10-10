/**
 * Production entry point: validate the environment (exit with the list of problems when it is wrong),
 * connect as the least-privilege role, load the skeleton world (store and price version until S08/S10;
 * no development buyer, no top-up) and serve. Reads ./.env when present (never committed).
 */
import { buildServer } from './app.js';
import { ConfigError, parseEnv } from './config.js';
import { assertSessionRole, createDb } from './db/client.js';
import { systemClock } from './lib/clock.js';
import { createIds } from './lib/ids.js';
import { createLogger } from './lib/logger.js';
import { createPayloadCipher } from './lib/payload-cipher.js';
import { safeErrorText } from './lib/safe-error.js';
import { ensureSkeletonWorld } from './skeleton/bootstrap.js';

function loadDotEnv(): void {
  try {
    process.loadEnvFile('.env');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

loadDotEnv();
let env;
try {
  env = parseEnv(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write('spareon server: invalid configuration, refusing to start:\n');
    for (const issue of err.issues) process.stderr.write(`  - ${issue}\n`);
    process.stderr.write('See apps/server/.env.example for every variable.\n');
    process.exit(1);
  }
  throw err;
}

const logger = createLogger({ level: env.LOG_LEVEL });
const clock = systemClock;
const ids = createIds(clock);
const handle = createDb({
  url: env.DATABASE_URL,
  role: env.DB_ROLE,
  onIdleClientError: (err) => {
    logger.error({ err: safeErrorText(err) }, 'idle database connection failed');
  },
});
try {
  await assertSessionRole(handle, env.DB_ROLE);
} catch (err) {
  logger.fatal({ err: safeErrorText(err) }, 'database role check failed');
  await handle.close();
  process.exit(1);
}
const world = await ensureSkeletonWorld(handle.db, { clock, ids });
const server = await buildServer({
  clock,
  ids,
  logger,
  env,
  db: handle.db,
  pool: handle.pool,
  world,
  cipher: createPayloadCipher(env.DATA_ENCRYPTION_KEY, env.DATA_ENCRYPTION_KEY_ID),
});

const shutdown = (signal: string): void => {
  logger.info({ signal }, 'shutting down');
  server.app
    .close()
    .then(() => handle.close())
    .then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error({ err: safeErrorText(err) }, 'shutdown failed');
        process.exit(1);
      },
    );
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  await server.app.listen({ host: env.HOST, port: env.PORT });
} catch (err) {
  logger.fatal({ err: safeErrorText(err) }, 'listen failed');
  await server.app.close();
  await handle.close();
  process.exit(1);
}

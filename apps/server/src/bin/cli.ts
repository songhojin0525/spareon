// `pnpm --filter @spareon/server cli <command>` — operator CLI (see cli-commands.ts for the commands).
// Reads ./.env like the server, connects as the least-privilege role, audits every write.
import { userInfo } from 'node:os';

import { ConfigError, parseEnv } from '../config.js';
import { assertSessionRole, createDb } from '../db/client.js';
import { systemClock } from '../lib/clock.js';
import { createIds } from '../lib/ids.js';
import { safeErrorText } from '../lib/safe-error.js';
import { runCli } from './cli-commands.js';

try {
  process.loadEnvFile('.env');
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

let env;
try {
  env = parseEnv(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write('invalid configuration:\n');
    for (const issue of err.issues) process.stderr.write(`  - ${issue}\n`);
    process.exit(1);
  }
  throw err;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const handle = createDb({
  url: env.DATABASE_URL,
  role: env.DB_ROLE,
  applicationName: 'spareon-cli',
  maxConnections: 2,
});
let code = 1;
try {
  await assertSessionRole(handle, env.DB_ROLE);
  code = await runCli(process.argv.slice(2), {
    db: handle.db,
    clock: systemClock,
    ids: createIds(systemClock),
    env,
    osUser: userInfo().username,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    readPassword: readStdin,
  });
} catch (err) {
  process.stderr.write(`failed: ${safeErrorText(err)}\n`);
} finally {
  await handle.close();
}
process.exit(code);

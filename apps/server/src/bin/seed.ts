import { runSeedCli } from '../db/seed.js';
import { systemClock } from '../lib/clock.js';

// Entry point for `pnpm --filter @spareon/server db:seed` (development data, local databases only).
process.exitCode = await runSeedCli(process.env, systemClock, {
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line) => {
    process.stderr.write(`${line}\n`);
  },
});

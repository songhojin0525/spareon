import { runDbCli } from '../db/cli.js';

// Entry point for `pnpm db:migrate`, `pnpm db:rollback`, `pnpm db:status`.
process.exitCode = await runDbCli(process.argv.slice(2), process.env, {
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line) => {
    process.stderr.write(`${line}\n`);
  },
});

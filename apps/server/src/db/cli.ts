import { z } from 'zod';

import { migrate, migrationStatus, rollback } from './migrate.js';

/**
 * `pnpm db:migrate | db:rollback | db:status` (src/bin/db.ts). Kept separate from the entry point so
 * tests can run it in-process. Never prints the connection URL (it contains the password).
 */

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const envSchema = z.object({
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgres:// URL'),
});

const USAGE = [
  'usage: db <command>',
  '  migrate                    apply every pending migration',
  '  status                     list applied and pending migrations',
  '  rollback --yes [--steps N] undo the last N migrations (default 1; data in dropped tables is lost)',
  '  rollback --yes --all       undo every migration (drops every table)',
].join('\n');

function parseRollbackArgs(args: readonly string[]): { steps: number | 'all' } | string {
  let steps: number | 'all' = 1;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--yes') yes = true;
    else if (a === '--all') steps = 'all';
    else if (a === '--steps') {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1) return '--steps needs a positive integer';
      steps = n;
    } else return `unknown option ${String(a)}`;
  }
  if (!yes) return 'rollback destroys data: pass --yes to confirm';
  return { steps };
}

/** Returns the process exit code. */
export async function runDbCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    io.out(USAGE);
    return command === undefined ? 2 : 0;
  }
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    io.err(parsed.error.issues.map((i) => i.message).join('; '));
    return 2;
  }
  const url = parsed.data.DATABASE_URL;
  const log = (m: string): void => {
    io.out(m);
  };
  try {
    switch (command) {
      case 'migrate': {
        if (rest.length > 0) {
          io.err(`migrate takes no options\n${USAGE}`);
          return 2;
        }
        const { applied } = await migrate({ url, log });
        io.out(applied.length === 0 ? 'up to date' : `applied ${String(applied.length)}`);
        return 0;
      }
      case 'status': {
        const s = await migrationStatus({ url });
        for (const t of s.applied) io.out(`applied  ${t}`);
        for (const t of s.pending) io.out(`pending  ${t}`);
        return 0;
      }
      case 'rollback': {
        const opts = parseRollbackArgs(rest);
        if (typeof opts === 'string') {
          io.err(`${opts}\n${USAGE}`);
          return 2;
        }
        const { rolledBack } = await rollback({ url, log, steps: opts.steps });
        io.out(`rolled back ${String(rolledBack.length)}`);
        return 0;
      }
      default:
        io.err(`unknown command ${command}\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    // MigrationError messages name the migration and the Postgres reason, never the URL.
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { redactUrl } from './naming.js';

export type DatabaseSource =
  | {
      readonly kind: 'external';
      readonly url: string;
      readonly envVar: 'TEST_DATABASE_URL' | 'DATABASE_URL';
    }
  | { readonly kind: 'embedded' };

/** TEST_DATABASE_URL wins over DATABASE_URL; with neither, an embedded Postgres is started. Empty values count as unset. */
export function resolveDatabaseSource(
  env: Readonly<Record<string, string | undefined>>,
): DatabaseSource {
  for (const envVar of ['TEST_DATABASE_URL', 'DATABASE_URL'] as const) {
    const value = env[envVar]?.trim();
    if (value !== undefined && value !== '') {
      const protocol = safeProtocol(value);
      if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
        throw new Error(`${envVar} must be a postgres:// URL (got ${redactUrl(value)})`);
      }
      // Safety: tests create and drop databases. DATABASE_URL is often the app's real database, so it is
      // only used for tests when it points at this machine, unless explicitly allowed.
      if (
        envVar === 'DATABASE_URL' &&
        !isLocalHost(value) &&
        env['BINJARI_ALLOW_REMOTE_TEST_DB'] !== '1'
      ) {
        throw new Error(
          `DATABASE_URL points at a remote host (${redactUrl(value)}); tests would create/drop databases there. ` +
            'Set TEST_DATABASE_URL for a dedicated test server, unset DATABASE_URL to use embedded Postgres, ' +
            'or set BINJARI_ALLOW_REMOTE_TEST_DB=1.',
        );
      }
      return { kind: 'external', url: value, envVar };
    }
  }
  return { kind: 'embedded' };
}

/**
 * Conservative: only an explicit loopback hostname counts as local. An empty hostname (target decided
 * by PGHOST) or a `host=` query override (honoured by pg) is treated as possibly remote.
 */
function isLocalHost(value: string): boolean {
  const u = new URL(value);
  if (u.searchParams.has('host') || u.searchParams.has('hostaddr')) return false;
  return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
}

function safeProtocol(value: string): string | undefined {
  try {
    return new URL(value).protocol;
  } catch {
    return undefined;
  }
}

export interface TestDatabase {
  /** Connection URL with rights to CREATE/DROP DATABASE. */
  readonly adminUrl: string;
  readonly source: DatabaseSource['kind'];
  /** Stops the embedded server and removes its files. No-op for external databases. */
  stop(): Promise<void>;
}

export interface StartTestDatabaseOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Receives embedded Postgres log lines (default: kept in memory and shown only on failure). */
  readonly onLog?: (line: string) => void;
}

const MAX_START_ATTEMPTS = 3;

/** Start (or connect to) the PostgreSQL used by tests. See resolveDatabaseSource for precedence. */
export async function startTestDatabase(
  options: StartTestDatabaseOptions = {},
): Promise<TestDatabase> {
  const source = resolveDatabaseSource(options.env ?? process.env);
  if (source.kind === 'external') {
    return { adminUrl: source.url, source: 'external', stop: () => Promise.resolve() };
  }

  // Retry covers the small race between picking a free port and Postgres binding it.
  const errors: string[] = [];
  for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
    try {
      return await startEmbedded(options.onLog);
    } catch (err) {
      errors.push(`attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`Could not start embedded Postgres:\n${errors.join('\n')}`);
}

async function startEmbedded(onLog?: (line: string) => void): Promise<TestDatabase> {
  const root = await mkdtemp(join(tmpdir(), 'binjari-pg-'));
  const port = await getFreePort();
  const password = randomBytes(16).toString('hex');
  const logTail: string[] = [];
  const log = (line: string): void => {
    logTail.push(line);
    if (logTail.length > 50) logTail.shift();
    onLog?.(line);
  };

  // Loaded lazily: importing embedded-postgres installs process exit hooks (see preserveFailingExitCode).
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  preserveFailingExitCode();
  const pg = new EmbeddedPostgres({
    databaseDir: join(root, 'data'),
    port,
    user: 'postgres',
    password,
    authMethod: 'scram-sha-256',
    // We delete the files ourselves (with retries): the library's own delete races the killed process on Windows (EBUSY).
    persistent: true,
    // initdb/postgres refuse to run as root (some cloud containers); embedded-postgres then creates a 'postgres' OS user.
    createPostgresUser: typeof process.getuid === 'function' && process.getuid() === 0,
    initdbFlags: ['--encoding=UTF8', '--no-sync'],
    // Test-only durability shortcuts. Never use these settings for real data.
    postgresFlags: [
      '-c',
      'listen_addresses=127.0.0.1',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
    ],
    onLog: log,
    onError: (e: unknown) => {
      log(`[ERROR] ${e instanceof Error ? e.message : String(e)}`);
    },
  });

  const cleanupFiles = (): Promise<void> =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  try {
    await pg.initialise();
    await pg.start();
  } catch (err) {
    await pg.stop().catch(() => undefined);
    await cleanupFiles().catch(() => undefined);
    // embedded-postgres rejects start() without a reason when postgres exits early (e.g. port taken).
    const reason = err instanceof Error ? err.message : 'postgres exited during startup';
    throw new Error(`${reason} (port ${port}). Last log lines:\n${logTail.join('').slice(-4000)}`, {
      cause: err,
    });
  }

  let stopped = false;
  return {
    adminUrl: `postgres://postgres:${password}@127.0.0.1:${port}/postgres`,
    source: 'embedded',
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        await pg.stop();
      } finally {
        await cleanupFiles();
      }
    },
  };
}

let exitCodeGuardInstalled = false;

/**
 * embedded-postgres pulls in async-exit-hook, which handles 'beforeExit' by calling process.exit(0).
 * Vitest reports failed tests by setting process.exitCode = 1 and letting the process end, so without
 * this guard every failing test run that started an embedded Postgres would exit 0 (a silent pass).
 * We remember the exit code at 'beforeExit' and restore it in 'exit' (Node honours exitCode changes there).
 */
export function preserveFailingExitCode(): void {
  if (exitCodeGuardInstalled) return;
  exitCodeGuardInstalled = true;
  let pending: number | string | null | undefined;
  process.on('beforeExit', () => {
    pending ??= process.exitCode;
  });
  process.on('exit', (code) => {
    if (code === 0 && pending !== undefined && pending !== null && Number(pending) !== 0) {
      process.exitCode = pending;
    }
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = addr;
      srv.close(() => {
        resolve(port);
      });
    });
  });
}

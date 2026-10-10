import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { FakeClock } from '@spareon/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { authenticateApiKey } from '../../src/api-keys/api-keys.js';
import { verifyPassword } from '../../src/auth/password.js';
import { createSession, lookupSession } from '../../src/auth/sessions.js';
import { findUserByEmail } from '../../src/auth/users.js';
import { type CliDeps, runCli } from '../../src/bin/cli-commands.js';
import { parseEnv, type ServerEnv } from '../../src/config.js';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { createIds } from '../../src/lib/ids.js';
import { withGeneratedSecrets } from '../../src/testing/env.js';
import { openTestDb, type TestDb } from '../support/db.js';

describe('operator CLI', () => {
  let testDb: TestDb;
  let app: DbHandle;
  let env: ServerEnv;
  const clock = new FakeClock();
  const ids = createIds(clock);
  let out: string[] = [];
  let errs: string[] = [];
  let stdinPassword = '';

  const run = async (...argv: string[]): Promise<number> => {
    out = [];
    errs = [];
    // One second per command, so audit entries have distinct times.
    clock.advance(1_000);
    const deps: CliDeps = {
      db: app.db,
      clock,
      ids,
      env,
      osUser: 'tester',
      out: (l) => out.push(l),
      err: (l) => errs.push(l),
      readPassword: () => Promise.resolve(stdinPassword),
    };
    return runCli(argv, deps);
  };
  const audit = async (action: string) =>
    (
      await testDb.pool.query<{
        actor_kind: string;
        data: Record<string, unknown>;
        target_id: string;
      }>(
        'SELECT actor_kind, data, target_id FROM audit_log WHERE action = $1 ORDER BY at DESC, id DESC',
        [action],
      )
    ).rows;

  beforeAll(async () => {
    testDb = await openTestDb();
    app = createDb({ url: testDb.url, role: 'spareon_app', maxConnections: 4 });
    env = parseEnv(withGeneratedSecrets({ NODE_ENV: 'test' }, { databaseUrl: testDb.url }).env);
  });
  afterAll(async () => {
    await app.close();
    await testDb.cleanup();
  });

  it('user:create makes an operator with a generated password printed once, audited', async () => {
    expect(await run('user:create', '--role', 'operator', '--email', 'Ops@Test.Spareon')).toBe(0);
    const pw = /password \(shown once\): (\S+)/.exec(out.join('\n'))?.[1] ?? '';
    expect(pw.length).toBeGreaterThanOrEqual(24);
    const u = await findUserByEmail(app.db, 'ops@test.spareon');
    expect(u?.role).toBe('operator');
    expect(await verifyPassword(u?.passwordHash ?? '', pw)).toBe(true);
    const [a] = await audit('user.create');
    expect(a).toMatchObject({ actor_kind: 'system', target_id: u?.id });
    expect(a?.data).toMatchObject({ via: 'cli', osUser: 'tester', role: 'operator' });
    expect(JSON.stringify(a?.data)).not.toContain(pw);
  });

  it('user:create reads --password-stdin and enforces the password policy', async () => {
    stdinPassword = 'short\n';
    expect(
      await run('user:create', '--role', 'owner', '--email', 'o@test.spareon', '--password-stdin'),
    ).toBe(1);
    expect(errs.join()).toMatch(/at least 12/);
    stdinPassword = 'a perfectly fine password\n';
    expect(
      await run('user:create', '--role', 'owner', '--email', 'o@test.spareon', '--password-stdin'),
    ).toBe(0);
    expect(out.join()).not.toMatch(/shown once/);
    const u = await findUserByEmail(app.db, 'o@test.spareon');
    expect(await verifyPassword(u?.passwordHash ?? '', 'a perfectly fine password')).toBe(true);
    expect(await run('user:create', '--role', 'owner', '--email', 'o@test.spareon')).toBe(1);
    expect(errs.join()).toMatch(/already exists/);
    expect(await run('user:create', '--role', 'admin', '--email', 'x@test.spareon')).toBe(1);
  });

  it('key:create prints a working key once; key:revoke ends it; both audited', async () => {
    expect(await run('user:create', '--role', 'buyer', '--email', 'b@test.spareon')).toBe(0);
    expect(
      await run('key:create', '--user', 'b@test.spareon', '--scopes', 'chat', '--rpm', '30'),
    ).toBe(0);
    const key = /API key \(shown once\): (\S+)/.exec(out.join('\n'))?.[1] ?? '';
    const deps = { clock, pepper: env.API_KEY_PEPPER, mode: env.PAYMENTS_MODE };
    const p = await authenticateApiKey(app.db, deps, `Bearer ${key}`);
    expect(p).toMatchObject({ scopes: ['chat'], rateLimitRpm: 30 });
    const [a] = await audit('api_key.create');
    expect(JSON.stringify(a?.data)).not.toContain(key.split('_')[3] ?? 'x');
    expect(await run('key:revoke', '--prefix', p?.prefix ?? '')).toBe(0);
    expect(await authenticateApiKey(app.db, deps, `Bearer ${key}`)).toBeUndefined();
    expect((await audit('api_key.revoke'))[0]?.target_id).toBe(p?.apiKeyId);
    // Keys belong to buyers only.
    expect(await run('key:create', '--user', 'o@test.spareon')).not.toBe(0);
  });

  it('user:disable and user:set-password end sessions', async () => {
    const u = await findUserByEmail(app.db, 'o@test.spareon');
    const sessionDeps = {
      clock,
      ids,
      config: { idleMs: 86_400_000, absoluteMs: 86_400_000 * 2, touchIntervalMs: 60_000 },
    };
    const s1 = await createSession(app.db, sessionDeps, { userId: u?.id ?? '' });
    expect(await run('user:set-password', '--email', 'o@test.spareon')).toBe(0);
    expect(await lookupSession(app.db, sessionDeps, s1.token)).toBeUndefined();
    expect((await audit('user.set_password'))[0]?.target_id).toBe(u?.id);
    const s2 = await createSession(app.db, sessionDeps, { userId: u?.id ?? '' });
    expect(await run('user:disable', '--email', 'o@test.spareon')).toBe(0);
    expect(await lookupSession(app.db, sessionDeps, s2.token)).toBeUndefined();
    expect((await findUserByEmail(app.db, 'o@test.spareon'))?.disabledAt).not.toBeNull();
    expect(await run('user:disable', '--email', 'nobody@test.spareon')).toBe(1);
  });

  it('settings:get/set validate against the registry and audit the change', async () => {
    expect(await run('settings:get', 'auth.signup_enabled')).toBe(0);
    expect(out).toEqual(['true']);
    expect(await run('settings:set', 'auth.signup_enabled', 'false')).toBe(0);
    expect(await run('settings:get', 'auth.signup_enabled')).toBe(0);
    expect(out).toEqual(['false']);
    expect((await audit('settings.set'))[0]?.data).toMatchObject({ previous: true, value: false });
    expect(await run('settings:set', 'auth.signup_enabled', '"yes"')).toBe(1);
    expect(await run('settings:set', 'api_keys.default_rpm', '0')).toBe(1);
    expect(await run('settings:set', 'dev.skeleton', '{}')).toBe(1);
    expect(errs.join()).toMatch(/unknown setting/);
    expect(await run('settings:set', 'api_keys.default_rpm', 'not json')).toBe(1);
    expect(await run('settings:get')).toBe(0);
    expect(out.join('\n')).toMatch(/api_keys\.default_concurrency = 4/);
  });

  it('audit:tail lists recent entries oldest first; unknown commands fail with usage', async () => {
    expect(await run('audit:tail', '--limit', '3')).toBe(0);
    expect(out).toHaveLength(3);
    expect(out.at(-1)).toMatch(/settings\.set setting:auth\.signup_enabled/);
    expect(await run('nope')).toBe(1);
    expect(errs.join()).toMatch(/usage/);
    expect(await run('--bogus')).toBe(1);
  });

  it('runs as a real process through the package script (pnpm --filter @spareon/server cli)', () => {
    const cwd = fileURLToPath(new URL('../..', import.meta.url));
    const r = spawnSync('pnpm', ['-s', 'cli', 'settings:get', 'api_keys.default_rpm'], {
      cwd,
      env: {
        ...process.env,
        ...withGeneratedSecrets({ NODE_ENV: 'test' }, { databaseUrl: testDb.url }).env,
      },
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 60_000,
    });
    expect(r.stdout.trim().split(/\r?\n/).at(-1)).toBe('60');
    expect(r.status).toBe(0);
  });
});

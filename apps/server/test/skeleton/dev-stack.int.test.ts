import net, { type AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemClock } from '../../src/lib/clock.js';
import { startDevStack } from '../../src/skeleton/dev-stack.js';
import { openTestDb, type TestDb } from '../support/db.js';

describe('dev:server stack (demo settings never widen by accident)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await openTestDb();
  });
  afterAll(async () => {
    await db.cleanup();
  });

  it('stays on 127.0.0.1 without --lan even when HOST says otherwise, and never uses a blank key', async () => {
    const lines: string[] = [];
    const stack = await startDevStack({
      env: { DATABASE_URL: db.url, HOST: '0.0.0.0', DEV_API_KEY: '   ' },
      clock: systemClock,
      port: 0,
      log: (line) => lines.push(line),
    });
    try {
      expect(stack.env.HOST).toBe('127.0.0.1');
      expect((stack.server.app.server.address() as AddressInfo).address).toBe('127.0.0.1');
      expect(stack.lanWsUrls).toEqual([]);
      expect(lines.some((l) => l.includes('HOST is ignored'))).toBe(true);
      expect(stack.apiKey).toMatch(/^sp_test_[0-9A-Za-z]{8}_[0-9A-Za-z]{32}$/);
      expect(stack.generatedSecrets).toContain('DEV_AGENT_SECRET');
      expect(stack.generatedSecrets).toContain('SESSION_SECRET');
      // The server's own sessions run as the least-privilege role.
      const who = await stack.app.pool.query<{ u: string }>('SELECT current_user AS u');
      expect(who.rows[0]?.u).toBe('spareon_app');
    } finally {
      await stack.stop();
    }
  });

  it('fails fast and cleans up when the port is taken (no hang on the held instance lock)', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address() as AddressInfo;
    try {
      const started = performance.now();
      await expect(
        startDevStack({
          env: { DATABASE_URL: db.url },
          clock: systemClock,
          port,
          log: () => undefined,
        }),
      ).rejects.toThrow(/EADDRINUSE/);
      expect(performance.now() - started).toBeLessThan(20_000);
      // The lock was released: a stack on a free port starts on the same database.
      const stack = await startDevStack({
        env: { DATABASE_URL: db.url },
        clock: systemClock,
        port: 0,
        log: () => undefined,
      });
      await stack.stop();
    } finally {
      await new Promise<void>((resolve) =>
        blocker.close(() => {
          resolve();
        }),
      );
    }
  });
});

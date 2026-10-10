import type { AddressInfo } from 'node:net';

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
      expect(stack.apiKey.trim().length).toBeGreaterThanOrEqual(24);
      expect(stack.generatedSecrets).toBe(true);
      // The server's own sessions run as the least-privilege role.
      const who = await stack.app.pool.query<{ u: string }>('SELECT current_user AS u');
      expect(who.rows[0]?.u).toBe('spareon_app');
    } finally {
      await stack.stop();
    }
  });
});

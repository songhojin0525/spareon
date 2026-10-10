import { FakeClock } from '@spareon/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UNUSABLE_PASSWORD_HASH } from '../../src/auth/password.js';
import {
  createSession,
  lookupSession,
  purgeSessions,
  revokeSessionByToken,
  type SessionDeps,
} from '../../src/auth/sessions.js';
import { createUser, disableUser, setPasswordHash } from '../../src/auth/users.js';
import { createDb, type DbHandle, withTransaction } from '../../src/db/client.js';
import { createIds } from '../../src/lib/ids.js';
import { openTestDb, type TestDb } from '../support/db.js';

const DAY = 86_400_000;

describe('session lifetime (idle 7 days, absolute 30 days, T34)', () => {
  let testDb: TestDb;
  let app: DbHandle;
  const clock = new FakeClock();
  const deps: SessionDeps = {
    clock,
    ids: createIds(clock),
    config: { idleMs: 7 * DAY, absoluteMs: 30 * DAY, touchIntervalMs: 60_000 },
  };
  const newUser = (email: string) =>
    createUser(app.db, deps, {
      email,
      role: 'buyer',
      displayName: 'x',
      passwordHash: UNUSABLE_PASSWORD_HASH,
    });

  beforeAll(async () => {
    testDb = await openTestDb();
    app = createDb({ url: testDb.url, role: 'spareon_app', maxConnections: 4 });
  });
  afterAll(async () => {
    await app.close();
    await testDb.cleanup();
  });

  it('stores only a hash of the token', async () => {
    const userId = await newUser('hash@test.spareon');
    const { token } = await createSession(app.db, deps, { userId });
    const rows = await testDb.pool.query<{ h: Buffer }>(
      'SELECT token_hash AS h FROM sessions WHERE user_id = $1',
      [userId],
    );
    expect(rows.rows[0]?.h.length).toBe(32);
    expect(rows.rows[0]?.h.toString('base64url')).not.toBe(token);
    expect(rows.rows[0]?.h.toString('hex')).not.toContain(Buffer.from(token).toString('hex'));
  });

  it('ends after 7 idle days, and use keeps it alive', async () => {
    const userId = await newUser('idle@test.spareon');
    const { token } = await createSession(app.db, deps, { userId });
    clock.advance(6 * DAY);
    expect(await lookupSession(app.db, deps, token)).toBeDefined(); // touches last_seen_at
    clock.advance(6 * DAY);
    expect(await lookupSession(app.db, deps, token)).toBeDefined();
    clock.advance(7 * DAY + 1);
    expect(await lookupSession(app.db, deps, token)).toBeUndefined();
  });

  it('ends 30 days after login even when used every day', async () => {
    const userId = await newUser('abs@test.spareon');
    const { token } = await createSession(app.db, deps, { userId });
    for (let d = 0; d < 29; d++) {
      clock.advance(DAY);
      expect(await lookupSession(app.db, deps, token)).toBeDefined();
    }
    clock.advance(DAY + 1);
    expect(await lookupSession(app.db, deps, token)).toBeUndefined();
  });

  it('writes last_seen_at at most once a minute', async () => {
    const userId = await newUser('touch@test.spareon');
    const { token, session } = await createSession(app.db, deps, { userId });
    const seen = async () =>
      (
        await testDb.pool.query<{ t: Date }>(
          'SELECT last_seen_at AS t FROM sessions WHERE id = $1',
          [session.sessionId],
        )
      ).rows[0]?.t.getTime();
    const t0 = await seen();
    clock.advance(30_000);
    await lookupSession(app.db, deps, token);
    expect(await seen()).toBe(t0);
    clock.advance(31_000);
    await lookupSession(app.db, deps, token);
    expect(await seen()).toBe(clock.nowMs());
  });

  it('a password reset or disabling the account ends every session', async () => {
    const userId = await newUser('reset@test.spareon');
    const a = await createSession(app.db, deps, { userId });
    const b = await createSession(app.db, deps, { userId });
    await withTransaction(app.db, (tx) =>
      setPasswordHash(tx, deps, userId, UNUSABLE_PASSWORD_HASH),
    );
    expect(await lookupSession(app.db, deps, a.token)).toBeUndefined();
    expect(await lookupSession(app.db, deps, b.token)).toBeUndefined();
    const c = await createSession(app.db, deps, { userId });
    await withTransaction(app.db, (tx) => disableUser(tx, deps, userId));
    expect(await lookupSession(app.db, deps, c.token)).toBeUndefined();
  });

  it('ignores malformed tokens without a query and revokes by token', async () => {
    expect(await lookupSession(app.db, deps, 'short')).toBeUndefined();
    expect(await lookupSession(app.db, deps, undefined)).toBeUndefined();
    const userId = await newUser('revoke@test.spareon');
    const { token } = await createSession(app.db, deps, { userId });
    expect(await revokeSessionByToken(app.db, deps, token)).toBe(true);
    expect(await revokeSessionByToken(app.db, deps, token)).toBe(false);
    expect(await lookupSession(app.db, deps, token)).toBeUndefined();
  });

  it('purges sessions that can no longer be used', async () => {
    const userId = await newUser('purge@test.spareon');
    const live = await createSession(app.db, deps, { userId });
    clock.advance(31 * DAY);
    const fresh = await createSession(app.db, deps, { userId });
    const purged = await purgeSessions(app.db, deps);
    expect(purged).toBeGreaterThanOrEqual(1);
    const left = await testDb.pool.query<{ id: string }>(
      'SELECT id FROM sessions WHERE user_id = $1',
      [userId],
    );
    expect(left.rows.map((r) => r.id)).toEqual([fresh.session.sessionId]);
    expect(live.session.sessionId).not.toBe(fresh.session.sessionId);
  });
});

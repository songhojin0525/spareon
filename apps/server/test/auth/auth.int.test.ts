import { FakeClock } from '@spareon/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CURRENT_TERMS_VERSION } from '../../src/auth/users.js';
import { MemoryRateLimiter } from '../../src/lib/rate-limit.js';
import { type Harness, startHarness } from '../support/skeleton.js';
import {
  Browser,
  createTestUser,
  type ErrorBody,
  loggedIn,
  type TestUser,
} from '../support/web.js';

const errorOf = async (res: Response): Promise<ErrorBody['error']> =>
  ((await res.json()) as ErrorBody).error;

describe('people auth: login, sessions, CSRF (runs the real server)', () => {
  let h: Harness;
  const limiterClock = new FakeClock();
  let buyer: TestUser;
  let owner: TestUser;

  beforeAll(async () => {
    h = await startHarness({ limiter: new MemoryRateLimiter({ clock: limiterClock }) });
    buyer = await createTestUser(h, 'buyer');
    owner = await createTestUser(h, 'owner');
  });
  afterAll(async () => {
    await h.close();
  });

  it('logs in with the right password: httpOnly session cookie, readable CSRF cookie, session endpoint', async () => {
    const b = Browser.of(h);
    await b.primeCsrf();
    const res = await b.request('POST', '/api/auth/login', {
      body: { email: buyer.email.toUpperCase(), password: buyer.password },
    });
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith('spareon_session='));
    const csrf = cookies.find((c) => c.startsWith('spareon_csrf='));
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(session).toMatch(/Path=\//);
    expect(session).toMatch(/Max-Age=2592000/);
    expect(csrf).not.toMatch(/HttpOnly/);
    const body = (await res.json()) as { user: { id: string; role: string }; csrfToken: string };
    expect(body.user).toMatchObject({ id: buyer.id, role: 'buyer' });
    const me = await b.request('GET', '/api/auth/session');
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe(buyer.email);
  });

  it('refuses a wrong password exactly like an unknown email (same status, code, message)', async () => {
    const b = Browser.of(h);
    const wrong = await b.login(owner.email, 'not-the-password-123');
    const unknown = await b.login('nobody-here@test.spareon', 'not-the-password-123');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const [e1, e2] = [await errorOf(wrong), await errorOf(unknown)];
    expect(e1.code).toBe('invalid_credentials');
    expect([e1.code, e1.message]).toEqual([e2.code, e2.message]);
    expect(b.sessionToken).toBeUndefined();
    const audit = await h.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.login_failed' AND target_id = $1`,
      [owner.id],
    );
    expect(audit[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it('locks an account after 5 failures for 15 minutes, even for the right password, and the same for unknown emails', async () => {
    const victim = await createTestUser(h, 'buyer');
    const b = Browser.of(h);
    for (let i = 0; i < 5; i++)
      expect((await b.login(victim.email, `wrong-password-${String(i)}`)).status).toBe(401);
    const locked = await b.login(victim.email, victim.password);
    expect(locked.status).toBe(429);
    expect((await errorOf(locked)).code).toBe('too_many_attempts');
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);

    // The lock does not reveal existence: an unknown email locks the same way.
    for (let i = 0; i < 5; i++)
      await b.login('ghost-lock@test.spareon', `wrong-password-${String(i)}`);
    const ghost = await b.login('ghost-lock@test.spareon', 'whatever-password');
    expect(ghost.status).toBe(429);
    expect(await errorOf(ghost)).toMatchObject({ code: 'too_many_attempts' });

    limiterClock.advance(15 * 60_000 + 1);
    expect((await b.login(victim.email, victim.password)).status).toBe(200);
  });

  it('a successful login clears the failure count', async () => {
    const u = await createTestUser(h, 'buyer');
    const b = Browser.of(h);
    for (let i = 0; i < 4; i++) await b.login(u.email, 'wrong-password-xx');
    expect((await b.login(u.email, u.password)).status).toBe(200);
    for (let i = 0; i < 4; i++) await b.login(u.email, 'wrong-password-xx');
    expect((await b.login(u.email, u.password)).status).toBe(200);
  });

  it('prevents session fixation: login issues a new token and ends the one the browser brought', async () => {
    const b = await loggedIn(h, buyer);
    const before = b.sessionToken;
    expect(before).toBeDefined();
    // Log in again in the same browser (e.g. after an attacker planted a session cookie).
    expect((await b.login(buyer.email, buyer.password)).status).toBe(200);
    expect(b.sessionToken).not.toBe(before);
    const stale = new Browser(h.baseUrl, h.env.WEB_ORIGIN);
    stale.cookies.set('spareon_session', before ?? '');
    expect((await stale.request('GET', '/api/auth/session')).status).toBe(401);
    // A cookie value the server never issued is not adopted either.
    const planted = Browser.of(h);
    planted.cookies.set('spareon_session', 'A'.repeat(43));
    expect((await planted.request('GET', '/api/auth/session')).status).toBe(401);
    expect((await planted.login(owner.email, owner.password)).status).toBe(200);
    expect(planted.sessionToken).not.toBe('A'.repeat(43));
  });

  it('logout revokes the session: the old cookie no longer works', async () => {
    const b = await loggedIn(h, owner);
    const token = b.sessionToken ?? '';
    const out = await b.request('POST', '/api/auth/logout');
    expect(out.status).toBe(200);
    expect(b.sessionToken).toBeUndefined();
    const replay = new Browser(h.baseUrl, h.env.WEB_ORIGIN);
    replay.cookies.set('spareon_session', token);
    expect((await replay.request('GET', '/api/auth/session')).status).toBe(401);
    const rows = await h.query<{ revoked: boolean }>(
      `SELECT revoked_at IS NOT NULL AS revoked FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [owner.id],
    );
    expect(rows[0]?.revoked).toBe(true);
    const audit = await h.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.logout' AND actor_user_id = $1`,
      [owner.id],
    );
    expect(audit[0]?.n).toBe(1);
  });

  describe('CSRF', () => {
    const create = (b: Browser, opts: Parameters<Browser['request']>[2] = {}) =>
      b.request('POST', '/api/api-keys', { body: { name: 'csrf test' }, ...opts });

    it('accepts a same-origin request with the session-bound token', async () => {
      const b = await loggedIn(h, buyer);
      expect((await create(b)).status).toBe(201);
    });

    it('refuses a missing Origin and Referer, or a foreign one', async () => {
      const b = await loggedIn(h, buyer);
      for (const origin of [null, 'https://evil.example', 'http://localhost:3001', 'null']) {
        const res = await create(b, { origin });
        expect(res.status).toBe(403);
        expect((await errorOf(res)).code).toBe('csrf_failed');
      }
    });

    it('falls back to the Referer origin when Origin is absent', async () => {
      const b = await loggedIn(h, buyer);
      const ok = await create(b, {
        origin: null,
        headers: { referer: `${h.env.WEB_ORIGIN}/app/keys` },
      });
      expect(ok.status).toBe(201);
      const bad = await create(b, { origin: null, headers: { referer: 'https://evil.example/x' } });
      expect(bad.status).toBe(403);
    });

    it('refuses a missing token or one that differs from the cookie', async () => {
      const b = await loggedIn(h, buyer);
      expect((await create(b, { csrf: false })).status).toBe(403);
      const res = await create(b, { csrf: false, headers: { 'x-csrf-token': 'x'.repeat(43) } });
      expect(res.status).toBe(403);
    });

    it('refuses a planted cookie+header pair that is not bound to the session', async () => {
      const b = await loggedIn(h, buyer);
      b.cookies.set('spareon_csrf', 'attacker-chosen-token');
      const res = await create(b);
      expect(res.status).toBe(403);
      expect((await errorOf(res)).code).toBe('csrf_failed');
    });

    it('also guards login (login CSRF) and logout', async () => {
      const b = Browser.of(h);
      await b.primeCsrf();
      const res = await b.request('POST', '/api/auth/login', {
        body: { email: buyer.email, password: buyer.password },
        origin: 'https://evil.example',
      });
      expect(res.status).toBe(403);
      const logged = await loggedIn(h, buyer);
      expect((await logged.request('POST', '/api/auth/logout', { csrf: false })).status).toBe(403);
      expect((await logged.request('GET', '/api/auth/session')).status).toBe(200);
    });
  });

  describe('signup', () => {
    const signup = async (body: Record<string, unknown>) => {
      const b = Browser.of(h);
      await b.primeCsrf();
      return b.request('POST', '/api/auth/signup', { body });
    };
    const valid = (email: string) => ({
      email,
      password: 'a long enough password',
      displayName: '홍길동',
      role: 'buyer',
      termsVersion: CURRENT_TERMS_VERSION,
    });

    it('creates the account without logging in; the account can then log in', async () => {
      const res = await signup(valid('New.Buyer@Test.Spareon'));
      expect(res.status).toBe(202);
      expect(res.headers.getSetCookie().some((c) => c.startsWith('spareon_session='))).toBe(false);
      const b = Browser.of(h);
      expect((await b.login('new.buyer@test.spareon', 'a long enough password')).status).toBe(200);
      const rows = await h.query<{ terms_version: string; role: string }>(
        `SELECT terms_version, role FROM users WHERE email = 'new.buyer@test.spareon'`,
      );
      expect(rows[0]).toEqual({ terms_version: CURRENT_TERMS_VERSION, role: 'buyer' });
    });

    it('answers an existing email exactly like a new one and keeps the old password', async () => {
      const first = await signup(valid(owner.email));
      const second = await signup(valid('fresh-person@test.spareon'));
      expect(first.status).toBe(second.status);
      expect(await first.json()).toEqual(await second.json());
      expect((await Browser.of(h).login(owner.email, owner.password)).status).toBe(200);
    });

    it('refuses operator sign-up, weak passwords and a stale terms version', async () => {
      expect((await signup({ ...valid('op@test.spareon'), role: 'operator' })).status).toBe(400);
      const weak = await signup({ ...valid('weak@test.spareon'), password: 'short' });
      expect((await errorOf(weak)).code).toBe('weak_password');
      const terms = await signup({ ...valid('terms@test.spareon'), termsVersion: 'old' });
      expect((await errorOf(terms)).code).toBe('terms_version_mismatch');
    });

    it('a logged-in user cannot sign up (permission table: anonymous only)', async () => {
      const b = await loggedIn(h, buyer);
      const res = await b.request('POST', '/api/auth/signup', {
        body: valid('again@test.spareon'),
      });
      expect(res.status).toBe(403);
    });
  });

  it('disabling a user ends their sessions', async () => {
    const u = await createTestUser(h, 'owner');
    const b = await loggedIn(h, u);
    await h.query(`UPDATE users SET disabled_at = now() WHERE id = $1`, [u.id]);
    expect((await b.request('GET', '/api/auth/session')).status).toBe(401);
    expect((await Browser.of(h).login(u.email, u.password)).status).toBe(401);
  });
});

describe('uniform failure timing', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ auth: { minFailureMs: 300 } });
  });
  afterAll(async () => {
    await h.close();
  });

  it('every failure (unknown, wrong password, disabled, seed account) takes at least the floor', async () => {
    const u = await createTestUser(h, 'buyer');
    const d = await createTestUser(h, 'owner');
    await h.query(`UPDATE users SET disabled_at = now() WHERE id = $1`, [d.id]);
    const seed = await h.query<{ email: string }>(
      `SELECT email FROM users WHERE role = 'operator' LIMIT 1`,
    );
    const b = Browser.of(h);
    await b.primeCsrf();
    const cases = [
      ['unknown', 'nobody-at-all@test.spareon', 'whatever-password-1'],
      ['wrong', u.email, 'whatever-password-1'],
      ['disabled', d.email, d.password],
      ['seed', seed[0]?.email ?? '', 'whatever-password-1'],
    ] as const;
    const times: Record<string, number> = {};
    for (const [name, email, password] of cases) {
      const start = performance.now();
      const res = await b.request('POST', '/api/auth/login', { body: { email, password } });
      times[name] = performance.now() - start;
      expect(res.status).toBe(401);
    }
    for (const t of Object.values(times)) expect(t).toBeGreaterThanOrEqual(295);
    // No failure stands out: all within the floor plus one argon2 run and scheduling noise.
    const spread = Math.max(...Object.values(times)) - Math.min(...Object.values(times));
    expect(spread).toBeLessThan(250);
  });
});

describe('https deployment cookies', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ env: { WEB_ORIGIN: 'https://app.example.com' } });
  });
  afterAll(async () => {
    await h.close();
  });

  it('uses __Host- cookies with Secure', async () => {
    const u = await createTestUser(h, 'buyer');
    const b = Browser.of(h);
    await b.primeCsrf();
    const res = await b.request('POST', '/api/auth/login', {
      body: { email: u.email, password: u.password },
    });
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    expect(cookies.find((c) => c.startsWith('__Host-spareon_session='))).toMatch(/; Secure/);
    expect(cookies.find((c) => c.startsWith('__Host-spareon_csrf='))).toMatch(/; Secure/);
  });
});

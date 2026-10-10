/**
 * The permission table in docs/PERMISSIONS.md drives these tests: every row × every role is executed
 * over HTTP against the real server. The document must equal the code table (http/permissions.ts), and
 * every registered route must be in the table or in its "표 밖 경로" list.
 */
import { readFileSync } from 'node:fs';

import { createSeededRandom } from '@spareon/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApiKey } from '../../src/api-keys/api-keys.js';
import { registeredRoutes } from '../../src/app.js';
import { CURRENT_TERMS_VERSION } from '../../src/auth/users.js';
import { withTransaction } from '../../src/db/client.js';
import {
  type Access,
  type Action,
  type AuthKind,
  type PermissionRow,
  PERMISSIONS,
  type Role,
  ROLES,
  ROUTES_OUTSIDE_TABLE,
} from '../../src/http/permissions.js';
import { systemClock } from '../../src/lib/clock.js';
import { ensureDevModel } from '../../src/skeleton/bootstrap.js';
import { createFactories } from '../../src/testing/factories.js';
import { chatBody, type Harness, startHarness } from '../support/skeleton.js';
import { Browser, createTestUser, loggedIn, type TestUser } from '../support/web.js';

const DOC = readFileSync(new URL('../../../../docs/PERMISSIONS.md', import.meta.url), 'utf8');

const ACCESS_WORDS: Readonly<Record<string, Access>> = {
  허용: 'allow',
  '자기 것': 'own',
  거부: 'deny',
};
const AUTH_WORDS: Readonly<Record<string, AuthKind>> = {
  세션: 'session',
  'API 키': 'api_key',
  공개: 'public',
};

function section(title: string): string {
  const start = DOC.indexOf(`\n## ${title}\n`);
  if (start < 0) throw new Error(`docs/PERMISSIONS.md has no section "${title}"`);
  const end = DOC.indexOf('\n## ', start + 1);
  return DOC.slice(start, end < 0 ? undefined : end);
}

function tableRows(text: string): string[][] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l))
    .map((l) =>
      l
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim()),
    )
    .slice(1); // header
}

/** The permission table as written in the document. */
function documentedTable(): Record<string, PermissionRow> {
  const out: Record<string, PermissionRow> = {};
  for (const cells of tableRows(section('표'))) {
    const [action, method, path, auth, ...rest] = cells;
    const access = rest.slice(0, 4).map((w) => {
      const a = ACCESS_WORDS[w];
      if (a === undefined) throw new Error(`unknown access word "${w}" in row ${String(action)}`);
      return a;
    });
    const authKind = AUTH_WORDS[auth ?? ''];
    if (action === undefined || authKind === undefined || access.length !== 4) {
      throw new Error(`malformed row: ${cells.join(' | ')}`);
    }
    if (action in out) throw new Error(`duplicate row ${action}`);
    out[action] = {
      method: method as PermissionRow['method'],
      path: path ?? '',
      auth: authKind,
      access: Object.fromEntries(ROLES.map((r, i) => [r, access[i]])) as Record<Role, Access>,
    };
  }
  return out;
}

describe('docs/PERMISSIONS.md', () => {
  it('equals the code table (http/permissions.ts)', () => {
    expect(documentedTable()).toEqual(JSON.parse(JSON.stringify(PERMISSIONS)));
  });

  it('lists the same routes outside the table as the code', () => {
    const paths = tableRows(section('표 밖 경로')).map((c) => c[0]);
    expect(paths.sort()).toEqual(Object.keys(ROUTES_OUTSIDE_TABLE).sort());
  });
});

describe('permission table over HTTP (every row × every role)', () => {
  let h: Harness;
  const users = {} as Record<'operator' | 'ownerA' | 'ownerB' | 'buyerA' | 'buyerB', TestUser>;
  let storeA: string;
  let storeB: string;
  let jobA: string;
  let jobB: string;
  let keyA: string;
  let keyIdA: string;
  let keyIdB: string;

  const newKey = (userId: string, name = 'probe') =>
    withTransaction(h.app.db, (tx) =>
      createApiKey(tx, h.server.http.apiKeys, { userId, name, scopes: ['chat', 'models:read'] }),
    );

  beforeAll(async () => {
    h = await startHarness({
      auth: {
        // Every probe logs in afresh from 127.0.0.1.
        loginIpRule: { limit: 100_000, windowMs: 60_000 },
        loginAccountRule: { limit: 100_000, windowMs: 60_000 },
        signupIpRule: { limit: 100_000, windowMs: 60_000 },
      },
      dashboard: true,
    });
    users.operator = await createTestUser(h, 'operator');
    users.ownerA = await createTestUser(h, 'owner');
    users.ownerB = await createTestUser(h, 'owner');
    users.buyerA = await createTestUser(h, 'buyer');
    users.buyerB = await createTestUser(h, 'buyer');
    const f = createFactories({
      db: h.app.db,
      clock: systemClock,
      random: createSeededRandom('perm'),
    });
    storeA = (await f.store({ ownerId: users.ownerA.id })).id;
    storeB = (await f.store({ ownerId: users.ownerB.id })).id;
    const job = async (buyerId: string) =>
      (
        await f.job({
          buyerId,
          status: 'failed',
          failureCode: 'probe',
          priceVersionId: h.world.priceVersionId,
        })
      ).id;
    jobA = await job(users.buyerA.id);
    jobB = await job(users.buyerB.id);
    const a = await newKey(users.buyerA.id);
    keyA = a.key;
    keyIdA = a.id;
    keyIdB = (await newKey(users.buyerB.id)).id;
    await ensureDevModel(h.app.db, h.server.http, 'fake-echo');
  });
  afterAll(async () => {
    await h.close();
  });

  /** The acting user of each role ('A' side); anonymous has none. */
  const actor = (role: Role): TestUser | undefined =>
    role === 'operator'
      ? users.operator
      : role === 'owner'
        ? users.ownerA
        : role === 'buyer'
          ? users.buyerA
          : undefined;

  /** A fresh browser for the role: logged in, or anonymous with a CSRF token. */
  async function browser(role: Role): Promise<Browser> {
    const u = actor(role);
    if (u !== undefined) return loggedIn(h, u);
    const b = Browser.of(h);
    await b.primeCsrf();
    return b;
  }

  type Target = 'own' | 'other';
  /** How to perform each action as `role`, aimed at the role's own resource or someone else's. */
  const probes: Record<Action, (role: Role, target: Target) => Promise<Response>> = {
    'health.live': async (role) => (await browser(role)).request('GET', '/healthz'),
    'health.ready': async (role) => (await browser(role)).request('GET', '/readyz'),
    'docs.openapi': async (role) => (await browser(role)).request('GET', '/api/openapi.json'),
    'auth.csrf': async (role) => (await browser(role)).request('GET', '/api/auth/csrf'),
    'auth.signup': async (role) =>
      (await browser(role)).request('POST', '/api/auth/signup', {
        body: {
          email: `signup-${role}-${String(Math.random()).slice(2)}@test.spareon`,
          password: 'a long enough password',
          displayName: 'probe',
          role: 'buyer',
          termsVersion: CURRENT_TERMS_VERSION,
        },
      }),
    'auth.login': async (role) => {
      const u = actor(role) ?? users.buyerB;
      return (await browser(role)).request('POST', '/api/auth/login', {
        body: { email: u.email, password: u.password },
      });
    },
    'auth.logout': async (role) => (await browser(role)).request('POST', '/api/auth/logout'),
    'auth.session': async (role) => (await browser(role)).request('GET', '/api/auth/session'),
    'api_keys.list': async (role) => (await browser(role)).request('GET', '/api/api-keys'),
    'api_keys.create': async (role) =>
      (await browser(role)).request('POST', '/api/api-keys', { body: { name: 'probe' } }),
    'api_keys.revoke': async (role, target) => {
      const owner = target === 'own' && role === 'buyer' ? users.buyerA : users.buyerB;
      const k = await newKey(owner.id);
      return (await browser(role)).request('DELETE', `/api/api-keys/${k.id}`);
    },
    'stores.list': async (role) => (await browser(role)).request('GET', '/api/stores'),
    'stores.get': async (role, target) =>
      (await browser(role)).request(
        'GET',
        `/api/stores/${target === 'own' && role === 'owner' ? storeA : storeB}`,
      ),
    'jobs.get': async (role, target) =>
      (await browser(role)).request(
        'GET',
        `/api/jobs/${target === 'own' && role === 'buyer' ? jobA : jobB}`,
      ),
    'ops.settings.list': async (role) => (await browser(role)).request('GET', '/api/ops/settings'),
    'ops.settings.set': async (role) =>
      (await browser(role)).request('PUT', '/api/ops/settings/auth.signup_enabled', {
        body: { value: true },
      }),
    'ops.audit.list': async (role) =>
      (await browser(role)).request('GET', '/api/ops/audit?limit=5'),
    'ops.users.disable': async (role) => {
      const victim = await createTestUser(h, 'buyer');
      return (await browser(role)).request('POST', `/api/ops/users/${victim.id}/disable`);
    },
    'buyer.chat_completions': async (role) => {
      // A buyer calls with an API key; other roles have none and try their session cookie.
      if (role === 'buyer') return h.chat(chatBody('probe'), { apiKey: keyA });
      return (await browser(role)).request('POST', '/v1/chat/completions', {
        body: chatBody('probe'),
      });
    },
  };

  /** Lists whose `own` scope must contain the caller's item and not the other's. */
  const ownLists: Partial<Record<Action, () => [own: string, other: string]>> = {
    'api_keys.list': () => [keyIdA, keyIdB],
    'stores.list': () => [storeA, storeB],
  };

  /** Allowed outcomes besides 2xx (the action ran but its business result was not success). */
  const allowedStatus = (action: Action, status: number): boolean =>
    action === 'buyer.chat_completions'
      ? [402, 503].includes(status) // buyer A has no credit; no agent is connected
      : status >= 200 && status < 300;

  const table = documentedTable();
  const cases = Object.entries(table).flatMap(([action, row]) =>
    ROLES.map((role) => [action as Action, role, row.access[role], row.auth] as const),
  );

  it('has a probe for every row', () => {
    expect(Object.keys(probes).sort()).toEqual(Object.keys(table).sort());
  });

  it.each(cases)('%s as %s: %s', async (action, role, access, auth) => {
    if (access === 'deny') {
      const res = await probes[action](role, 'other');
      const expected = role === 'anonymous' || auth === 'api_key' ? 401 : 403;
      expect(res.status, `${action} as ${role}`).toBe(expected);
      return;
    }
    if (access === 'allow') {
      const res = await probes[action](role, 'other');
      expect(allowedStatus(action, res.status), `${action} as ${role}: ${String(res.status)}`).toBe(
        true,
      );
      return;
    }
    // own
    const list = ownLists[action];
    if (list !== undefined) {
      const res = await probes[action](role, 'own');
      expect(res.status).toBe(200);
      const ids = ((await res.json()) as { data: { id: string }[] }).data.map((d) => d.id);
      const [own, other] = list();
      expect(ids).toContain(own);
      expect(ids).not.toContain(other);
      return;
    }
    const mine = await probes[action](role, 'own');
    expect(mine.status, `${action} as ${role} on own`).toBeGreaterThanOrEqual(200);
    expect(mine.status).toBeLessThan(300);
    const theirs = await probes[action](role, 'other');
    expect(theirs.status, `${action} as ${role} on someone else's`).toBe(404);
  });

  it("a buyer cannot revoke someone else's key (it stays active)", async () => {
    const b = await loggedIn(h, users.buyerA);
    expect((await b.request('DELETE', `/api/api-keys/${keyIdB}`)).status).toBe(404);
    const rows = await h.query<{ revoked: boolean }>(
      'SELECT revoked_at IS NOT NULL AS revoked FROM api_keys WHERE id = $1',
      [keyIdB],
    );
    expect(rows[0]?.revoked).toBe(false);
  });

  it('every registered route is in the table or listed outside it, and every row is registered', () => {
    const outside = new Set(Object.keys(ROUTES_OUTSIDE_TABLE));
    const registered = registeredRoutes(h.server.app)
      .filter((r) => !outside.has(r.url))
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    const rows = Object.values(PERMISSIONS)
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(registered).toEqual(rows);
    const outsideRegistered = registeredRoutes(h.server.app).filter((r) => outside.has(r.url));
    expect(outsideRegistered.map((r) => r.url).sort()).toEqual([...outside].sort());
  });
});

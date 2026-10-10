import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_KEY_RE } from '../../src/api-keys/api-keys.js';
import { ensureDevModel } from '../../src/skeleton/bootstrap.js';
import { chatBody, type Harness, startHarness, waitFor } from '../support/skeleton.js';
import { createTestUser, type ErrorBody, loggedIn, type TestUser } from '../support/web.js';

interface KeyOut {
  id: string;
  prefix: string;
  key?: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const codeOf = async (res: Response): Promise<string> =>
  ((await res.json()) as ErrorBody).error.code;

describe('buyer API keys', () => {
  let h: Harness;
  let buyer: TestUser;

  beforeAll(async () => {
    h = await startHarness({ topupCr: 10n });
    buyer = await createTestUser(h, 'buyer');
    // The model exists (as if an agent had offered it) but no agent is connected: accepted requests
    // wait in the queue and end with 503 no_capacity. Test buyers have no credit (402).
    await ensureDevModel(h.app.db, h.server.http, 'fake-echo');
  });
  afterAll(async () => {
    await h.close();
  });

  const jobCount = async (): Promise<number> =>
    (await h.query<{ n: number }>('SELECT count(*)::int AS n FROM jobs'))[0]?.n ?? 0;

  it('shows the key once; lists only the prefix; stores only an HMAC', async () => {
    const b = await loggedIn(h, buyer);
    const res = await b.request('POST', '/api/api-keys', { body: { name: 'laptop' } });
    expect(res.status).toBe(201);
    const created = (await res.json()) as KeyOut;
    expect(created.key).toMatch(API_KEY_RE);
    expect(created.key?.startsWith(`${created.prefix}_`)).toBe(true);
    expect(created.scopes).toEqual(['chat', 'batch', 'models:read']);

    const list = (await (await b.request('GET', '/api/api-keys')).json()) as { data: KeyOut[] };
    expect(list.data.map((k) => k.id)).toContain(created.id);
    expect(JSON.stringify(list)).not.toContain(created.key);

    const rows = await h.query<{ prefix: string; key_hash: Buffer; hash_key_id: string }>(
      'SELECT prefix, key_hash, hash_key_id FROM api_keys WHERE id = $1',
      [created.id],
    );
    expect(rows[0]?.prefix).toBe(created.prefix);
    expect(rows[0]?.hash_key_id).toBe(h.env.API_KEY_PEPPER_ID);
    const dump = JSON.stringify(await h.query('SELECT * FROM api_keys'));
    const secret = created.key?.split('_')[3] ?? 'missing';
    expect(dump).not.toContain(secret);
    const audit = await h.query<{ data: { prefix: string } }>(
      `SELECT data FROM audit_log WHERE action = 'api_key.create' AND target_id = $1`,
      [created.id],
    );
    expect(audit[0]?.data.prefix).toBe(created.prefix);
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it('a key authenticates /v1, records itself on the job and updates last_used_at', async () => {
    const res = await h.chat(chatBody('hello'), { apiKey: h.apiKey });
    // No agent is connected: the job is queued and ends with no capacity (503), but it was accepted.
    expect([200, 503]).toContain(res.status);
    const jobs = await h.query<{ api_key_id: string | null; prefix: string }>(
      `SELECT j.api_key_id, k.prefix FROM jobs j JOIN api_keys k ON k.id = j.api_key_id ORDER BY j.created_at DESC LIMIT 1`,
    );
    expect(h.apiKey.startsWith(`${jobs[0]?.prefix ?? 'none'}_`)).toBe(true);
    const used = await h.query<{ last_used_at: Date | null }>(
      'SELECT last_used_at FROM api_keys WHERE prefix = $1',
      [jobs[0]?.prefix],
    );
    expect(used[0]?.last_used_at).not.toBeNull();
  });

  it.each([
    ['no header', null],
    ['not a key', 'hello'],
    ['right shape, unknown', `sp_test_AAAAAAAA_${'A'.repeat(32)}`],
    ['live key on a test server', `sp_live_AAAAAAAA_${'A'.repeat(32)}`],
  ])('refuses %s with 401 invalid_api_key', async (_name, key) => {
    const res = await h.chat(chatBody('x'), { apiKey: key });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody & { error: { type: string } };
    expect(body.error).toMatchObject({ code: 'invalid_api_key', type: 'authentication_error' });
  });

  it('a session cookie does not authenticate the buyer API', async () => {
    const b = await loggedIn(h, buyer);
    const res = await b.request('POST', '/v1/chat/completions', { body: chatBody('x') });
    expect(res.status).toBe(401);
  });

  it('revoked keys and keys of disabled buyers stop working', async () => {
    const b = await loggedIn(h, buyer);
    const k1 = (await (
      await b.request('POST', '/api/api-keys', {
        body: { name: 'to revoke', scopes: ['models:read'] },
      })
    ).json()) as KeyOut;
    const revoke = await b.request('DELETE', `/api/api-keys/${k1.id}`);
    expect(revoke.status).toBe(200);
    expect(await codeOf(await h.chat(chatBody('x'), { apiKey: k1.key ?? '' }))).toBe(
      'invalid_api_key',
    );
    expect((await b.request('DELETE', `/api/api-keys/${k1.id}`)).status).toBe(404);

    const other = await createTestUser(h, 'buyer');
    const ob = await loggedIn(h, other);
    const k2 = (await (
      await ob.request('POST', '/api/api-keys', { body: { name: 'x' } })
    ).json()) as KeyOut;
    await h.query('UPDATE users SET disabled_at = now() WHERE id = $1', [other.id]);
    expect((await h.chat(chatBody('x'), { apiKey: k2.key ?? '' })).status).toBe(401);
  });

  it('a key without the chat scope gets 403 insufficient_scope', async () => {
    const b = await loggedIn(h, buyer);
    const k = (await (
      await b.request('POST', '/api/api-keys', {
        body: { name: 'models only', scopes: ['models:read'] },
      })
    ).json()) as KeyOut;
    const res = await h.chat(chatBody('x'), { apiKey: k.key ?? '' });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('insufficient_scope');
  });

  it('enforces the per-key requests-per-minute limit with Retry-After', async () => {
    const b = await loggedIn(h, buyer);
    const k = (await (
      await b.request('POST', '/api/api-keys', { body: { name: 'slow', rateLimitRpm: 2 } })
    ).json()) as KeyOut;
    // This buyer has no credit: requests end in 402 after authentication, which still counts.
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++)
      statuses.push((await h.chat(chatBody('x'), { apiKey: k.key ?? '' })).status);
    expect(statuses.slice(0, 2)).toEqual([402, 402]);
    const limited = await h.chat(chatBody('x'), { apiKey: k.key ?? '' });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await codeOf(limited)).toBe('rate_limited');
    // Another key of the same buyer has its own budget.
    const k2 = (await (
      await b.request('POST', '/api/api-keys', { body: { name: 'fast' } })
    ).json()) as KeyOut;
    expect((await h.chat(chatBody('x'), { apiKey: k2.key ?? '' })).status).toBe(402);
  });

  it('enforces the per-key concurrency limit (setting api_keys.default_concurrency)', async () => {
    // The development buyer's database raised the setting to 64 (dev-buyer.ts); lower it for this test.
    await h.query(
      `UPDATE settings SET value = '1'::jsonb WHERE key = 'api_keys.default_concurrency'`,
    );
    h.server.http.settings.invalidate();
    try {
      // No agent: the first request waits in the queue (up to queueWaitMs) and holds the only slot.
      const before = await jobCount();
      const first = h.chat(chatBody('slow'), { apiKey: h.apiKey });
      // The first request holds its slot once its job exists (it then waits in the queue).
      await waitFor(async () => (await jobCount()) > before, 10_000, 'the first job');
      const second = await h.chat(chatBody('second'), { apiKey: h.apiKey });
      expect(second.status).toBe(429);
      expect(await codeOf(second)).toBe('concurrency_limited');
      expect((await first).status).toBe(503);
      // The slot is free again once the first request ended.
      expect((await h.chat(chatBody('third'), { apiKey: h.apiKey })).status).toBe(503);
    } finally {
      await h.query(
        `UPDATE settings SET value = '64'::jsonb WHERE key = 'api_keys.default_concurrency'`,
      );
      h.server.http.settings.invalidate();
    }
  });

  it('caps active keys per buyer', async () => {
    const u = await createTestUser(h, 'buyer');
    const b = await loggedIn(h, u);
    for (let i = 0; i < 20; i++) {
      expect(
        (await b.request('POST', '/api/api-keys', { body: { name: `k${String(i)}` } })).status,
      ).toBe(201);
    }
    const res = await b.request('POST', '/api/api-keys', { body: { name: 'one too many' } });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('too_many_keys');
  });

  it('a buyer cannot raise a key above the default rate; operators can (CLI)', async () => {
    const b = await loggedIn(h, buyer);
    const res = await b.request('POST', '/api/api-keys', {
      body: { name: 'greedy', rateLimitRpm: 10_000 },
    });
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe('rpm_above_default');
  });

  it("per-buyer limits apply across all of the buyer's keys", async () => {
    const u = await createTestUser(h, 'buyer');
    const b = await loggedIn(h, u);
    const keys: string[] = [];
    for (let i = 0; i < 3; i++) {
      keys.push(
        (
          (await (
            await b.request('POST', '/api/api-keys', { body: { name: `k${String(i)}` } })
          ).json()) as KeyOut
        ).key ?? '',
      );
    }
    await h.query(`INSERT INTO settings (key, value, updated_at) VALUES ('buyers.rpm', '4'::jsonb, now())
                   ON CONFLICT (key) DO UPDATE SET value = '4'::jsonb`);
    h.server.http.settings.invalidate();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++)
        statuses.push((await h.chat(chatBody('x'), { apiKey: keys[i % 3] ?? '' })).status);
      // No credit: accepted requests end 402; the fifth and sixth hit the buyer's 4 per minute.
      expect(statuses).toEqual([402, 402, 402, 402, 429, 429]);
    } finally {
      await h.query(`UPDATE settings SET value = '10000'::jsonb WHERE key = 'buyers.rpm'`);
      h.server.http.settings.invalidate();
    }
  });
});

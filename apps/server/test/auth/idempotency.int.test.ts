import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { chatBody, expectSettled, type Harness, startHarness } from '../support/skeleton.js';
import type { ErrorBody } from '../support/web.js';

interface Completion {
  id: string;
  created: number;
  choices: { message: { content: string } }[];
  usage: { total_tokens: number };
}

let n = 0;
const freshKey = (): string => `idem-${String(++n)}-${String(Date.now())}`;

describe('Idempotency-Key on POST /v1/chat/completions (BUY-02)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ topupCr: 10n });
  });
  afterAll(async () => {
    await h.close();
  });

  const call = (body: unknown, key: string | undefined, apiKey?: string) =>
    fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey ?? h.apiKey}`,
        ...(key === undefined ? {} : { 'idempotency-key': key }),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  const captures = async (): Promise<number> =>
    (
      await h.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ledger_transactions WHERE kind = 'JOB_CAPTURE'`,
      )
    )[0]?.n ?? 0;

  it('same key + same body → the same response, one job, one charge', async () => {
    await h.agent('idem-a');
    const key = freshKey();
    const before = await captures();
    const first = await call(chatBody('hello idempotency'), key);
    expect(first.status).toBe(200);
    const a = (await first.json()) as Completion;
    // Key order and formatting of the body do not matter.
    const reordered = `{ "max_tokens": 16, "messages": [{"content": "hello idempotency", "role": "user"}], "model": "fake-echo" }`;
    const second = await call(reordered, key);
    expect(second.status).toBe(200);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect((await second.json()) as Completion).toEqual(a);
    expect(await captures()).toBe(before + 1);
    const jobId = a.id.replace(/^chatcmpl-/, '');
    const rows = await h.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM job_payloads WHERE job_id = $1 AND kind = 'output'`,
      [jobId],
    );
    expect(rows[0]?.n).toBe(1);
    // The idempotency record holds metadata only, never the output text.
    const rec = await h.query<{ response: unknown }>(
      'SELECT response FROM idempotency_keys WHERE key = $1',
      [key],
    );
    expect(JSON.stringify(rec[0]?.response)).not.toContain(a.choices[0]?.message.content ?? 'x');
    await expectSettled(h);
  });

  it('same key + different body → 409 idempotency_key_reused, nothing charged', async () => {
    const key = freshKey();
    expect((await call(chatBody('one'), key)).status).toBe(200);
    const before = await captures();
    const res = await call(chatBody('two'), key);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe('idempotency_key_reused');
    expect(await captures()).toBe(before);
  });

  it('same key while the first request runs → 409 idempotency_in_progress', async () => {
    const slow = await h.agent('idem-slow', { behavior: { delayMs: 1_000, progressEveryMs: 200 } });
    const key = freshKey();
    const first = call(chatBody('slow one'), key);
    await new Promise((r) => setTimeout(r, 300));
    const second = await call(chatBody('slow one'), key);
    expect(second.status).toBe(409);
    expect(((await second.json()) as ErrorBody).error.code).toBe('idempotency_in_progress');
    expect((await first).status).toBe(200);
    await slow.kill();
  });

  it('a failure that charged nothing frees the key for a retry', async () => {
    const key = freshKey();
    const res = await call(chatBody('no such model', { model: 'missing-model' }), key);
    expect(res.status).toBe(404);
    const retry = await call(chatBody('no such model', { model: 'missing-model' }), key);
    expect(retry.status).toBe(404); // ran again (not a 409 or a replay)
    const left = await h.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1',
      [key],
    );
    expect(left[0]?.n).toBe(0);
  });

  it('without a key the output is not stored', async () => {
    const res = await call(chatBody('no key here'), undefined);
    expect(res.status).toBe(200);
    const jobId = ((await res.json()) as Completion).id.replace(/^chatcmpl-/, '');
    const rows = await h.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM job_payloads WHERE job_id = $1 AND kind = 'output'`,
      [jobId],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('a replay after the output retention ended answers 410 and charges nothing', async () => {
    const key = freshKey();
    const first = await call(chatBody('expiring'), key);
    const jobId = ((await first.json()) as Completion).id.replace(/^chatcmpl-/, '');
    await h.query(`DELETE FROM job_payloads WHERE job_id = $1 AND kind = 'output'`, [jobId]);
    const before = await captures();
    const res = await call(chatBody('expiring'), key);
    expect(res.status).toBe(410);
    expect(((await res.json()) as ErrorBody).error.code).toBe('idempotent_result_expired');
    expect(await captures()).toBe(before);
  });

  it('rejects a malformed Idempotency-Key', async () => {
    const res = await call(chatBody('x'), 'has space');
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe('invalid_idempotency_key');
  });

  it('a stale in_progress claim (dead process) is taken over', async () => {
    const key = freshKey();
    const body = chatBody('stale claim');
    const buyer = h.world.buyerId;
    const { requestHash } = await import('../../src/lib/idempotency.js');
    await h.query(
      `INSERT INTO idempotency_keys (scope, key, request_hash, status, created_at, expires_at)
       VALUES ($1, $2, $3, 'in_progress', now() - interval '20 minutes', now() + interval '1 day')`,
      [`buyer:${buyer}:chat`, key, requestHash(body)],
    );
    expect((await call(body, key)).status).toBe(200);
  });
});

import { type FakeAgent, FakeClock } from '@spareon/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTransaction } from '../../src/db/client.js';
import { Idempotency, requestHash } from '../../src/lib/idempotency.js';
import {
  chatBody,
  expectSettled,
  type Harness,
  startHarness,
  waitFor,
} from '../support/skeleton.js';
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
  let fast: FakeAgent;

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
    fast = await h.agent('idem-a');
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
    // Only a slow node is connected, so the first request is surely still running at the second.
    await fast.kill();
    const slow = await h.agent('idem-slow', { behavior: { delayMs: 1_500, progressEveryMs: 200 } });
    const key = freshKey();
    const first = call(chatBody('slow one'), key);
    // The claim holds its job id once the job exists: the first request is surely running then.
    await waitFor(
      async () =>
        (
          await h.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1 AND response ? 'jobId'`,
            [key],
          )
        )[0]?.n === 1,
      10_000,
      'the first request to create its job',
    );
    const second = await call(chatBody('slow one'), key);
    expect(second.status).toBe(409);
    expect(((await second.json()) as ErrorBody).error.code).toBe('idempotency_in_progress');
    expect((await first).status).toBe(200);
    await slow.kill();
    fast = await h.agent('idem-b');
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
    await h.query(
      `INSERT INTO idempotency_keys (scope, key, request_hash, status, created_at, expires_at)
       VALUES ($1, $2, $3, 'in_progress', now() - interval '20 minutes', now() + interval '1 day')`,
      [`buyer:${buyer}:chat`, key, requestHash(h.server.idempotencyHashKey, body)],
    );
    expect((await call(body, key)).status).toBe(200);
  });

  /** Put a claim of `key` back to "unfinished" as a dead process would leave it. */
  const unfinish = async (key: string, jobId: string, ageMinutes: number) => {
    await h.query(
      `UPDATE idempotency_keys SET status = 'in_progress', response = $2::jsonb, response_status = NULL,
              completed_at = NULL, created_at = now() - make_interval(mins => $3)
        WHERE key = $1`,
      [key, JSON.stringify({ jobId }), ageMinutes],
    );
  };

  it('a claim whose job completed but was never recorded is answered as charged-and-lost, never re-run', async () => {
    const key = freshKey();
    const first = await call(chatBody('charged once'), key);
    const jobId = ((await first.json()) as Completion).id.replace(/^chatcmpl-/, '');
    // As if the process died between the capture and recording the result.
    await unfinish(key, jobId, 20);
    const before = await captures();
    const jobsBefore = (await h.query<{ n: number }>('SELECT count(*)::int AS n FROM jobs'))[0]?.n;
    const res = await call(chatBody('charged once'), key);
    expect(res.status).toBe(500);
    expect(((await res.json()) as ErrorBody).error.code).toBe('result_undelivered');
    expect(await captures()).toBe(before);
    expect((await h.query<{ n: number }>('SELECT count(*)::int AS n FROM jobs'))[0]?.n).toBe(
      jobsBefore,
    );
    // Recorded now: the same answer again.
    expect((await call(chatBody('charged once'), key)).status).toBe(500);
  });

  it('a recent unfinished claim whose job completed answers in_progress (its request may still record it)', async () => {
    const key = freshKey();
    const first = await call(chatBody('recent'), key);
    const jobId = ((await first.json()) as Completion).id.replace(/^chatcmpl-/, '');
    await unfinish(key, jobId, 0);
    expect((await call(chatBody('recent'), key)).status).toBe(409);
  });

  it('a claim whose job ended without a charge (e.g. no capacity, or canceled by a restart) runs again at once', async () => {
    const key = freshKey();
    await fast.kill(); // no node: the job expires with no_capacity and nothing is charged
    expect((await call(chatBody('expire me'), key)).status).toBe(503);
    const [job] = await h.query<{ id: string; status: string }>(
      'SELECT id, status FROM jobs ORDER BY created_at DESC LIMIT 1',
    );
    expect(job?.status).toBe('expired');
    // As if the process had died before releasing the claim.
    await h.query(
      `INSERT INTO idempotency_keys (scope, key, request_hash, status, response, created_at, expires_at)
       VALUES ($1, $2, $3, 'in_progress', $4::jsonb, now(), now() + interval '1 day')`,
      [
        `buyer:${h.world.buyerId}:chat`,
        key,
        requestHash(h.server.idempotencyHashKey, chatBody('expire me')),
        JSON.stringify({ jobId: job?.id }),
      ],
    );
    fast = await h.agent('idem-c');
    expect((await call(chatBody('expire me'), key)).status).toBe(200);
  });

  it('only the owner of a claim can complete or release it (a late request cannot free a taken-over key)', async () => {
    const clock = new FakeClock();
    const idem = new Idempotency(h.app.db, clock, { ttlMs: 86_400_000, staleAfterMs: 1_000 });
    const hash = requestHash(h.server.idempotencyHashKey, { x: 1 });
    const scope = `test:${freshKey()}`;
    const a = await idem.claim(scope, 'k', hash);
    expect(a.kind).toBe('claimed');
    clock.advance(2_000);
    const b = await idem.claim(scope, 'k', hash); // stale and nothing attached: taken over
    expect(b.kind).toBe('claimed');
    if (a.kind !== 'claimed' || b.kind !== 'claimed') throw new Error('unreachable');
    await idem.release(scope, 'k', a.token);
    await idem.complete(scope, 'k', a.token, 200, { from: 'a' });
    expect((await idem.claim(scope, 'k', hash)).kind).toBe('in_progress');
    // The late owner can no longer attach work to the key either.
    const attachedLate = await withTransaction(h.app.db, (tx) =>
      idem.attach(tx, scope, 'k', a.token, { jobId: '00000000-0000-7000-8000-000000000001' }),
    );
    expect(attachedLate).toBe(false);
    await idem.complete(scope, 'k', b.token, 200, { from: 'b' });
    expect(await idem.claim(scope, 'k', hash)).toEqual({
      kind: 'replay',
      status: 200,
      response: { from: 'b' },
    });
  });
});

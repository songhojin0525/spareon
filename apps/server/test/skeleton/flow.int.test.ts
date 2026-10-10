import { fakeOutput } from '@spareon/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { balanceOf, txCountForJob } from '../support/ledger.js';
import {
  chatBody,
  expectSettled,
  type Harness,
  startHarness,
  TEST_AGENT_SECRET,
  waitFor,
} from '../support/skeleton.js';

interface ChatOk {
  id: string;
  choices: { message: { content: string }; finish_reason: string }[];
  usage: { prompt_tokens: number; completion_tokens: number };
}
interface ChatErr {
  error: { code: string; type: string };
}

const jobIdOf = (res: ChatOk): string => res.id.replace(/^chatcmpl-/, '');

describe('walking skeleton: buyer → server → agent → ledger', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('answers a request through an agent and records the charge (70/30)', async () => {
    const a = await h.agent('happy-1');
    const res = await h.chat(chatBody('안녕하세요 반가워요'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatOk;
    const jobId = jobIdOf(body);
    const [job] = await h.query<{ params: { seed: number } }>(
      'SELECT params FROM jobs WHERE id = $1',
      [jobId],
    );
    expect(body.choices[0]?.message.content).toBe(
      fakeOutput(
        'happy-1',
        { messages: [{ role: 'user', content: '안녕하세요 반가워요' }] },
        job?.params.seed ?? -1,
        16,
      ),
    );
    expect(body.usage.prompt_tokens).toBe(2);
    expect(await txCountForJob(h.db, jobId, 'JOB_CAPTURE')).toBe(1);
    expect(await balanceOf(h.db, 'store_pending', h.world.storeId)).toBe(7_000n);
    expect(await balanceOf(h.db, 'platform_revenue', null)).toBe(3_000n);
    // The input is stored encrypted only: the plaintext is nowhere in the payload row.
    const [payload] = await h.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM job_payloads WHERE job_id = $1 AND kind = 'input'`,
      [jobId],
    );
    expect(payload?.ciphertext.includes(Buffer.from('반가워요'))).toBe(false);
    await a.kill();
    await expectSettled(h);
  });

  it('rejects bad requests before creating anything', async () => {
    expect((await h.chat(chatBody('x'), { apiKey: null })).status).toBe(401);
    expect((await h.chat(chatBody('x'), { apiKey: 'wrong-key-0123456789abcdefgh' })).status).toBe(
      401,
    );
    const stream = await h.chat(chatBody('x', { stream: true }));
    expect(stream.status).toBe(400);
    expect(((await stream.json()) as ChatErr).error.code).toBe('stream_unsupported');
    const unknown = await h.chat(chatBody('x', { model: 'no-such-model' }));
    expect(unknown.status).toBe(404);
    const invalid = await h.chat({ model: 'fake-echo', messages: [] });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(await invalid.json())).not.toContain('fake-echo');
    await expectSettled(h);
  });

  it('moves on to the next node when an offer is not accepted in time', async () => {
    const mute = await h.agent('mute-1', { behavior: { accept: 'never' } });
    const good = await h.agent('good-1');
    const res = await h.chat(chatBody('offer timeout'));
    expect(res.status).toBe(200);
    expect(mute.stats.offers).toBe(1);
    expect(good.stats.completed).toBe(1);
    const jobId = jobIdOf((await res.json()) as ChatOk);
    const attempts = await h.query<{ status: string; end_reason: string | null }>(
      'SELECT status, end_reason FROM job_attempts WHERE job_id = $1 ORDER BY seq',
      [jobId],
    );
    expect(attempts).toEqual([
      { status: 'timed_out', end_reason: 'offer_timeout' },
      { status: 'completed', end_reason: 'stop' },
    ]);
    await mute.kill();
    await good.kill();
    await expectSettled(h);
  });

  it('moves on when a node rejects', async () => {
    const no = await h.agent('reject-1', { behavior: { accept: 'reject' } });
    const yes = await h.agent('good-2');
    expect((await h.chat(chatBody('reject'))).status).toBe(200);
    expect(no.stats.offers).toBe(1);
    expect(yes.stats.completed).toBe(1);
    await no.kill();
    await yes.kill();
    await expectSettled(h);
  });

  it('retries elsewhere when a lease expires, and tells the silent node to stop', async () => {
    const silent = await h.agent('silent-1', { behavior: { run: 'silent', delayMs: 0 } });
    const good = await h.agent('good-3');
    const res = await h.chat(chatBody('lease'));
    expect(res.status).toBe(200);
    expect(silent.stats.accepted).toBe(1);
    await waitFor(
      () => silent.received.includes('job.cancel'),
      5_000,
      'job.cancel to the silent node',
    );
    const jobId = jobIdOf((await res.json()) as ChatOk);
    const attempts = await h.query<{ status: string; end_reason: string | null }>(
      'SELECT status, end_reason FROM job_attempts WHERE job_id = $1 ORDER BY seq',
      [jobId],
    );
    expect(attempts.map((a) => a.status)).toEqual(['lost', 'completed']);
    expect(attempts[0]?.end_reason).toBe('lease_expired');
    await silent.kill();
    await good.kill();
    await expectSettled(h);
  });

  it('keeps a slow node that reports progress (the lease is renewed)', async () => {
    const slow = await h.agent('slow-1', { behavior: { delayMs: 2_500, progressEveryMs: 300 } });
    const res = await h.chat(chatBody('slow but alive'));
    expect(res.status).toBe(200);
    expect(slow.stats.offers).toBe(1);
    await slow.kill();
    await expectSettled(h);
  });

  it('gives up after 3 started attempts and charges nothing', async () => {
    const before = await balanceOf(h.db, 'buyer_wallet', h.world.buyerId);
    const agents = await Promise.all(
      ['crash-1', 'crash-2', 'crash-3', 'crash-4'].map((n) =>
        h.agent(n, { behavior: { run: 'fail-retryable' } }),
      ),
    );
    const res = await h.chat(chatBody('always crashes'));
    expect(res.status).toBe(502);
    expect(((await res.json()) as ChatErr).error.code).toBe('node_failed');
    expect(agents.reduce((n, a) => n + a.stats.accepted, 0)).toBe(3);
    expect(await balanceOf(h.db, 'buyer_wallet', h.world.buyerId)).toBe(before);
    await Promise.all(agents.map((a) => a.kill()));
    await expectSettled(h);
  });

  it('does not retry a non-retryable failure', async () => {
    const bad = await h.agent('fatal-1', { behavior: { run: 'fail-fatal' } });
    const other = await h.agent('good-4');
    const res = await h.chat(chatBody('fatal'));
    expect(res.status).toBe(502);
    expect(other.stats.offers).toBe(0);
    await bad.kill();
    await other.kill();
    await expectSettled(h);
  });

  it('charges a duplicated completion once', async () => {
    const dup = await h.agent('dup-1', { behavior: { run: 'complete-twice' } });
    const res = await h.chat(chatBody('twice'));
    expect(res.status).toBe(200);
    const jobId = jobIdOf((await res.json()) as ChatOk);
    // The gateway handles one connection's messages in order: once two heartbeats sent after this point
    // are acknowledged, the second job.complete (sent right after the first) has been processed.
    const acks = (): number => dup.received.filter((t) => t === 'heartbeat.ack').length;
    const seen = acks();
    await waitFor(() => acks() >= seen + 2, 5_000, 'two heartbeat acks after the duplicate');
    expect(await txCountForJob(h.db, jobId, 'JOB_CAPTURE')).toBe(1);
    const earnings = await h.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM earnings WHERE job_id = $1',
      [jobId],
    );
    expect(earnings[0]?.n).toBe(1);
    await dup.kill();
    await expectSettled(h);
  });

  it('refuses an output whose hash does not match and retries on another node', async () => {
    const liar = await h.agent('liar-1', { behavior: { run: 'bad-hash' } });
    const good = await h.agent('good-5');
    const res = await h.chat(chatBody('hash'));
    expect(res.status).toBe(200);
    expect(liar.stats.completed).toBe(1);
    expect(good.stats.completed).toBe(1);
    await liar.kill();
    await good.kill();
    await expectSettled(h);
  });

  it('retries after a graceful shutdown (Ctrl+C → job.preempted)', async () => {
    const leaving = await h.agent('leaving-1', { behavior: { delayMs: 5_000 } });
    const pending = h.chat(chatBody('shutdown'));
    await waitFor(() => leaving.runningAttempts.length === 1, 5_000, 'job running on leaving-1');
    const good = await h.agent('good-6');
    await leaving.shutdown();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(good.stats.completed).toBe(1);
    const jobId = jobIdOf((await res.json()) as ChatOk);
    const attempts = await h.query<{ status: string; end_reason: string | null }>(
      'SELECT status, end_reason FROM job_attempts WHERE job_id = $1 ORDER BY seq',
      [jobId],
    );
    expect(attempts).toEqual([
      { status: 'preempted', end_reason: 'preempted.shutdown' },
      { status: 'completed', end_reason: 'stop' },
    ]);
    await good.kill();
    await expectSettled(h);
  });

  it('cancels and releases when the buyer goes away, and stops the node', async () => {
    const before = await balanceOf(h.db, 'buyer_wallet', h.world.buyerId);
    const busy = await h.agent('busy-1', { behavior: { delayMs: 5_000 } });
    const abort = new AbortController();
    const pending = h.chat(chatBody('bye'), { signal: abort.signal }).catch((e: unknown) => e);
    await waitFor(() => busy.runningAttempts.length === 1, 5_000, 'job running');
    abort.abort();
    await pending;
    await waitFor(() => busy.received.includes('job.cancel'), 5_000, 'job.cancel');
    const [job] = await h.query<{ status: string; failure_code: string }>(
      `SELECT status, failure_code FROM jobs ORDER BY created_at DESC LIMIT 1`,
    );
    expect(job).toEqual({ status: 'canceled', failure_code: 'client_disconnected' });
    expect(await balanceOf(h.db, 'buyer_wallet', h.world.buyerId)).toBe(before);
    await busy.kill();
    await expectSettled(h);
  });

  it('answers 503 and charges nothing when no node has the model', async () => {
    const before = await balanceOf(h.db, 'buyer_wallet', h.world.buyerId);
    const res = await h.chat(chatBody('nobody home'));
    expect(res.status).toBe(503);
    expect(((await res.json()) as ChatErr).error.code).toBe('no_capacity');
    expect(await balanceOf(h.db, 'buyer_wallet', h.world.buyerId)).toBe(before);
    await expectSettled(h);
  });

  it('does not offer work to an agent without --always-available (customer state unknown)', async () => {
    const unsure = await h.agent('unsure-1', { available: false });
    const res = await h.chat(chatBody('not eligible'));
    expect(res.status).toBe(503);
    expect(unsure.stats.offers).toBe(0);
    const [node] = await h.query<{ eligible: boolean; ineligible_reason: string }>(
      'SELECT eligible, ineligible_reason FROM nodes WHERE id = $1',
      [unsure.nodeId],
    );
    expect(node).toEqual({ eligible: false, ineligible_reason: 'helper_missing' });
    await unsure.kill();
    await expectSettled(h);
  });

  it('refuses an agent that does not know the secret', async () => {
    const { FakeAgent } = await import('@spareon/testkit');
    const protocol = await import('@spareon/protocol');
    await expect(
      FakeAgent.connect({
        url: h.wsUrl,
        secret: `${TEST_AGENT_SECRET}-wrong`,
        name: 'intruder',
        protocol,
      }),
    ).rejects.toThrow(/auth\.fail auth_invalid_signature/);
  });

  it('marks a node offline when its connection drops', async () => {
    const a = await h.agent('drop-1');
    await waitFor(async () => {
      const [n] = await h.query<{ state: string }>('SELECT state FROM nodes WHERE id = $1', [
        a.nodeId,
      ]);
      return n?.state === 'idle';
    });
    await a.kill();
    await waitFor(async () => {
      const [n] = await h.query<{ state: string }>('SELECT state FROM nodes WHERE id = $1', [
        a.nodeId,
      ]);
      return n?.state === 'offline';
    });
  });
});

describe('walking skeleton: credit check', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ topupCr: 0n });
  });
  afterAll(async () => {
    await h.close();
  });

  it('answers 402 without creating a job when the buyer has no credit', async () => {
    const a = await h.agent('rich-node');
    const res = await h.chat(chatBody('no money'));
    expect(res.status).toBe(402);
    expect(((await res.json()) as ChatErr).error.code).toBe('insufficient_credit');
    const jobs = await h.query<{ n: number }>('SELECT count(*)::int AS n FROM jobs');
    expect(jobs[0]?.n).toBe(0);
    expect(a.stats.offers).toBe(0);
  });
});

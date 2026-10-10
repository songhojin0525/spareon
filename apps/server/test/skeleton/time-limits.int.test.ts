import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { Server } from '../../src/app.js';
import { SessionRegistry } from '../../src/gateway/session.js';
import { systemClock } from '../../src/lib/clock.js';
import { createIds } from '../../src/lib/ids.js';
import { createPayloadCipher } from '../../src/lib/payload-cipher.js';
import {
  type ChatRequest,
  DEFAULT_SCHEDULER_CONFIG,
  Scheduler,
} from '../../src/scheduler/scheduler.js';
import { openCable } from '../support/cable.js';
import { balanceOf, txCountForJob } from '../support/ledger.js';
import {
  chatBody,
  expectSettled,
  type Harness,
  startHarness,
  waitFor,
} from '../support/skeleton.js';

interface ChatOk {
  id: string;
}
interface ChatErr {
  error: { code: string };
}
const jobIdOf = (res: ChatOk): string => res.id.replace(/^chatcmpl-/, '');
const chatRequest = (content: string): ChatRequest => ({
  model: 'fake-echo',
  messages: [{ role: 'user', content }],
  maxTokens: 16,
  temperatureMilli: 700,
  topPMilli: 1_000,
  stop: [],
});
const wsUrlOf = (server: Server): string =>
  `ws://127.0.0.1:${String((server.app.server.address() as AddressInfo).port)}/agent/v1/ws`;

/** Time rules (lease, deadline, retention, idle connections, restart) and the races between them. */
describe('walking skeleton: time limits and races', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('a completion that arrives after the lease expired is superseded: no reward, one capture', async () => {
    h = await startHarness();
    const t = h;
    // Generates for 2.5 s without progress (lease 1.5 s) and ignores the server's job.cancel.
    const late = await h.agent('late-1', {
      behavior: { delayMs: 2_500, progressEveryMs: 0, ignoreCancel: true },
    });
    const pending = h.chat(chatBody('late'));
    await waitFor(() => late.runningAttempts.length === 1, 5_000, 'job running on late-1');
    const good = await h.agent('good-late');
    const res = await pending;
    expect(res.status).toBe(200);
    const jobId = jobIdOf((await res.json()) as ChatOk);
    await waitFor(() => late.stats.completed === 1, 5_000, 'the late completion');
    const attempts = await h.query<{ node_id: string; status: string }>(
      'SELECT node_id, status FROM job_attempts WHERE job_id = $1 ORDER BY seq',
      [jobId],
    );
    await waitFor(
      async () =>
        (
          await t.query<{ status: string }>(
            'SELECT status FROM job_attempts WHERE job_id = $1 AND node_id = $2',
            [jobId, late.nodeId],
          )
        )[0]?.status === 'superseded',
      5_000,
      'late attempt superseded',
    );
    expect(attempts.map((a) => a.node_id)).toEqual([late.nodeId, good.nodeId]);
    expect(await txCountForJob(h.db, jobId, 'JOB_CAPTURE')).toBe(1);
    const earnings = await h.query<{ node_id: string }>(
      'SELECT node_id FROM earnings WHERE job_id = $1',
      [jobId],
    );
    expect(earnings).toEqual([{ node_id: good.nodeId }]);
    await expectSettled(h);
  });

  it('expires a job at its deadline: 504, released once, the node is told to stop', async () => {
    h = await startHarness({ scheduler: { jobDeadlineMs: 1_500 } });
    const before = await balanceOf(h.db, 'buyer_wallet', h.world.buyerId);
    const slow = await h.agent('slow-deadline', {
      behavior: { delayMs: 10_000, progressEveryMs: 200 },
    });
    const res = await h.chat(chatBody('too slow'));
    expect(res.status).toBe(504);
    expect(((await res.json()) as ChatErr).error.code).toBe('deadline_exceeded');
    await waitFor(() => slow.received.includes('job.cancel'), 5_000, 'job.cancel');
    const [job] = await h.query<{ id: string; status: string; failure_code: string }>(
      'SELECT id, status, failure_code FROM jobs ORDER BY created_at DESC LIMIT 1',
    );
    expect(job).toMatchObject({ status: 'expired', failure_code: 'deadline' });
    expect(await txCountForJob(h.db, job?.id ?? '', 'JOB_RELEASE')).toBe(1);
    expect(await balanceOf(h.db, 'buyer_wallet', h.world.buyerId)).toBe(before);
    await expectSettled(h);
  });

  it('deletes the encrypted input when its retention ends (T27)', async () => {
    h = await startHarness({ scheduler: { payloadRetentionMs: 800 } });
    const t = h;
    await h.agent('quick-1');
    expect((await h.chat(chatBody('short-lived'))).status).toBe(200);
    await waitFor(
      async () =>
        (await t.query<{ n: number }>('SELECT count(*)::int AS n FROM job_payloads'))[0]?.n === 0,
      5_000,
      'payload rows deleted',
    );
    await expectSettled(h);
  });

  it('ends a session whose cable was pulled at the idle limit, drops the TCP connection, retries elsewhere', async () => {
    h = await startHarness({ gateway: { idleTimeoutMs: 1_000 } });
    const t = h;
    // The agent talks through a relay that can drop every byte while both TCP connections stay up:
    // the server's close frame is then never answered (a hung process's WebSocket stack would answer).
    const cable = await openCable(new URL(h.wsUrl));
    try {
      const quiet = await h.agent('cut-1', {
        url: cable.url,
        heartbeatMs: 200,
        behavior: { delayMs: 30_000, progressEveryMs: 200 },
      });
      const pending = h.chat(chatBody('cut'));
      await waitFor(() => quiet.runningAttempts.length === 1, 5_000, 'job running on cut-1');
      const good = await h.agent('good-idle', { heartbeatMs: 200 });
      cable.cut();
      const cutAt = performance.now();
      await waitFor(
        () => t.server.sessions.get(quiet.nodeId) === undefined,
        5_000,
        'cut session removed',
      );
      const removedAt = performance.now();
      // Removed at the idle limit (1 s after the last heartbeat), not when the close handshake would
      // time out (ws: 30 s) — nothing will ever answer it.
      expect(removedAt - cutAt).toBeLessThan(2_000);
      // The server then drops the TCP connection itself, about 1 s (CLOSE_GRACE_MS) after closing.
      const droppedAt = await Promise.race([
        cable.upstreamClosed,
        new Promise<number>((_, reject) =>
          setTimeout(() => {
            reject(new Error('server kept the dead TCP connection'));
          }, 5_000),
        ),
      ]);
      expect(droppedAt - removedAt).toBeGreaterThan(500);
      expect(droppedAt - removedAt).toBeLessThan(3_000);
      const res = await pending;
      expect(res.status).toBe(200);
      expect(good.stats.completed).toBe(1);
      const jobId = jobIdOf((await res.json()) as ChatOk);
      const attempts = await h.query<{ status: string; end_reason: string }>(
        'SELECT status, end_reason FROM job_attempts WHERE job_id = $1 ORDER BY seq',
        [jobId],
      );
      expect(attempts[0]).toEqual({ status: 'lost', end_reason: 'connection_lost' });
      await expectSettled(h);
    } finally {
      // Lets the cut-off agent's own socket close (it would otherwise wait for a close answer).
      await cable.close();
    }
  });

  it('a restarted server releases the jobs the previous process left unfinished and never offers them', async () => {
    h = await startHarness();
    const t = h;
    const before = await balanceOf(h.db, 'buyer_wallet', h.world.buyerId);
    const stuck = await h.agent('stuck-1', { behavior: { run: 'silent', delayMs: 0 } });
    // The buyer waits inside the first process; that wait dies with the process.
    void h.server.scheduler.submit(h.world.buyerId, chatRequest('orphan'));
    await waitFor(() => stuck.stats.accepted === 1, 5_000, 'job accepted');
    await h.server.app.close();
    // A new process on the same database: buildServer -> listen runs the recovery before dispatching.
    const next = await h.anotherServer();
    try {
      await next.app.listen({ host: '127.0.0.1', port: 0 });
      const [job] = await h.query<{ id: string; status: string; failure_code: string }>(
        'SELECT id, status, failure_code FROM jobs ORDER BY created_at DESC LIMIT 1',
      );
      expect(job).toMatchObject({ status: 'canceled', failure_code: 'server_restart' });
      expect(await txCountForJob(h.db, job?.id ?? '', 'JOB_RELEASE')).toBe(1);
      expect(await balanceOf(h.db, 'buyer_wallet', h.world.buyerId)).toBe(before);
      // A node on the new process is never offered the orphan.
      const fresh = await h.agent('fresh-1', { url: wsUrlOf(next) });
      await new Promise((r) => setTimeout(r, 1_000));
      expect(fresh.stats.offers).toBe(0);
      expect(
        await t.query('SELECT 1 FROM job_attempts WHERE node_id = $1', [fresh.nodeId]),
      ).toEqual([]);
      await expectSettled(h);
    } finally {
      await next.app.close();
    }
  });

  it('a second server on the same database refuses to start (one scheduling process per database)', async () => {
    h = await startHarness();
    const second = await h.anotherServer();
    try {
      await expect(second.app.listen({ host: '127.0.0.1', port: 0 })).rejects.toThrow(
        /already scheduling jobs on this database/,
      );
    } finally {
      await second.app.close();
    }
    // The first one was not disturbed.
    await h.agent('still-1');
    expect((await h.chat(chatBody('still here'))).status).toBe(200);
    await expectSettled(h);
  });

  it('answers a buyer still waiting after the deadline when no rule ended the job (backstop)', async () => {
    // Sweeps off: nothing but the backstop ends the job.
    h = await startHarness({
      scheduler: { jobDeadlineMs: 800, waiterSlackMs: 300, sweepIntervalMs: 0 },
    });
    await h.agent('silent-1', { behavior: { run: 'silent', delayMs: 0 } });
    const started = performance.now();
    const res = await h.chat(chatBody('never answered'));
    expect(res.status).toBe(504);
    expect(((await res.json()) as ChatErr).error.code).toBe('deadline_exceeded');
    expect(performance.now() - started).toBeLessThan(5_000);
    await expectSettled(h);
  });

  it('answers a buyer whose job another scheduler ended out of its sight (backstop reads the database)', async () => {
    h = await startHarness({
      scheduler: { jobDeadlineMs: 800, waiterSlackMs: 300, sweepIntervalMs: 0 },
    });
    const t = h;
    const stuck = await h.agent('stuck-2', { behavior: { run: 'silent', delayMs: 0 } });
    const pending = h.chat(chatBody('ended elsewhere'));
    await waitFor(() => stuck.stats.accepted === 1, 5_000, 'job accepted');
    // What the instance lock now prevents: another scheduler on the same database cancels the job.
    const other = new Scheduler({
      db: h.app.db,
      clock: systemClock,
      ids: createIds(systemClock),
      cipher: createPayloadCipher(randomBytes(32).toString('hex'), 'other'),
      sessions: new SessionRegistry(),
      buyerPriceVersionId: h.world.priceVersionId,
      log: h.server.app.log,
      config: { ...DEFAULT_SCHEDULER_CONFIG, sweepIntervalMs: 0 },
    });
    expect(await other.recoverAfterRestart()).toBe(1);
    const res = await pending;
    expect(res.status).toBe(502);
    expect(((await res.json()) as ChatErr).error.code).toBe('node_failed');
    const [job] = await t.query<{ status: string; failure_code: string }>(
      'SELECT status, failure_code FROM jobs ORDER BY created_at DESC LIMIT 1',
    );
    expect(job).toEqual({ status: 'canceled', failure_code: 'server_restart' });
    await expectSettled(h);
  });

  it('completion racing lease expiry: every job is captured once or released once, never both', async () => {
    h = await startHarness();
    const t = h;
    // Results land right around the 1.5 s lease, with no progress, and cancels are ignored.
    for (const [i, delayMs] of [1_400, 1_500, 1_600].entries()) {
      await h.agent(`racer-${String(i)}`, {
        behavior: { delayMs, progressEveryMs: 0, ignoreCancel: true },
      });
    }
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => t.chat(chatBody(`race ${String(i)}`))),
    );
    for (const r of results) expect([200, 502, 503]).toContain(r.status);
    await expectSettled(h);
  });
});

describe('buyer input the protocol cannot carry', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('refuses a lone surrogate (400) and an input whose JSON escaping would not fit an offer (413)', async () => {
    h = await startHarness();
    const lone = await h.chat(chatBody('a\ud800b'));
    expect(lone.status).toBe(400);
    expect(((await lone.json()) as ChatErr).error.code).toBe('invalid_text');
    // 173,000 bytes of text (under the 256 KiB inline limit) escape to about 1 MB of JSON.
    const inflated = await h.chat(chatBody('\u0001'.repeat(173_000)));
    expect(inflated.status).toBe(413);
    expect(((await inflated.json()) as ChatErr).error.code).toBe('input_too_large');
    const jobs = await h.query<{ n: number }>('SELECT count(*)::int AS n FROM jobs');
    expect(jobs[0]?.n).toBe(0);
  });
});

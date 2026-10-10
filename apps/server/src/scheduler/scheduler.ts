/**
 * Job lifecycle for the walking skeleton: create (hold + encrypted input), offer to the first waiting node
 * with the model, accept, complete (capture), and every way a job can end without a result (offer
 * timeout, reject, lease expiry, disconnect, failure, deadline, no capacity, buyer gone) with a release.
 *
 * Correctness rules that later stages keep:
 * - Every state change is a conditional UPDATE (`WHERE status = <expected>`) on the job row, which is
 *   locked first, and the money for it moves in the same DB transaction. A late or duplicate message
 *   loses the race and changes nothing (no double capture, no capture after release).
 * - Time decisions read the DB and the injected Clock (`sweep`), so they are testable and survive a
 *   restart: nothing stays offered/running forever.
 *
 * SKELETON(S12): in-process dispatch (no SKIP LOCKED/LISTEN-NOTIFY across instances), "first waiting
 * node with the model" matching, no continuation after preemption (a retry restarts the job), no T35
 * no-progress limit (the lease and the deadline bound a stuck node).
 */
import { createHash, randomInt } from 'node:crypto';

import {
  defaultCodec,
  type JobCompletePayload,
  type JobFailPayload,
  type JobPreemptedPayload,
  type JobRejectPayload,
} from '@spareon/protocol';
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { type Db, type Tx, withTransaction } from '../db/client.js';
import {
  type AttemptStatus,
  jobAttempts,
  jobPayloads,
  jobs,
  models,
  nodes,
} from '../db/schema/index.js';
import { setNodeStatus } from '../fleet/nodes.js';
import type { AgentJobSink, AgentSession, SessionRegistry } from '../gateway/session.js';
import {
  captureJob,
  holdJob,
  type LedgerDeps,
  releaseJob,
  SKELETON_JOB_PRICE_UCR,
} from '../ledger/skeleton.js';
import type { Clock } from '../lib/clock.js';
import type { Ids } from '../lib/ids.js';
import { payloadAad, type PayloadCipher } from '../lib/payload-cipher.js';
import { safeErrorText } from '../lib/safe-error.js';

export interface SchedulerConfig {
  /** T8: an offer must be accepted within this time. */
  readonly offerTimeoutMs: number;
  /** T11: a running attempt dies when nothing renews its lease for this long. */
  readonly leaseMs: number;
  /** Accepted attempts per job: the first run plus retries (S04: 2 retries). */
  readonly maxStartedAttempts: number;
  /** T19: a queued job waits this long for a node before it fails with no_capacity. */
  readonly queueWaitMs: number;
  /** T21: interactive job deadline. */
  readonly jobDeadlineMs: number;
  /** T22: holds expire this long after the job deadline (the deadline sweep resolves them first). */
  readonly holdGraceMs: number;
  // SKELETON(S06): hold expiry is recorded but not enforced; job endings and the deadline sweep release holds.
  /** T27: encrypted input is deleted after this long. */
  readonly payloadRetentionMs: number;
  /** How often sweep() runs; 0 = only when called (tests). */
  readonly sweepIntervalMs: number;
  /**
   * A waiting buyer request is answered at the latest this long after the job deadline, even if no
   * rule ended the job (a backstop: the deadline sweep normally ends it first).
   */
  readonly waiterSlackMs: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  offerTimeoutMs: 2_000,
  leaseMs: 15_000,
  maxStartedAttempts: 3,
  queueWaitMs: 30_000,
  jobDeadlineMs: 10 * 60_000,
  holdGraceMs: 15 * 60_000,
  payloadRetentionMs: 24 * 60 * 60_000,
  sweepIntervalMs: 250,
  waiterSlackMs: 30_000,
};

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly maxTokens: number;
  readonly temperatureMilli: number;
  readonly topPMilli: number;
  readonly stop: readonly string[];
}

export type JobOutcome =
  | {
      readonly status: 'completed';
      readonly jobId: string;
      readonly text: string;
      readonly finishReason: 'stop' | 'length';
      readonly tokensIn: number;
      readonly tokensOut: number;
    }
  | {
      readonly status: 'failed' | 'expired' | 'canceled';
      readonly jobId: string;
      readonly code: string;
    };

export class ModelNotFoundError extends Error {
  readonly code = 'model_not_found';
  constructor() {
    super('model not found');
    this.name = 'ModelNotFoundError';
  }
}

export interface SchedulerDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly cipher: PayloadCipher;
  readonly sessions: SessionRegistry;
  readonly buyerPriceVersionId: string;
  readonly log: FastifyBaseLogger;
  readonly config: SchedulerConfig;
}

type FinalStatus = 'failed' | 'expired' | 'canceled';

interface AttemptEnd {
  readonly attemptId: string;
  /** Only this node may end the attempt (null: the server decides, e.g. a sweep). */
  readonly nodeId: string | null;
  readonly from: 'offered' | 'running';
  readonly to: AttemptStatus;
  readonly code: string;
  readonly retryable: boolean;
}

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const CODE_RE = /^[a-z][a-z0-9_.]{0,63}$/;
const safeCode = (code: string): string => (CODE_RE.test(code) ? code : 'unknown');

export class Scheduler implements AgentJobSink {
  readonly #deps: SchedulerDeps;
  readonly #ledger: LedgerDeps;
  /** Buyer requests waiting in this process, by job id, each with its backstop timer. */
  readonly #waiters = new Map<
    string,
    { readonly resolve: (outcome: JobOutcome) => void; timer?: NodeJS.Timeout }
  >();
  #dispatching = false;
  #dispatchAgain = false;
  #timer: NodeJS.Timeout | undefined;
  #sweeping: Promise<void> | undefined;
  #stopped = false;

  constructor(deps: SchedulerDeps) {
    this.#deps = deps;
    this.#ledger = { clock: deps.clock, ids: deps.ids };
  }

  start(): void {
    const ms = this.#deps.config.sweepIntervalMs;
    if (ms <= 0 || this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      if (this.#sweeping !== undefined) return;
      this.#sweeping = this.sweep()
        .catch((err: unknown) => {
          this.#deps.log.error({ err: safeErrorText(err) }, 'sweep failed');
        })
        .finally(() => {
          this.#sweeping = undefined;
        });
    }, ms);
  }

  /**
   * Run once before start(): end every job a previous server process left unfinished, without charging.
   * Nobody waits for those jobs any more (the buyer's HTTP request died with that process), so a retry
   * that completes would charge for an answer nobody receives.
   * SKELETON(S12): waiting buyers live in this process's memory; durable job results replace this.
   */
  async recoverAfterRestart(): Promise<number> {
    const open = await this.#deps.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(inArray(jobs.status, ['queued', 'offered', 'running']));
    // One broken job must not keep the server from starting (and every other hold tied up): each one
    // is isolated. A job left open here is never offered (dispatch only offers jobs a buyer in this
    // process waits for) and the deadline sweep ends it later.
    let failed = 0;
    for (const j of open) {
      await this.#isolated('restart recovery', async () => {
        try {
          await this.#finalize(j.id, 'canceled', 'server_restart');
        } catch (err) {
          failed++;
          throw err;
        }
      });
    }
    if (open.length > 0) {
      this.#deps.log.warn(
        { jobs: open.length, failed },
        'released jobs left unfinished by a previous run',
      );
    }
    return open.length - failed;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#sweeping;
  }

  // ---------------------------------------------------------------- buyer side

  /**
   * Create a job: hold the price, store the encrypted input, queue it. Throws ModelNotFoundError or
   * InsufficientCreditError (nothing is created then). The outcome resolves when the job ends.
   */
  async submit(
    buyerId: string,
    req: ChatRequest,
  ): Promise<{ jobId: string; outcome: Promise<JobOutcome> }> {
    const { db, clock, ids, cipher, config } = this.#deps;
    const [model] = await db
      .select({ id: models.id, status: models.status })
      .from(models)
      .where(eq(models.slug, req.model));
    if (model?.status !== 'active') throw new ModelNotFoundError();

    const jobId = ids.newId();
    const input = Buffer.from(JSON.stringify({ messages: req.messages }), 'utf8');
    const params = {
      maxTokens: req.maxTokens,
      temperatureMilli: req.temperatureMilli,
      topPMilli: req.topPMilli,
      stop: [...req.stop],
      // ADR 0007: the server chooses the seed, always.
      seed: randomInt(0, 2 ** 32),
      greedy: req.temperatureMilli === 0,
    };
    const outcome = new Promise<JobOutcome>((resolve) => {
      this.#waiters.set(jobId, { resolve });
    });
    try {
      await withTransaction(db, async (tx) => {
        const now = clock.now();
        const deadline = new Date(now.getTime() + config.jobDeadlineMs);
        const { holdId } = await holdJob(tx, this.#ledger, {
          jobId,
          buyerId,
          currency: 'CR',
          amount: SKELETON_JOB_PRICE_UCR,
          expiresAt: new Date(deadline.getTime() + config.holdGraceMs),
        });
        await tx.insert(jobs).values({
          id: jobId,
          buyerId,
          kind: 'chat',
          currency: 'CR',
          modelId: model.id,
          status: 'queued',
          params,
          inputBytes: input.length,
          maxTokens: req.maxTokens,
          priceVersionId: this.#deps.buyerPriceVersionId,
          holdId,
          deadlineAt: deadline,
          createdAt: now,
          statusChangedAt: now,
        });
        await tx.insert(jobPayloads).values({
          id: ids.newId(),
          jobId,
          kind: 'input',
          ciphertext: cipher.seal(input, payloadAad(jobId, 'input')),
          keyId: cipher.keyId,
          plaintextBytes: input.length,
          expiresAt: new Date(now.getTime() + config.payloadRetentionMs),
          createdAt: now,
        });
      });
    } catch (err) {
      this.#waiters.delete(jobId);
      throw err;
    }
    const waiter = this.#waiters.get(jobId);
    if (waiter !== undefined) {
      waiter.timer = setTimeout(() => {
        void this.#backstop(jobId).catch((err: unknown) => {
          this.#deps.log.error({ jobId, err: safeErrorText(err) }, 'waiter backstop failed');
        });
      }, config.jobDeadlineMs + config.waiterSlackMs);
      waiter.timer.unref();
    }
    this.kick();
    return { jobId, outcome };
  }

  /** The buyer went away: end the job without charging (it is still charged if it already completed). */
  async cancel(jobId: string, code = 'client_disconnected'): Promise<void> {
    await this.#finalize(jobId, 'canceled', code);
  }

  // ---------------------------------------------------------------- dispatch

  /** Ask for a dispatch round (coalesced; never runs two rounds at once). */
  kick(): void {
    if (this.#stopped) return;
    void this.dispatch().catch((err: unknown) => {
      this.#deps.log.error({ err: safeErrorText(err) }, 'dispatch failed');
    });
  }

  async dispatch(): Promise<void> {
    if (this.#dispatching) {
      this.#dispatchAgain = true;
      return;
    }
    this.#dispatching = true;
    try {
      do {
        this.#dispatchAgain = false;
        await this.#dispatchRound();
      } while (this.#repeatDispatch());
    } finally {
      this.#dispatching = false;
    }
  }

  /** A kick arrived during the round (read through a method: the flag changes across awaits). */
  #repeatDispatch(): boolean {
    return this.#dispatchAgain && !this.#stopped;
  }

  async #dispatchRound(): Promise<void> {
    const { db, sessions } = this.#deps;
    const free = sessions
      .list()
      .filter((s) => !s.closed && s.eligible && s.busyAttemptId === null && s.models.size > 0);
    if (free.length === 0 || this.#waiters.size === 0) return;
    // Only jobs a buyer in this process waits for: a job nobody waits for (left by a previous process)
    // would be charged for an answer nobody receives.
    const queued = await db
      .select({ id: jobs.id, model: models.slug })
      .from(jobs)
      .innerJoin(models, eq(models.id, jobs.modelId))
      .where(and(eq(jobs.status, 'queued'), inArray(jobs.id, [...this.#waiters.keys()])))
      .orderBy(desc(jobs.priority), asc(jobs.createdAt), asc(jobs.id))
      .limit(64);
    if (queued.length === 0) return;
    const tried = new Set(
      (
        await db
          .select({ jobId: jobAttempts.jobId, nodeId: jobAttempts.nodeId })
          .from(jobAttempts)
          .where(
            inArray(
              jobAttempts.jobId,
              queued.map((j) => j.id),
            ),
          )
      ).map((a) => `${a.jobId}/${a.nodeId}`),
    );
    for (const job of queued) {
      // SKELETON(S12): the first waiting node that has the model and has not tried this job.
      const index = free.findIndex(
        (s) => s.models.has(job.model) && !tried.has(`${job.id}/${s.nodeId}`),
      );
      const node = free[index];
      if (node === undefined) continue;
      free.splice(index, 1);
      await this.#offer(job.id, job.model, node);
      if (free.length === 0) return;
    }
  }

  async #offer(jobId: string, modelSlug: string, session: AgentSession): Promise<void> {
    const { db, clock, ids, cipher, config } = this.#deps;
    const attemptId = ids.newId();
    session.busyAttemptId = attemptId;
    let offered: { params: unknown; deadlineAt: Date; ciphertext: Buffer } | undefined;
    try {
      offered = await withTransaction(db, async (tx) => {
        const now = clock.now();
        const [job] = await tx
          .update(jobs)
          .set({ status: 'offered', statusChangedAt: now })
          .where(and(eq(jobs.id, jobId), eq(jobs.status, 'queued')))
          .returning({ params: jobs.params, deadlineAt: jobs.deadlineAt });
        if (job === undefined) return undefined;
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(jobAttempts)
          .where(eq(jobAttempts.jobId, jobId));
        await tx.insert(jobAttempts).values({
          id: attemptId,
          jobId,
          nodeId: session.nodeId,
          seq: count?.n ?? 0,
          status: 'offered',
          offeredAt: now,
        });
        const [payload] = await tx
          .select({ ciphertext: jobPayloads.ciphertext })
          .from(jobPayloads)
          .where(and(eq(jobPayloads.jobId, jobId), eq(jobPayloads.kind, 'input')));
        if (payload === undefined) throw new Error('input payload missing');
        return { params: job.params, deadlineAt: job.deadlineAt, ciphertext: payload.ciphertext };
      });
    } catch (err) {
      session.busyAttemptId = null;
      throw err;
    }
    if (offered === undefined) {
      session.busyAttemptId = null;
      return;
    }
    session.attemptIds.add(attemptId);
    let input: { messages: ChatMessage[] };
    try {
      input = JSON.parse(
        cipher.open(offered.ciphertext, payloadAad(jobId, 'input')).toString('utf8'),
      ) as { messages: ChatMessage[] };
    } catch {
      // Unreadable input (e.g. the development key changed after a restart): fail without charging.
      await this.#finalize(jobId, 'failed', 'input_unavailable');
      return;
    }
    const params = offered.params as {
      maxTokens: number;
      temperatureMilli: number;
      topPMilli: number;
      stop: string[];
      seed: number;
      greedy: boolean;
    };
    const sha = session.models.get(modelSlug);
    if (sha === undefined) {
      // The node's capabilities changed while the offer was prepared (it no longer has the model):
      // nothing was sent, so the attempt times out at once and the job goes back to the queue.
      await this.#endAttempt({
        attemptId,
        nodeId: session.nodeId,
        from: 'offered',
        to: 'timed_out',
        code: 'model_missing',
        retryable: true,
      });
      return;
    }
    const sent = session.send('job.offer', {
      attemptId,
      jobKind: 'chat',
      model: { id: modelSlug, sha256: sha },
      params,
      input: { messages: input.messages.map((m) => ({ role: m.role, content: m.content })) },
      stream: false,
      timeLimitMs: Math.max(1_000, offered.deadlineAt.getTime() - clock.now().getTime()),
      leaseTtlMs: config.leaseMs,
    });
    if (sent === 'invalid') {
      // The offer breaks the protocol, so it would fail on every node: end the job now, without
      // charging. input_unsendable only when the buyer's input itself is what the protocol refuses;
      // anything else is a server-side defect (offer_invalid). (A node's own job.fail input_invalid
      // is only the node's claim and stays a node failure.)
      const inputOk = defaultCodec().decodeJobInput(
        JSON.stringify({ messages: input.messages }),
        'chat',
      ).ok;
      await this.#finalize(jobId, 'failed', inputOk ? 'offer_invalid' : 'input_unsendable');
    } else if (sent === 'closed') {
      // The connection is gone; the close handler or the offer timeout puts the job back.
      this.#deps.log.warn({ jobId, nodeId: session.nodeId }, 'offer not sent');
    }
  }

  // ---------------------------------------------------------------- agent side (AgentJobSink)

  async onSessionReady(session: AgentSession): Promise<void> {
    await setNodeStatus(this.#deps.db, this.#deps.clock, session.nodeId, {
      state: 'idle',
      eligible: false,
      ineligibleReason: 'status_pending',
    });
  }

  onSessionStatus(): Promise<void> {
    this.kick();
    return Promise.resolve();
  }

  async onSessionClosed(session: AgentSession): Promise<void> {
    const { db } = this.#deps;
    const ids = [...session.attemptIds];
    if (ids.length > 0) {
      const active = await db
        .select({ id: jobAttempts.id, status: jobAttempts.status })
        .from(jobAttempts)
        .where(
          and(inArray(jobAttempts.id, ids), inArray(jobAttempts.status, ['offered', 'running'])),
        );
      for (const a of active) {
        const from = a.status === 'offered' ? 'offered' : 'running';
        // SKELETON(S11): no resume window — a closed connection loses its attempts at once.
        await this.#endAttempt({
          attemptId: a.id,
          nodeId: session.nodeId,
          from,
          to: from === 'offered' ? 'timed_out' : 'lost',
          code: 'connection_lost',
          retryable: true,
        });
      }
    }
    session.busyAttemptId = null;
    if (this.#deps.sessions.get(session.nodeId) === undefined) {
      await setNodeStatus(db, this.#deps.clock, session.nodeId, {
        state: 'offline',
        eligible: false,
        ineligibleReason: 'offline',
      });
    }
    this.kick();
  }

  async onJobAccept(session: AgentSession, attemptId: string): Promise<void> {
    const { db, clock, config } = this.#deps;
    const ok = await withTransaction(db, async (tx) => {
      const jobId = await this.#jobOfAttempt(tx, attemptId, session.nodeId);
      if (jobId === undefined) return false;
      const job = await lockJob(tx, jobId);
      if (job?.status !== 'offered') return false;
      const now = clock.now();
      const [att] = await tx
        .update(jobAttempts)
        .set({
          status: 'running',
          acceptedAt: now,
          leaseExpiresAt: new Date(now.getTime() + config.leaseMs),
          lastProgressAt: now,
        })
        .where(
          and(
            eq(jobAttempts.id, attemptId),
            eq(jobAttempts.nodeId, session.nodeId),
            eq(jobAttempts.status, 'offered'),
          ),
        )
        .returning({ id: jobAttempts.id });
      if (att === undefined) return false;
      await tx
        .update(jobs)
        .set({
          status: 'running',
          attempts: sql`${jobs.attempts} + 1`,
          statusChangedAt: now,
        })
        .where(and(eq(jobs.id, jobId), eq(jobs.status, 'offered')));
      await tx
        .update(nodes)
        .set({ state: 'running', stateChangedAt: now, updatedAt: now })
        .where(and(eq(nodes.id, session.nodeId), inArray(nodes.state, ['idle', 'running'])));
      return true;
    });
    if (!ok) {
      // Too late (offer timed out, job canceled) or not this node's attempt: make sure it does not run.
      session.send('job.cancel', { attemptId, reason: 'superseded' });
      if (session.busyAttemptId === attemptId) session.busyAttemptId = null;
      this.kick();
    }
  }

  async onJobReject(session: AgentSession, payload: JobRejectPayload): Promise<void> {
    await this.#endAttempt({
      attemptId: payload.attemptId,
      nodeId: session.nodeId,
      from: 'offered',
      to: 'rejected',
      code: `rejected.${payload.reason.toLowerCase()}`,
      retryable: true,
    });
  }

  async onJobProgress(session: AgentSession, attemptId: string): Promise<void> {
    const { db, clock, config } = this.#deps;
    const now = clock.now();
    await db
      .update(jobAttempts)
      .set({ leaseExpiresAt: new Date(now.getTime() + config.leaseMs), lastProgressAt: now })
      .where(
        and(
          eq(jobAttempts.id, attemptId),
          eq(jobAttempts.nodeId, session.nodeId),
          eq(jobAttempts.status, 'running'),
        ),
      );
  }

  async onJobFail(session: AgentSession, payload: JobFailPayload): Promise<void> {
    await this.#endAttempt({
      attemptId: payload.attemptId,
      nodeId: session.nodeId,
      from: 'running',
      to: 'failed',
      code: payload.code,
      retryable: payload.retryable,
    });
  }

  async onJobPreempted(session: AgentSession, payload: JobPreemptedPayload): Promise<void> {
    // SKELETON(S12): no continuation — the output so far is discarded and a retry starts over.
    await this.#endAttempt({
      attemptId: payload.attemptId,
      nodeId: session.nodeId,
      from: 'running',
      to: 'preempted',
      code: `preempted.${payload.reason.toLowerCase()}`,
      retryable: true,
    });
  }

  async onJobComplete(session: AgentSession, p: JobCompletePayload): Promise<void> {
    const text = p.outputText;
    if (text === undefined) {
      // SKELETON(S12): chunked output (outputRef) is not assembled yet.
      await this.#endAttempt({
        attemptId: p.attemptId,
        nodeId: session.nodeId,
        from: 'running',
        to: 'failed',
        code: 'output_unsupported',
        retryable: false,
      });
      return;
    }
    if (sha256Hex(text) !== p.outputSha256) {
      await this.#endAttempt({
        attemptId: p.attemptId,
        nodeId: session.nodeId,
        from: 'running',
        to: 'failed',
        code: 'output_hash_mismatch',
        retryable: true,
      });
      return;
    }
    const { db, clock } = this.#deps;
    const result = await withTransaction(db, async (tx) => {
      const jobId = await this.#jobOfAttempt(tx, p.attemptId, session.nodeId);
      if (jobId === undefined) return { kind: 'unknown' as const };
      const job = await lockJob(tx, jobId);
      const now = clock.now();
      const [att] = await tx
        .update(jobAttempts)
        .set({
          status: 'completed',
          endedAt: now,
          endReason: p.finishReason,
          reportedTokensIn: p.reportedTokensIn,
          reportedTokensOut: p.reportedTokensOut,
          outputSha256: p.outputSha256,
          timings: p.timings,
        })
        .where(
          and(
            eq(jobAttempts.id, p.attemptId),
            eq(jobAttempts.nodeId, session.nodeId),
            eq(jobAttempts.status, 'running'),
          ),
        )
        .returning({ id: jobAttempts.id });
      if (att === undefined || job?.status !== 'running' || job.holdId === null) {
        if (att !== undefined) throw new Error('running attempt on a job that is not running');
        // Late or duplicate completion: no reward (ARCHITECTURE 5.3 lost/canceled → superseded).
        await tx
          .update(jobAttempts)
          .set({ status: 'superseded' })
          .where(
            and(eq(jobAttempts.id, p.attemptId), inArray(jobAttempts.status, ['lost', 'canceled'])),
          );
        return { kind: 'late' as const };
      }
      const [node] = await tx
        .select({ storeId: nodes.storeId })
        .from(nodes)
        .where(eq(nodes.id, session.nodeId));
      if (node === undefined) throw new Error('node row missing');
      const capture = await captureJob(tx, this.#ledger, {
        jobId,
        holdId: job.holdId,
        storeId: node.storeId,
        nodeId: session.nodeId,
        attemptId: p.attemptId,
      });
      if (capture === null) throw new Error('hold not active for a running job');
      const done = await tx
        .update(jobs)
        .set({
          status: 'completed',
          costUcr: capture.cost,
          endedAt: now,
          statusChangedAt: now,
        })
        .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')))
        .returning({ id: jobs.id });
      if (done.length !== 1) throw new Error('job changed under lock');
      await tx
        .update(nodes)
        .set({ state: 'idle', stateChangedAt: now, updatedAt: now })
        .where(and(eq(nodes.id, session.nodeId), eq(nodes.state, 'running')));
      return { kind: 'completed' as const, jobId };
    });
    if (session.busyAttemptId === p.attemptId) session.busyAttemptId = null;
    session.attemptIds.delete(p.attemptId);
    if (result.kind === 'completed') {
      this.#resolve({
        status: 'completed',
        jobId: result.jobId,
        text,
        finishReason: p.finishReason,
        tokensIn: p.reportedTokensIn,
        tokensOut: p.reportedTokensOut,
      });
    }
    this.kick();
  }

  // ---------------------------------------------------------------- time (sweep)

  /** Apply every time-based rule once. Safe to run concurrently with message handling. */
  async sweep(): Promise<void> {
    const { db, clock, config } = this.#deps;
    const now = clock.now().getTime();
    const offered = await db
      .select({ id: jobAttempts.id })
      .from(jobAttempts)
      .where(
        and(
          eq(jobAttempts.status, 'offered'),
          lte(jobAttempts.offeredAt, new Date(now - config.offerTimeoutMs)),
        ),
      );
    for (const a of offered) {
      await this.#isolated('offer timeout', () =>
        this.#endAttempt({
          attemptId: a.id,
          nodeId: null,
          from: 'offered',
          to: 'timed_out',
          code: 'offer_timeout',
          retryable: true,
        }),
      );
    }
    const expiredLeases = await db
      .select({ id: jobAttempts.id, nodeId: jobAttempts.nodeId })
      .from(jobAttempts)
      .where(
        and(eq(jobAttempts.status, 'running'), lte(jobAttempts.leaseExpiresAt, new Date(now))),
      );
    for (const a of expiredLeases) {
      await this.#isolated('lease expiry', async () => {
        const ended = await this.#endAttempt({
          attemptId: a.id,
          nodeId: null,
          from: 'running',
          to: 'lost',
          code: 'lease_expired',
          retryable: true,
        });
        // The node may still be computing (alive but silent): tell it to stop.
        if (ended)
          this.#deps.sessions
            .get(a.nodeId)
            ?.send('job.cancel', { attemptId: a.id, reason: 'superseded' });
      });
    }
    const pastDeadline = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          inArray(jobs.status, ['queued', 'offered', 'running']),
          lte(jobs.deadlineAt, new Date(now)),
        ),
      );
    for (const j of pastDeadline) {
      await this.#isolated('deadline', () => this.#finalize(j.id, 'expired', 'deadline'));
    }
    const starving = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.status, 'queued'),
          lte(jobs.statusChangedAt, new Date(now - config.queueWaitMs)),
        ),
      );
    for (const j of starving) {
      await this.#isolated('no capacity', () => this.#finalize(j.id, 'expired', 'no_capacity'));
    }
    // T27: buyer content is deleted when its retention ends (ADR 0010).
    await db.delete(jobPayloads).where(lte(jobPayloads.expiresAt, new Date(now)));
    if (offered.length + expiredLeases.length > 0) this.kick();
  }

  // ---------------------------------------------------------------- internals

  /** One sweep item: a failure is logged (metadata only) and does not stop the rules after it. */
  async #isolated(rule: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.#deps.log.error({ rule, err: safeErrorText(err) }, 'sweep item failed');
    }
  }

  async #jobOfAttempt(
    tx: Tx,
    attemptId: string,
    nodeId: string | null,
  ): Promise<string | undefined> {
    const [row] = await tx
      .select({ jobId: jobAttempts.jobId, nodeId: jobAttempts.nodeId })
      .from(jobAttempts)
      .where(eq(jobAttempts.id, attemptId));
    if (row === undefined || (nodeId !== null && row.nodeId !== nodeId)) return undefined;
    return row.jobId;
  }

  /**
   * End one attempt (conditional on its current status) and decide the job: back to the queue when it
   * may run again, otherwise failed with a release. Returns true when this call ended the attempt.
   */
  async #endAttempt(end: AttemptEnd): Promise<boolean> {
    const { db, clock, config } = this.#deps;
    const result = await withTransaction(db, async (tx) => {
      const jobId = await this.#jobOfAttempt(tx, end.attemptId, end.nodeId);
      if (jobId === undefined) return undefined;
      const job = await lockJob(tx, jobId);
      if (job === undefined) return undefined;
      const now = clock.now();
      const [att] = await tx
        .update(jobAttempts)
        .set({ status: end.to, endedAt: now, endReason: safeCode(end.code) })
        .where(and(eq(jobAttempts.id, end.attemptId), eq(jobAttempts.status, end.from)))
        .returning({ nodeId: jobAttempts.nodeId });
      if (att === undefined) return undefined;
      await tx
        .update(nodes)
        .set({ state: 'idle', stateChangedAt: now, updatedAt: now })
        .where(and(eq(nodes.id, att.nodeId), eq(nodes.state, 'running')));
      let outcome: JobOutcome | undefined;
      if (job.status === end.from) {
        const retry =
          end.from === 'offered' || (end.retryable && job.attempts < config.maxStartedAttempts);
        if (retry) {
          await tx
            .update(jobs)
            .set({ status: 'queued', statusChangedAt: now })
            .where(and(eq(jobs.id, jobId), eq(jobs.status, end.from)));
        } else {
          outcome = await this.#endJob(tx, jobId, job.holdId, 'failed', end.code);
        }
      }
      return { nodeId: att.nodeId, outcome };
    });
    if (result === undefined) return false;
    const session = this.#deps.sessions.get(result.nodeId);
    if (session?.busyAttemptId === end.attemptId) session.busyAttemptId = null;
    session?.attemptIds.delete(end.attemptId);
    if (result.outcome !== undefined) this.#resolve(result.outcome);
    this.kick();
    return true;
  }

  /** End a job that has not finished (any non-final status) without a result, releasing its hold. */
  async #finalize(jobId: string, status: FinalStatus, code: string): Promise<void> {
    const { db, clock } = this.#deps;
    const result = await withTransaction(db, async (tx) => {
      const job = await lockJob(tx, jobId);
      if (job === undefined || !['queued', 'offered', 'running'].includes(job.status)) {
        return undefined;
      }
      const now = clock.now();
      const canceled = await tx
        .update(jobAttempts)
        .set({ status: 'canceled', endedAt: now, endReason: safeCode(code) })
        .where(
          and(eq(jobAttempts.jobId, jobId), inArray(jobAttempts.status, ['offered', 'running'])),
        )
        .returning({ id: jobAttempts.id, nodeId: jobAttempts.nodeId });
      for (const a of canceled) {
        await tx
          .update(nodes)
          .set({ state: 'idle', stateChangedAt: now, updatedAt: now })
          .where(and(eq(nodes.id, a.nodeId), eq(nodes.state, 'running')));
      }
      const outcome = await this.#endJob(tx, jobId, job.holdId, status, code);
      return { outcome, canceled };
    });
    if (result === undefined) return;
    for (const a of result.canceled) {
      const session = this.#deps.sessions.get(a.nodeId);
      session?.send('job.cancel', {
        attemptId: a.id,
        reason: status === 'canceled' ? 'buyerCanceled' : 'deadline',
      });
      if (session?.busyAttemptId === a.id) session.busyAttemptId = null;
      session?.attemptIds.delete(a.id);
    }
    this.#resolve(result.outcome);
    this.kick();
  }

  async #endJob(
    tx: Tx,
    jobId: string,
    holdId: string | null,
    status: FinalStatus,
    code: string,
  ): Promise<JobOutcome> {
    const now = this.#deps.clock.now();
    await tx
      .update(jobs)
      .set({ status, failureCode: safeCode(code), endedAt: now, statusChangedAt: now })
      .where(and(eq(jobs.id, jobId), inArray(jobs.status, ['queued', 'offered', 'running'])));
    // No result, no charge: the whole hold goes back (S04: "최종 실패 시 과금하지 않는다").
    if (holdId !== null) await releaseJob(tx, this.#ledger, { jobId, holdId });
    return { status, jobId, code: safeCode(code) };
  }

  #resolve(outcome: JobOutcome): void {
    const waiter = this.#waiters.get(outcome.jobId);
    if (waiter === undefined) return;
    this.#waiters.delete(outcome.jobId);
    clearTimeout(waiter.timer);
    waiter.resolve(outcome);
  }

  /**
   * Backstop for a buyer still waiting well after the job deadline: end the job if it is still open
   * (that answers the buyer), otherwise answer from the job's final status in the database. Without
   * this a job ended where this process could not see it would leave the HTTP request hanging forever.
   */
  async #backstop(jobId: string): Promise<void> {
    if (!this.#waiters.has(jobId)) return;
    await this.#finalize(jobId, 'expired', 'deadline');
    if (!this.#waiters.has(jobId)) return;
    const [job] = await this.#deps.db
      .select({ status: jobs.status, failureCode: jobs.failureCode })
      .from(jobs)
      .where(eq(jobs.id, jobId));
    const status = job?.status;
    const ended = status === 'failed' || status === 'expired' || status === 'canceled';
    // A completed job whose result never reached this process cannot be delivered from here.
    this.#deps.log.error({ jobId, status }, 'buyer request answered by the backstop');
    this.#resolve({
      status: ended ? status : 'failed',
      jobId,
      code: ended ? (job?.failureCode ?? 'unknown') : 'outcome_lost',
    });
  }
}

async function lockJob(
  tx: Tx,
  jobId: string,
): Promise<{ status: string; attempts: number; holdId: string | null } | undefined> {
  const [job] = await tx
    .select({ status: jobs.status, attempts: jobs.attempts, holdId: jobs.holdId })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .for('update');
  return job;
}

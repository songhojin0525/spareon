/**
 * `POST /v1/chat/completions` — the smallest useful part of the OpenAI format, non-streaming. The route
 * itself is registered by the composition root (http/routes/buyer.ts), which authenticates the API key,
 * applies the permission table, the `chat` scope and the per-key limits before this handler runs.
 *
 * `Idempotency-Key`: same key + same body → the same response (the output is kept encrypted for the
 * replay, ADR 0010); same key + different body → 409. A failure that charged nothing frees the key.
 *
 * SKELETON(S14): no streaming (SSE); usage counts are the node's report (ADR 0009 server-side counting
 * arrives with S09/S12).
 */
import { LIMITS } from '@spareon/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { jobs } from '../db/schema/index.js';
import { InsufficientCreditError } from '../ledger/skeleton.js';
import type { Clock } from '../lib/clock.js';
import { AppError, badRequest, conflict } from '../lib/errors.js';
import {
  type ClaimResolver,
  type ClaimToken,
  type Idempotency,
  IDEMPOTENCY_KEY_RE,
  IdempotencyClaimLostError,
  requestHash,
} from '../lib/idempotency.js';
import { safeErrorText } from '../lib/safe-error.js';
import { type PayloadDeps, readOutput, storeOutput } from '../retention/payloads.js';
import {
  type ChatRequest,
  type JobOutcome,
  ModelNotFoundError,
  type Scheduler,
} from '../scheduler/scheduler.js';

export const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';

export interface BuyerApiDeps {
  readonly scheduler: Scheduler;
  readonly clock: Clock;
  readonly idempotency: Idempotency;
  /** Key for the request hash stored with an idempotency claim (derived from SESSION_SECRET). */
  readonly idempotencyHashKey: Uint8Array;
  readonly payloads: PayloadDeps;
  /** How long an output kept for idempotent replay lives (24 h, T27). */
  readonly replayRetentionMs: number;
}

export const chatBodySchema = z.object({
  model: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'unknown model id format'),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string(),
      }),
    )
    .min(1)
    .max(256),
  max_tokens: z.number().int().min(1).max(4096).optional(),
  max_completion_tokens: z.number().int().min(1).max(4096).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().gt(0).max(1).optional(),
  stop: z.union([z.string().min(1).max(64), z.array(z.string().min(1).max(64)).max(8)]).optional(),
  stream: z.boolean().optional(),
  n: z.literal(1).optional(),
});
export type ChatBody = z.infer<typeof chatBodySchema>;

export const chatResponseSchema = z.object({
  id: z.string(),
  object: z.literal('chat.completion'),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number().int(),
      message: z.object({ role: z.literal('assistant'), content: z.string() }),
      finish_reason: z.enum(['stop', 'length']),
    }),
  ),
  usage: z.object({
    prompt_tokens: z.number().int(),
    completion_tokens: z.number().int(),
    total_tokens: z.number().int(),
  }),
});
type ChatResponse = z.infer<typeof chatResponseSchema>;

const encoder = new TextEncoder();
/** A lone UTF-16 surrogate cannot be encoded as UTF-8 JSON: the protocol codec refuses it. */
const LONE_SURROGATE = /\p{Cs}/u;
/** Room for the job.offer envelope and params around the messages (ids, model, limits). */
const OFFER_OVERHEAD_BYTES = 16 * 1024;

/** Failures that may have charged the buyer: an idempotency key must keep answering with them. */
const POSSIBLY_CHARGED = new Set(['result_undelivered', 'outcome_unknown']);

/** Error for a job that ended without a result (nothing was charged unless the code says otherwise). */
export function outcomeError(
  outcome: Extract<JobOutcome, { status: 'failed' | 'expired' | 'canceled' }>,
): AppError {
  switch (outcome.code) {
    case 'no_capacity':
      return new AppError(
        'no_capacity',
        503,
        'No node is available for this model right now. Nothing was charged.',
      );
    case 'input_unsendable':
      // The server found the input itself cannot be carried to a node: a retry fails the same way.
      // (A node reporting input_invalid is only that node's claim: it stays node_failed below.)
      return new AppError(
        'input_invalid',
        400,
        'The messages cannot be sent to a node as they are. Nothing was charged.',
      );
    case 'offer_invalid':
      return new AppError(
        'internal_error',
        500,
        'The server could not process this request. Nothing was charged.',
      );
    case 'result_undelivered':
      // The job completed and was charged, but its result never reached this server process.
      return new AppError(
        'result_undelivered',
        500,
        'The request completed and was charged, but the server lost the result. Please contact the operator.',
      );
    case 'outcome_unknown':
      return new AppError(
        'outcome_unknown',
        500,
        'The server lost track of this request. Please contact the operator.',
      );
    case 'server_restart':
      return new AppError(
        'server_restarted',
        503,
        'The server restarted before the request finished. Nothing was charged.',
      );
    case 'deadline':
      return new AppError(
        'deadline_exceeded',
        504,
        'The request took too long. Nothing was charged.',
      );
    default:
      return new AppError(
        'node_failed',
        502,
        `The request failed on the nodes (${outcome.code}). Nothing was charged.`,
      );
  }
}

/** Checks that do not need the scheduler (input the protocol cannot carry). */
function checkSendable(body: ChatBody): void {
  if (body.stream === true) {
    throw badRequest(
      'stream_unsupported',
      'Streaming is not supported yet (stream must be false).',
    );
  }
  const texts = [
    ...body.messages.map((m) => m.content),
    ...(body.stop === undefined ? [] : [body.stop].flat()),
  ];
  if (texts.some((t) => LONE_SURROGATE.test(t))) {
    throw badRequest('invalid_text', 'Text contains an unpaired UTF-16 surrogate.');
  }
  let inlineBytes = 0;
  for (const m of body.messages) inlineBytes += encoder.encode(m.content).length;
  // SKELETON(S12): large inputs go through inputRef.
  if (inlineBytes > LIMITS.maxInlineTextBytes) {
    throw new AppError(
      'input_too_large',
      413,
      `Message text exceeds ${String(LIMITS.maxInlineTextBytes)} bytes.`,
    );
  }
  // JSON escaping can grow the text (control characters become \u00XX): the offer must still fit.
  const escapedBytes = encoder.encode(JSON.stringify(body.messages)).length;
  const maxEscaped = LIMITS.maxMessageBytes - OFFER_OVERHEAD_BYTES;
  if (escapedBytes > maxEscaped) {
    throw new AppError(
      'input_too_large',
      413,
      `After JSON escaping, the messages exceed ${String(maxEscaped)} bytes.`,
    );
  }
}

function toChatRequest(body: ChatBody): ChatRequest {
  return {
    model: body.model,
    messages: body.messages,
    maxTokens: body.max_completion_tokens ?? body.max_tokens ?? 256,
    // The one place real numbers become protocol integers (ADR 0017).
    temperatureMilli: Math.round((body.temperature ?? 0.7) * 1000),
    topPMilli: Math.max(1, Math.round((body.top_p ?? 1) * 1000)),
    stop: body.stop === undefined ? [] : typeof body.stop === 'string' ? [body.stop] : body.stop,
  };
}

/** What an idempotency record keeps: metadata to rebuild the response, never the text. */
const replaySchema = z.union([
  z.object({
    kind: z.literal('completion'),
    jobId: z.uuid(),
    created: z.number().int(),
    model: z.string(),
    finishReason: z.enum(['stop', 'length']),
    promptTokens: z.number().int(),
    completionTokens: z.number().int(),
  }),
  z.object({
    kind: z.literal('error'),
    code: z.string(),
    status: z.number().int(),
    message: z.string(),
  }),
]);
type ReplayRecord = z.infer<typeof replaySchema>;

function responseOf(r: Extract<ReplayRecord, { kind: 'completion' }>, text: string): ChatResponse {
  return {
    id: `chatcmpl-${r.jobId}`,
    object: 'chat.completion',
    created: r.created,
    model: r.model,
    choices: [
      { index: 0, message: { role: 'assistant', content: text }, finish_reason: r.finishReason },
    ],
    usage: {
      prompt_tokens: r.promptTokens,
      completion_tokens: r.completionTokens,
      total_tokens: r.promptTokens + r.completionTokens,
    },
  };
}

export interface ChatCall {
  readonly req: FastifyRequest;
  readonly reply: FastifyReply;
  readonly buyerId: string;
  readonly apiKeyId: string;
  readonly body: ChatBody;
}

export async function handleChatCompletion(
  deps: BuyerApiDeps,
  call: ChatCall,
): Promise<ChatResponse> {
  const { body, req } = call;
  checkSendable(body);
  const header = req.headers['idempotency-key'];
  if (header === undefined) return run(deps, call, undefined);
  if (typeof header !== 'string' || !IDEMPOTENCY_KEY_RE.test(header)) {
    throw badRequest(
      'invalid_idempotency_key',
      'Idempotency-Key must be 1..255 printable ASCII characters.',
    );
  }
  const scope = `buyer:${call.buyerId}:chat`;
  const claim = await deps.idempotency.claim(
    scope,
    header,
    requestHash(deps.idempotencyHashKey, body),
    resolveUnfinishedClaim,
  );
  if (claim.kind === 'mismatch') {
    throw conflict(
      'idempotency_key_reused',
      'This Idempotency-Key was used with a different request body.',
    );
  }
  if (claim.kind === 'in_progress') {
    throw conflict(
      'idempotency_in_progress',
      'A request with this Idempotency-Key is still running.',
    );
  }
  if (claim.kind === 'replay') {
    const rec = replaySchema.parse(claim.response);
    if (rec.kind === 'error') throw new AppError(rec.code, rec.status, rec.message);
    const text = await readOutput(deps.payloads, rec.jobId);
    if (text === undefined) {
      throw new AppError(
        'idempotent_result_expired',
        410,
        'The result for this Idempotency-Key is no longer kept. It was charged once.',
      );
    }
    call.reply.header('idempotent-replayed', 'true');
    return responseOf(rec, text);
  }
  return run(deps, call, { scope, key: header, token: claim.token });
}

const attachedSchema = z.object({ jobId: z.uuid() });

/**
 * An unfinished claim of this buyer's key, found by another request. The claim records its job id in
 * the job's own transaction, so the job's state says what happened: still open → in progress; ended
 * without a charge (failed, expired, canceled — e.g. by a restart) → the key may run again; completed
 * but never recorded (the process died or the record failed after the charge) → answer that it was
 * charged and the result is lost, never run it a second time.
 */
const resolveUnfinishedClaim: ClaimResolver = async (attached, stale, tx) => {
  const parsed = attachedSchema.safeParse(attached);
  if (!parsed.success) return stale ? { kind: 'take_over' } : { kind: 'in_progress' };
  const [job] = await tx
    .select({ status: jobs.status })
    .from(jobs)
    .where(eq(jobs.id, parsed.data.jobId));
  if (job === undefined || ['failed', 'expired', 'canceled'].includes(job.status)) {
    return { kind: 'take_over' };
  }
  if (job.status === 'completed' && stale) {
    const err = outcomeError({
      status: 'failed',
      jobId: parsed.data.jobId,
      code: 'result_undelivered',
    });
    const record: ReplayRecord = {
      kind: 'error',
      code: err.code,
      status: err.httpStatus,
      message: err.publicMessage,
    };
    return { kind: 'complete', status: err.httpStatus, response: record };
  }
  return { kind: 'in_progress' };
};

async function run(
  deps: BuyerApiDeps,
  call: ChatCall,
  idem: { scope: string; key: string; token: ClaimToken } | undefined,
): Promise<ChatResponse> {
  const { req, reply, body } = call;
  const claim = { settled: false, jobCreated: false };
  const settle = async (record: ReplayRecord | undefined): Promise<void> => {
    if (idem === undefined || claim.settled) return;
    claim.settled = true;
    if (record === undefined) await deps.idempotency.release(idem.scope, idem.key, idem.token);
    else
      await deps.idempotency.complete(
        idem.scope,
        idem.key,
        idem.token,
        record.kind === 'error' ? record.status : 200,
        record,
      );
  };
  try {
    // The buyer may hang up at any time, even while the job is being created: cancel then (the hold is
    // released unless the job already completed).
    const hangup: { gone: boolean; jobId: string | undefined } = { gone: false, jobId: undefined };
    const cancel = (id: string): void => {
      void deps.scheduler.cancel(id).catch((err: unknown) => {
        req.log.error({ err: safeErrorText(err) }, 'cancel failed');
      });
    };
    reply.raw.once('close', () => {
      if (reply.raw.writableEnded) return;
      hangup.gone = true;
      if (hangup.jobId !== undefined) cancel(hangup.jobId);
    });
    let submitted: Awaited<ReturnType<Scheduler['submit']>>;
    try {
      submitted = await deps.scheduler.submit(call.buyerId, toChatRequest(body), {
        apiKeyId: call.apiKeyId,
        ...(idem === undefined
          ? {}
          : {
              // The claim learns its job id in the job's own transaction (no window where a job
              // exists that the claim does not know about).
              onCreate: async (tx, jobId) => {
                const ours = await deps.idempotency.attach(tx, idem.scope, idem.key, idem.token, {
                  jobId,
                });
                // Taken over meanwhile: roll the job (and its hold) back rather than run it twice.
                if (!ours) throw new IdempotencyClaimLostError();
              },
            }),
      });
      claim.jobCreated = true;
    } catch (err) {
      if (err instanceof ModelNotFoundError) {
        throw new AppError(
          'model_not_found',
          404,
          `The model ${body.model} does not exist or no node has offered it yet.`,
        );
      }
      if (err instanceof IdempotencyClaimLostError) {
        throw conflict(
          'idempotency_in_progress',
          'Another request with this Idempotency-Key took over. Nothing was charged here.',
        );
      }
      if (err instanceof InsufficientCreditError) {
        throw new AppError('insufficient_credit', 402, 'Not enough credit for this request.');
      }
      throw err;
    }
    hangup.jobId = submitted.jobId;
    if (hangup.gone) cancel(submitted.jobId);
    const outcome = await submitted.outcome;
    if (outcome.status !== 'completed') {
      const err = outcomeError(outcome);
      await settle(
        POSSIBLY_CHARGED.has(outcome.code)
          ? { kind: 'error', code: err.code, status: err.httpStatus, message: err.publicMessage }
          : undefined,
      );
      throw err;
    }
    const record: Extract<ReplayRecord, { kind: 'completion' }> = {
      kind: 'completion',
      jobId: outcome.jobId,
      created: Math.floor(deps.clock.now().getTime() / 1000),
      model: body.model,
      finishReason: outcome.finishReason,
      promptTokens: outcome.tokensIn,
      completionTokens: outcome.tokensOut,
    };
    if (idem !== undefined) {
      // Charged: from here on the key must replay this result, never run the job again.
      try {
        await storeOutput(deps.payloads, outcome.jobId, outcome.text, deps.replayRetentionMs);
      } finally {
        await settle(record);
      }
    }
    return responseOf(record, outcome.text);
  } finally {
    // Anything that ended before a job existed (model, credit, server error) charged nothing: free the
    // key so the buyer can retry with it. Once a job exists, an unsettled claim stays: the next request
    // with this key asks the job's state (resolverFor) instead of running it again.
    if (!claim.settled && !claim.jobCreated) await settle(undefined);
  }
}

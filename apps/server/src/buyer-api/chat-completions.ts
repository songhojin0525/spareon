/**
 * `POST /v1/chat/completions` — the smallest useful part of the OpenAI format, non-streaming.
 *
 * SKELETON(S05): one development API key (DEV_API_KEY) authenticates one development buyer.
 * SKELETON(S14): no streaming (SSE), no idempotency keys, no per-key limits; usage counts are the node's
 * report (ADR 0009 server-side counting arrives with S09/S12).
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { LIMITS } from '@spareon/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { InsufficientCreditError } from '../ledger/skeleton.js';
import type { Clock } from '../lib/clock.js';
import { safeErrorText } from '../lib/safe-error.js';
import {
  type ChatRequest,
  type JobOutcome,
  ModelNotFoundError,
  type Scheduler,
} from '../scheduler/scheduler.js';

export const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';

export interface BuyerApiDeps {
  readonly scheduler: Scheduler;
  /** Undefined: every request is 401 (production until S05). */
  readonly devApiKey: string | undefined;
  readonly devBuyerId: string;
  readonly clock: Clock;
}

const bodySchema = z.object({
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

type ErrorType =
  'invalid_request_error' | 'authentication_error' | 'insufficient_quota' | 'server_error';

function sendError(
  reply: FastifyReply,
  status: number,
  type: ErrorType,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error: { message, type, code } });
}

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time comparison of the bearer token with the development key. */
export function bearerMatches(header: string | undefined, key: string | undefined): boolean {
  if (key === undefined || header === undefined) return false;
  const match = /^Bearer (\S+)$/.exec(header);
  if (match?.[1] === undefined) return false;
  return timingSafeEqual(digest(match[1]), digest(key));
}

const encoder = new TextEncoder();
/** A lone UTF-16 surrogate cannot be encoded as UTF-8 JSON: the protocol codec refuses it. */
const LONE_SURROGATE = /\p{Cs}/u;
/** Room for the job.offer envelope and params around the messages (ids, model, limits). */
const OFFER_OVERHEAD_BYTES = 16 * 1024;

/** OpenAI-style error for a job that ended without a result (nothing was charged). */
function outcomeError(
  reply: FastifyReply,
  outcome: Extract<JobOutcome, { status: 'failed' | 'expired' | 'canceled' }>,
): FastifyReply {
  if (outcome.code === 'no_capacity') {
    return sendError(
      reply,
      503,
      'server_error',
      'no_capacity',
      'No node is available for this model right now. Nothing was charged.',
    );
  }
  if (outcome.code === 'input_unsendable') {
    // The server found the input itself cannot be carried to a node: a retry fails the same way.
    // (A node reporting input_invalid is only that node's claim: it stays node_failed below.)
    return sendError(
      reply,
      400,
      'invalid_request_error',
      'input_invalid',
      'The messages cannot be sent to a node as they are. Nothing was charged.',
    );
  }
  if (outcome.code === 'offer_invalid' || outcome.code === 'outcome_lost') {
    return sendError(
      reply,
      500,
      'server_error',
      'internal_error',
      'The server could not process this request. Nothing was charged.',
    );
  }
  if (outcome.code === 'deadline') {
    return sendError(
      reply,
      504,
      'server_error',
      'deadline_exceeded',
      'The request took too long. Nothing was charged.',
    );
  }
  return sendError(
    reply,
    502,
    'server_error',
    'node_failed',
    `The request failed on the nodes (${outcome.code}). Nothing was charged.`,
  );
}

export function registerChatCompletions(app: FastifyInstance, deps: BuyerApiDeps): void {
  app.post(CHAT_COMPLETIONS_PATH, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!bearerMatches(request.headers.authorization, deps.devApiKey)) {
      return sendError(reply, 401, 'authentication_error', 'invalid_api_key', 'Invalid API key.');
    }
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      // Paths only: never echo request content.
      const where = parsed.error.issues.map((i) => i.path.join('.') || '(body)').join(', ');
      return sendError(
        reply,
        400,
        'invalid_request_error',
        'invalid_request',
        `Invalid request: ${where}`,
      );
    }
    const body = parsed.data;
    if (body.stream === true) {
      return sendError(
        reply,
        400,
        'invalid_request_error',
        'stream_unsupported',
        'Streaming is not supported yet (stream must be false).',
      );
    }
    const texts = [
      ...body.messages.map((m) => m.content),
      ...(body.stop === undefined ? [] : [body.stop].flat()),
    ];
    if (texts.some((t) => LONE_SURROGATE.test(t))) {
      return sendError(
        reply,
        400,
        'invalid_request_error',
        'invalid_text',
        'Text contains an unpaired UTF-16 surrogate.',
      );
    }
    let inlineBytes = 0;
    for (const m of body.messages) inlineBytes += encoder.encode(m.content).length;
    // JSON escaping can grow the text (control characters become \u00XX): the offer must still fit.
    const escapedBytes = encoder.encode(JSON.stringify(body.messages)).length;
    // SKELETON(S12): large inputs go through inputRef.
    if (inlineBytes > LIMITS.maxInlineTextBytes) {
      return sendError(
        reply,
        413,
        'invalid_request_error',
        'input_too_large',
        `Message text exceeds ${String(LIMITS.maxInlineTextBytes)} bytes.`,
      );
    }
    const maxEscaped = LIMITS.maxMessageBytes - OFFER_OVERHEAD_BYTES;
    if (escapedBytes > maxEscaped) {
      return sendError(
        reply,
        413,
        'invalid_request_error',
        'input_too_large',
        `After JSON escaping, the messages exceed ${String(maxEscaped)} bytes.`,
      );
    }
    const req: ChatRequest = {
      model: body.model,
      messages: body.messages,
      maxTokens: body.max_completion_tokens ?? body.max_tokens ?? 256,
      // The one place real numbers become protocol integers (ADR 0017).
      temperatureMilli: Math.round((body.temperature ?? 0.7) * 1000),
      topPMilli: Math.max(1, Math.round((body.top_p ?? 1) * 1000)),
      stop: body.stop === undefined ? [] : typeof body.stop === 'string' ? [body.stop] : body.stop,
    };
    // The buyer may hang up at any time, even while the job is being created: cancel then (the hold is
    // released unless the job already completed).
    const hangup: { gone: boolean; jobId: string | undefined } = { gone: false, jobId: undefined };
    const cancel = (id: string): void => {
      void deps.scheduler.cancel(id).catch((err: unknown) => {
        request.log.error({ err: safeErrorText(err) }, 'cancel failed');
      });
    };
    reply.raw.once('close', () => {
      if (reply.raw.writableEnded) return;
      hangup.gone = true;
      if (hangup.jobId !== undefined) cancel(hangup.jobId);
    });
    let submitted: Awaited<ReturnType<Scheduler['submit']>>;
    try {
      submitted = await deps.scheduler.submit(deps.devBuyerId, req);
    } catch (err) {
      if (err instanceof ModelNotFoundError) {
        return sendError(
          reply,
          404,
          'invalid_request_error',
          'model_not_found',
          `The model ${body.model} does not exist or no node has offered it yet.`,
        );
      }
      if (err instanceof InsufficientCreditError) {
        return sendError(
          reply,
          402,
          'insufficient_quota',
          'insufficient_credit',
          'Not enough credit for this request.',
        );
      }
      request.log.error({ err: safeErrorText(err) }, 'submit failed');
      return sendError(reply, 500, 'server_error', 'internal_error', 'Internal error.');
    }
    hangup.jobId = submitted.jobId;
    if (hangup.gone) cancel(submitted.jobId);
    const outcome = await submitted.outcome;
    if (outcome.status !== 'completed') return outcomeError(reply, outcome);
    return reply.code(200).send({
      id: `chatcmpl-${outcome.jobId}`,
      object: 'chat.completion',
      created: Math.floor(deps.clock.now().getTime() / 1000),
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: outcome.text },
          finish_reason: outcome.finishReason,
        },
      ],
      usage: {
        prompt_tokens: outcome.tokensIn,
        completion_tokens: outcome.tokensOut,
        total_tokens: outcome.tokensIn + outcome.tokensOut,
      },
    });
  });
}

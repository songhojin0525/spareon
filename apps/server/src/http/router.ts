/**
 * The only way to register an HTTP route for people or buyers. Every route names an action of the
 * permission table (http/permissions.ts); the wrapper authenticates, applies the table, checks CSRF
 * for cookie routes, validates input with zod and applies API key limits before the handler runs, so a
 * handler cannot forget any of it. Handlers of `own` cells add the ownership condition themselves (the
 * input says which scope applies).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { type ApiKeyDeps, type ApiKeyPrincipal, authenticateApiKey } from '../api-keys/api-keys.js';
import { type ActiveSession, lookupSession, type SessionConfig } from '../auth/sessions.js';
import type { ServerEnv } from '../config.js';
import type { Db } from '../db/client.js';
import type { UserRole } from '../db/schema/index.js';
import type { Clock } from '../lib/clock.js';
import { constantTimeEqual, hmacSha256, ipHashHex } from '../lib/crypto.js';
import {
  AppError,
  forbidden,
  invalidRequest,
  tooManyRequests,
  unauthenticated,
} from '../lib/errors.js';
import type { Ids } from '../lib/ids.js';
import type { ConcurrencyLimiter, RateLimiter } from '../lib/rate-limit.js';
import type { SettingsStore } from '../lib/settings.js';
import { type CookieNames, parseCookies, serializeCookie } from './cookies.js';
import { type Action, PERMISSIONS } from './permissions.js';

export interface HttpContext {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly env: ServerEnv;
  readonly limiter: RateLimiter;
  readonly concurrency: ConcurrencyLimiter;
  readonly settings: SettingsStore;
  readonly session: SessionConfig;
  readonly cookies: CookieNames;
  readonly secureCookies: boolean;
  /** Subkey of SESSION_SECRET for session-bound CSRF tokens. */
  readonly csrfKey: Buffer;
  /** Subkey of SESSION_SECRET for client IP hashes. */
  readonly ipKey: Buffer;
  readonly apiKeys: ApiKeyDeps;
}

export type Principal =
  | { readonly role: 'anonymous'; readonly via: 'none' }
  | {
      readonly role: UserRole;
      readonly via: 'session';
      readonly userId: string;
      readonly session: ActiveSession;
      readonly sessionToken: string;
    }
  | {
      readonly role: 'buyer';
      readonly via: 'api_key';
      readonly userId: string;
      readonly apiKey: ApiKeyPrincipal;
    };

const ANONYMOUS: Principal = { role: 'anonymous', via: 'none' };

export interface RouteInput<P, Q, B> {
  readonly req: FastifyRequest;
  readonly reply: FastifyReply;
  readonly principal: Principal;
  /** `own`: restrict to the principal's resources. `allow`: no ownership restriction. */
  readonly scope: 'allow' | 'own';
  readonly params: P;
  readonly query: Q;
  readonly body: B;
  /** HMAC of the client IP (hex) for audit and session rows. */
  readonly ipHash: () => string;
}

type Schema = z.ZodType;
type Out<S> = S extends z.ZodType ? z.output<S> : undefined;

export interface RouteDef<
  P extends Schema | undefined = undefined,
  Q extends Schema | undefined = undefined,
  B extends Schema | undefined = undefined,
> {
  readonly action: Action;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly params?: P;
  readonly query?: Q;
  readonly body?: B;
  /** Success response body (OpenAPI only; handlers are trusted to match). */
  readonly response?: Schema;
  readonly successStatus?: number;
  /** Public routes: resolve the login session anyway (CSRF token, login, signup refusal). */
  readonly usesSession?: boolean;
  /** API key routes: the scope the key must carry. */
  readonly apiKeyScope?: string;
  /** Error codes this route may answer with besides the common ones (OpenAPI documentation). */
  readonly errors?: readonly number[];
  handler(input: RouteInput<Out<P>, Out<Q>, Out<B>>): Promise<unknown>;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function csrfTokenForSession(csrfKey: Buffer, session: ActiveSession): string {
  return hmacSha256(csrfKey, session.tokenHash).toString('base64url');
}

export class Router {
  readonly defs: RouteDef<Schema | undefined, Schema | undefined, Schema | undefined>[] = [];

  constructor(
    private readonly app: FastifyInstance,
    readonly ctx: HttpContext,
  ) {}

  add<
    P extends Schema | undefined = undefined,
    Q extends Schema | undefined = undefined,
    B extends Schema | undefined = undefined,
  >(def: RouteDef<P, Q, B>): void {
    const row = PERMISSIONS[def.action];
    this.defs.push(def);
    const needsSession =
      row.auth === 'session' ||
      (row.auth === 'public' &&
        (def.usesSession === true || Object.values(row.access).some((a) => a !== 'allow')));
    this.app.route({
      method: row.method,
      url: row.path,
      handler: async (req, reply) => {
        const principal =
          row.auth === 'api_key'
            ? await this.#apiKeyPrincipal(req)
            : needsSession
              ? await this.sessionPrincipal(req)
              : ANONYMOUS;
        const access = row.access[principal.role];
        if (access === 'deny') {
          throw principal.role === 'anonymous' ? unauthenticatedFor(row.auth) : forbidden();
        }
        if (row.auth !== 'api_key' && UNSAFE.has(row.method)) this.#checkCsrf(req, principal);
        const params = parse(def.params, req.params, 'params');
        const query = parse(def.query, req.query, 'query');
        const body = parse(def.body, req.body, 'body');
        let release: (() => void) | undefined;
        if (principal.via === 'api_key') {
          if (def.apiKeyScope !== undefined && !principal.apiKey.scopes.includes(def.apiKeyScope)) {
            throw new AppError(
              'insufficient_scope',
              403,
              `This API key lacks the "${def.apiKeyScope}" scope.`,
            );
          }
          release = await this.#apiKeyLimits(principal.apiKey);
        }
        let ip: string | undefined;
        try {
          const result = await def.handler({
            req,
            reply,
            principal,
            scope: access,
            params: params as Out<P>,
            query: query as Out<Q>,
            body: body as Out<B>,
            ipHash: () => (ip ??= ipHashHex(this.ctx.ipKey, req.ip)),
          });
          if (reply.sent) return await reply;
          return await reply.code(def.successStatus ?? 200).send(result);
        } finally {
          release?.();
        }
      },
    });
  }

  /** The login session behind the request's cookie, or anonymous. */
  async sessionPrincipal(req: FastifyRequest): Promise<Principal> {
    const token = parseCookies(req.headers.cookie).get(this.ctx.cookies.session);
    const { clock, ids, session: config } = this.ctx;
    const session = await lookupSession(this.ctx.db, { clock, ids, config }, token);
    if (session === undefined || token === undefined) return ANONYMOUS;
    return {
      role: session.role,
      via: 'session',
      userId: session.userId,
      session,
      sessionToken: token,
    };
  }

  async #apiKeyPrincipal(req: FastifyRequest): Promise<Principal> {
    const key = await authenticateApiKey(this.ctx.db, this.ctx.apiKeys, req.headers.authorization);
    if (key === undefined) return ANONYMOUS;
    return { role: 'buyer', via: 'api_key', userId: key.userId, apiKey: key };
  }

  /**
   * Concurrent requests and requests per minute, per API key and per buyer (all keys together), so
   * many keys cannot multiply a buyer's budget (THREAT_MODEL BUY-01, BUY-08). Concurrency is checked
   * first: a request refused for concurrency does not spend the per-minute budget.
   */
  async #apiKeyLimits(key: ApiKeyPrincipal): Promise<() => void> {
    const { settings, concurrency, limiter } = this.ctx;
    const keyMax = await settings.get('api_keys.default_concurrency');
    const buyerMax = await settings.get('buyers.concurrency');
    const releaseKey = concurrency.tryAcquire(`key:${key.apiKeyId}`, keyMax);
    if (releaseKey === undefined) {
      throw tooManyRequests(
        'concurrency_limited',
        `At most ${String(keyMax)} concurrent requests per API key.`,
        1_000,
      );
    }
    const releaseBuyer = concurrency.tryAcquire(`buyer:${key.userId}`, buyerMax);
    if (releaseBuyer === undefined) {
      releaseKey();
      throw tooManyRequests(
        'concurrency_limited',
        `At most ${String(buyerMax)} concurrent requests per buyer (all API keys together).`,
        1_000,
      );
    }
    const release = (): void => {
      releaseKey();
      releaseBuyer();
    };
    try {
      const keyRpm = key.rateLimitRpm ?? (await settings.get('api_keys.default_rpm'));
      const k = await limiter.hit(`api_key:rpm:${key.apiKeyId}`, {
        limit: keyRpm,
        windowMs: 60_000,
      });
      if (!k.allowed) {
        throw tooManyRequests(
          'rate_limited',
          `Rate limit of ${String(keyRpm)} requests per minute exceeded for this API key.`,
          k.retryAfterMs,
        );
      }
      const buyerRpm = await settings.get('buyers.rpm');
      const u = await limiter.hit(`buyer:rpm:${key.userId}`, { limit: buyerRpm, windowMs: 60_000 });
      if (!u.allowed) {
        throw tooManyRequests(
          'rate_limited',
          `Rate limit of ${String(buyerRpm)} requests per minute exceeded for this buyer (all API keys).`,
          u.retryAfterMs,
        );
      }
    } catch (err) {
      release();
      throw err;
    }
    return release;
  }

  /**
   * Cookie routes that change state: the request must come from WEB_ORIGIN (Origin, else Referer) and
   * carry the CSRF cookie value in x-csrf-token (double submit). With a session, the token must also
   * be the one bound to that session, so a cookie planted by another site cannot stand in for it.
   */
  #checkCsrf(req: FastifyRequest, principal: Principal): void {
    const fail = (): never => {
      throw new AppError('csrf_failed', 403, 'Cross-site request refused (CSRF check failed).');
    };
    const origin = req.headers.origin;
    let from: string | undefined;
    if (typeof origin === 'string' && origin !== 'null') from = origin;
    else if (typeof req.headers.referer === 'string') {
      try {
        from = new URL(req.headers.referer).origin;
      } catch {
        fail();
      }
    }
    if (from !== this.ctx.env.WEB_ORIGIN) fail();
    const header = req.headers['x-csrf-token'];
    const cookie = parseCookies(req.headers.cookie).get(this.ctx.cookies.csrf);
    if (typeof header !== 'string' || cookie === undefined || header.length === 0) return fail();
    if (!constantTimeEqual(header, cookie)) fail();
    if (principal.via === 'session') {
      const expected = csrfTokenForSession(this.ctx.csrfKey, principal.session);
      if (!constantTimeEqual(header, expected)) fail();
    }
  }

  // ------------------------------------------------------------- cookies

  setSessionCookies(reply: FastifyReply, token: string, csrfToken: string): void {
    const maxAgeS = Math.floor(this.ctx.session.absoluteMs / 1000);
    reply.header('set-cookie', [
      serializeCookie(this.ctx.cookies.session, token, {
        httpOnly: true,
        secure: this.ctx.secureCookies,
        maxAgeS,
      }),
      serializeCookie(this.ctx.cookies.csrf, csrfToken, {
        httpOnly: false,
        secure: this.ctx.secureCookies,
        maxAgeS,
      }),
    ]);
  }

  setCsrfCookie(reply: FastifyReply, csrfToken: string): void {
    reply.header(
      'set-cookie',
      serializeCookie(this.ctx.cookies.csrf, csrfToken, {
        httpOnly: false,
        secure: this.ctx.secureCookies,
        maxAgeS: Math.floor(this.ctx.session.absoluteMs / 1000),
      }),
    );
  }

  clearSessionCookies(reply: FastifyReply): void {
    const opts = { secure: this.ctx.secureCookies, maxAgeS: 0 };
    reply.header('set-cookie', [
      serializeCookie(this.ctx.cookies.session, '', { ...opts, httpOnly: true }),
      serializeCookie(this.ctx.cookies.csrf, '', { ...opts, httpOnly: false }),
    ]);
  }
}

/** 401 for a missing login, or (buyer API) the OpenAI-compatible invalid_api_key. */
function unauthenticatedFor(auth: string): AppError {
  return auth === 'api_key'
    ? new AppError('invalid_api_key', 401, 'Invalid API key.')
    : unauthenticated('Login required.');
}

function parse(schema: Schema | undefined, value: unknown, where: string): unknown {
  if (schema === undefined) return undefined;
  const r = schema.safeParse(value ?? (where === 'body' ? undefined : {}));
  if (!r.success) throw invalidRequest(r.error.issues, where);
  return r.data;
}

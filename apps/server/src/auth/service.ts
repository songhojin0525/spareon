/**
 * Login and signup rules (THREAT_MODEL WEB-01, WEB-05, WEB-07):
 * - one failure message for every reason; unknown, disabled and seed accounts still run one argon2
 *   verification (dummy hash), and every failure answers no sooner than `minFailureMs`;
 * - failed logins are limited per account (any email, existing or not, so the lock reveals nothing)
 *   and attempts per IP; a success clears the account's failures;
 * - a login always creates a new session token and revokes the one the browser presented (fixation);
 * - signup answers the same whether or not the email exists and never logs in.
 */
import { setTimeout as sleepMs } from 'node:timers/promises';

import { type AuditActor, type AuditDeps, recordAudit } from '../audit/audit.js';
import { type Db, withTransaction } from '../db/client.js';
import type { UserRole } from '../db/schema/index.js';
import type { RateLimiter, RateRule } from '../lib/rate-limit.js';
import {
  checkPasswordPolicy,
  hashPassword,
  verifyAgainstDummy,
  verifyPassword,
} from './password.js';
import {
  type ActiveSession,
  createSession,
  revokeSessionByToken,
  type SessionConfig,
} from './sessions.js';
import {
  createUser,
  CURRENT_TERMS_VERSION,
  EmailTakenError,
  findUserByEmail,
  normalizeEmail,
} from './users.js';

export interface AuthConfig {
  /** Every failed login or signup answers no sooner than this (uniform timing). */
  readonly minFailureMs: number;
  readonly loginAccountRule: RateRule;
  readonly loginIpRule: RateRule;
  readonly signupIpRule: RateRule;
}

export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  minFailureMs: 400,
  loginAccountRule: { limit: 5, windowMs: 15 * 60_000 },
  loginIpRule: { limit: 30, windowMs: 15 * 60_000 },
  signupIpRule: { limit: 10, windowMs: 60 * 60_000 },
};

export interface AuthDeps extends AuditDeps {
  readonly db: Db;
  readonly limiter: RateLimiter;
  readonly session: SessionConfig;
  readonly config: AuthConfig;
  /** Where background failures (an audit write after the answer) are reported. */
  readonly log?: { error(obj: object, msg: string): void };
}

export interface PublicUser {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  readonly displayName: string;
}

export type LoginResult =
  | {
      readonly kind: 'ok';
      readonly token: string;
      readonly session: ActiveSession;
      readonly user: PublicUser;
    }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'limited'; readonly retryAfterMs: number };

export type SignupResult =
  { readonly kind: 'accepted' } | { readonly kind: 'limited'; readonly retryAfterMs: number };

const accountKey = (email: string): string => `login:account:${normalizeEmail(email)}`;

export class AuthService {
  constructor(private readonly deps: AuthDeps) {}

  async #padFrom(start: number): Promise<void> {
    const left = this.deps.config.minFailureMs - (performance.now() - start);
    if (left > 0) await sleepMs(left);
  }

  async login(input: {
    email: string;
    password: string;
    ipHash: string;
    presentedToken: string | undefined;
  }): Promise<LoginResult> {
    const start = performance.now();
    const { db, limiter, config } = this.deps;
    const ip = await limiter.hit(`login:ip:${input.ipHash}`, config.loginIpRule);
    // Every attempt counts before the password is checked, so parallel guesses cannot all slip past
    // the limit (a success clears the count).
    const account = await limiter.hit(accountKey(input.email), config.loginAccountRule);
    if (!ip.allowed || !account.allowed) {
      await this.#padFrom(start);
      return {
        kind: 'limited',
        retryAfterMs: Math.max(
          ip.allowed ? 0 : ip.retryAfterMs,
          account.allowed ? 0 : account.retryAfterMs,
        ),
      };
    }
    const user = await findUserByEmail(db, input.email);
    const usable = user?.disabledAt === null && user.passwordHash.startsWith('$argon2');
    const ok = usable
      ? await verifyPassword(user.passwordHash, input.password)
      : await verifyAgainstDummy(input.password);
    if (!ok || user === undefined) {
      await this.#padFrom(start);
      if (user !== undefined) {
        // Written after the answer is timed and not awaited: an existing account must not answer
        // later than an unknown one (WEB-07).
        void recordAudit(db, this.deps, {
          actor: { kind: 'system', via: 'web' },
          action: 'auth.login_failed',
          targetKind: 'user',
          targetId: user.id,
          data: { reason: user.disabledAt !== null ? 'disabled' : 'bad_credentials' },
          ipHash: input.ipHash,
        }).catch((err: unknown) => {
          this.deps.log?.error({ err }, 'audit of a failed login could not be written');
        });
      }
      return { kind: 'invalid' };
    }
    await limiter.reset(accountKey(input.email));
    const created = await withTransaction(db, async (tx) => {
      // Fixation: whatever session the browser brought is ended; the new token is server-made.
      await revokeSessionByToken(tx, this.deps, input.presentedToken);
      const s = await createSession(
        tx,
        { ...this.deps, config: this.deps.session },
        {
          userId: user.id,
          ipHash: Buffer.from(input.ipHash, 'hex'),
        },
      );
      await recordAudit(tx, this.deps, {
        actor: { kind: user.role, userId: user.id },
        action: 'auth.login',
        targetKind: 'session',
        targetId: s.session.sessionId,
        ipHash: input.ipHash,
      });
      return s;
    });
    return {
      kind: 'ok',
      token: created.token,
      session: created.session,
      user: { id: user.id, email: user.email, role: user.role, displayName: user.displayName },
    };
  }

  async logout(input: {
    userId: string;
    role: UserRole;
    token: string;
    ipHash: string;
  }): Promise<void> {
    await withTransaction(this.deps.db, async (tx) => {
      await revokeSessionByToken(tx, this.deps, input.token);
      const actor: AuditActor = { kind: input.role, userId: input.userId };
      await recordAudit(tx, this.deps, { actor, action: 'auth.logout', ipHash: input.ipHash });
    });
  }

  /**
   * Create an owner or buyer account. Throws PasswordPolicyError for a weak password (that answer
   * reveals nothing about existing accounts). The result is the same for new and existing emails.
   */
  async signup(input: {
    email: string;
    password: string;
    displayName: string;
    role: 'owner' | 'buyer';
    termsVersion: string;
    ipHash: string;
  }): Promise<SignupResult> {
    const start = performance.now();
    const { db, limiter, config } = this.deps;
    const ip = await limiter.hit(`signup:ip:${input.ipHash}`, config.signupIpRule);
    if (!ip.allowed) {
      await this.#padFrom(start);
      return { kind: 'limited', retryAfterMs: ip.retryAfterMs };
    }
    checkPasswordPolicy(input.password);
    if (input.termsVersion !== CURRENT_TERMS_VERSION) throw new TermsVersionError();
    const passwordHash = await hashPassword(input.password);
    try {
      await withTransaction(db, async (tx) => {
        const userId = await createUser(tx, this.deps, {
          email: input.email,
          role: input.role,
          displayName: input.displayName,
          passwordHash,
          termsVersion: input.termsVersion,
        });
        await recordAudit(tx, this.deps, {
          actor: { kind: input.role, userId },
          action: 'auth.signup',
          targetKind: 'user',
          targetId: userId,
          data: { role: input.role, termsVersion: input.termsVersion },
          ipHash: input.ipHash,
        });
      });
    } catch (err) {
      if (!(err instanceof EmailTakenError)) throw err;
      const existing = await findUserByEmail(db, input.email);
      await recordAudit(db, this.deps, {
        actor: { kind: 'system', via: 'web' },
        action: 'auth.signup_duplicate',
        targetKind: 'user',
        ...(existing === undefined ? {} : { targetId: existing.id }),
        ipHash: input.ipHash,
      });
    }
    await this.#padFrom(start);
    return { kind: 'accepted' };
  }
}

export class TermsVersionError extends Error {
  constructor() {
    super(`the current terms version is ${CURRENT_TERMS_VERSION}`);
    this.name = 'TermsVersionError';
  }
}

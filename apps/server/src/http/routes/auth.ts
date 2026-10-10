import { z } from 'zod';

import { PasswordPolicyError } from '../../auth/password.js';
import { type AuthService, TermsVersionError } from '../../auth/service.js';
import { findUserById } from '../../auth/users.js';
import { randomToken } from '../../lib/crypto.js';
import { AppError, badRequest, tooManyRequests } from '../../lib/errors.js';
import { parseCookies } from '../cookies.js';
import { csrfTokenForSession, type Router } from '../router.js';

const userSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: z.enum(['operator', 'owner', 'buyer']),
  displayName: z.string(),
});

const sessionResponse = z.object({
  user: userSchema,
  csrfToken: z.string(),
  expiresAt: z.iso.datetime(),
});

const INVALID_CREDENTIALS = 'Email or password is incorrect.';
const TOO_MANY = 'Too many attempts. Try again later.';

export function registerAuthRoutes(router: Router, auth: AuthService): void {
  const { ctx } = router;

  router.add({
    action: 'auth.csrf',
    summary: 'Get a CSRF token (also set as a cookie) for state-changing requests',
    tags: ['auth'],
    usesSession: true,
    response: z.object({ csrfToken: z.string() }),
    handler: ({ reply, principal }) => {
      const csrfToken =
        principal.via === 'session'
          ? csrfTokenForSession(ctx.csrfKey, principal.session)
          : randomToken(32);
      router.setCsrfCookie(reply, csrfToken);
      return Promise.resolve({ csrfToken });
    },
  });

  router.add({
    action: 'auth.signup',
    summary: 'Create an owner or buyer account (does not log in)',
    tags: ['auth'],
    successStatus: 202,
    errors: [400, 403, 429],
    body: z.object({
      email: z.string().trim().max(320).pipe(z.email()),
      password: z.string().min(1).max(1024),
      displayName: z.string().trim().min(1).max(100),
      role: z.enum(['owner', 'buyer']),
      termsVersion: z.string().min(1).max(32),
    }),
    response: z.object({ status: z.literal('accepted'), message: z.string() }),
    handler: async ({ body, ipHash }) => {
      if (!(await ctx.settings.get('auth.signup_enabled'))) {
        throw new AppError('signup_closed', 403, 'Sign-up is closed.');
      }
      try {
        const r = await auth.signup({ ...body, ipHash: ipHash() });
        if (r.kind === 'limited')
          throw tooManyRequests('too_many_attempts', TOO_MANY, r.retryAfterMs);
      } catch (err) {
        if (err instanceof PasswordPolicyError) throw badRequest('weak_password', err.message);
        if (err instanceof TermsVersionError)
          throw badRequest('terms_version_mismatch', err.message);
        throw err;
      }
      return {
        status: 'accepted' as const,
        message: 'If this email can be registered, the account was created. Log in to continue.',
      };
    },
  });

  router.add({
    action: 'auth.login',
    summary: 'Log in with email and password (sets the session and CSRF cookies)',
    tags: ['auth'],
    usesSession: true,
    errors: [401, 429],
    body: z.object({
      email: z.string().max(320),
      password: z.string().max(1024),
    }),
    response: sessionResponse,
    handler: async ({ req, reply, body, ipHash }) => {
      const r = await auth.login({
        email: body.email,
        password: body.password,
        ipHash: ipHash(),
        presentedToken: parseCookies(req.headers.cookie).get(ctx.cookies.session),
      });
      if (r.kind === 'limited')
        throw tooManyRequests('too_many_attempts', TOO_MANY, r.retryAfterMs);
      if (r.kind === 'invalid') throw new AppError('invalid_credentials', 401, INVALID_CREDENTIALS);
      const csrfToken = csrfTokenForSession(ctx.csrfKey, r.session);
      router.setSessionCookies(reply, r.token, csrfToken);
      return { user: r.user, csrfToken, expiresAt: r.session.expiresAt.toISOString() };
    },
  });

  router.add({
    action: 'auth.logout',
    summary: 'Log out (revokes the session, clears cookies)',
    tags: ['auth'],
    response: z.object({ status: z.literal('logged_out') }),
    handler: async ({ reply, principal, ipHash }) => {
      if (principal.via !== 'session') throw new Error('unreachable: session route');
      await auth.logout({
        userId: principal.userId,
        role: principal.role,
        token: principal.sessionToken,
        ipHash: ipHash(),
      });
      router.clearSessionCookies(reply);
      return { status: 'logged_out' as const };
    },
  });

  router.add({
    action: 'auth.session',
    summary: 'The logged-in user and the session CSRF token',
    tags: ['auth'],
    response: sessionResponse,
    handler: async ({ principal }) => {
      if (principal.via !== 'session') throw new Error('unreachable: session route');
      const user = await findUserById(ctx.db, principal.userId);
      if (user === undefined) throw new Error('session user vanished');
      return {
        user: { id: user.id, email: user.email, role: user.role, displayName: user.displayName },
        csrfToken: csrfTokenForSession(ctx.csrfKey, principal.session),
        expiresAt: principal.session.expiresAt.toISOString(),
      };
    },
  });
}

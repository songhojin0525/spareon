/**
 * Web login sessions. The cookie holds a random 32-byte token; the database holds only its SHA-256
 * (`sessions.token_hash`), so a database leak does not yield usable sessions. A session ends at the
 * first of: idle limit (last use + idle), absolute limit (`expires_at`), logout or revocation
 * (password reset, account disabled), or the user being disabled.
 */
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';

import type { Db, Tx } from '../db/client.js';
import { sessions, type UserRole, users } from '../db/schema/index.js';
import type { Clock } from '../lib/clock.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import type { Ids } from '../lib/ids.js';

export interface SessionConfig {
  readonly idleMs: number;
  readonly absoluteMs: number;
  /** last_seen_at is written at most this often (default 60 s): reads do not become writes. */
  readonly touchIntervalMs: number;
}

export interface SessionDeps {
  readonly clock: Clock;
  readonly ids: Ids;
  readonly config: SessionConfig;
}

export interface ActiveSession {
  readonly sessionId: string;
  readonly tokenHash: Buffer;
  readonly userId: string;
  readonly role: UserRole;
  readonly expiresAt: Date;
}

/** The token must look like ours before it is hashed and looked up (base64url, 32 bytes). */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function sessionTokenHash(token: string): Buffer {
  return sha256(`session\n${token}`);
}

export async function createSession(
  tx: Db | Tx,
  deps: SessionDeps,
  input: { userId: string; ipHash?: Buffer },
): Promise<{ token: string; session: ActiveSession }> {
  const now = deps.clock.now();
  const token = randomToken(32);
  const tokenHash = sessionTokenHash(token);
  const sessionId = deps.ids.newId();
  const expiresAt = new Date(now.getTime() + deps.config.absoluteMs);
  const [user] = await tx
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, input.userId));
  if (user === undefined) throw new Error('createSession: unknown user');
  await tx.insert(sessions).values({
    id: sessionId,
    userId: input.userId,
    tokenHash,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    ipHash: input.ipHash ?? null,
  });
  return {
    token,
    session: { sessionId, tokenHash, userId: input.userId, role: user.role, expiresAt },
  };
}

/** The live session for a cookie token, or undefined. Touches last_seen_at (throttled). */
export async function lookupSession(
  db: Db,
  deps: SessionDeps,
  token: string | undefined,
): Promise<ActiveSession | undefined> {
  if (token === undefined || !TOKEN_RE.test(token)) return undefined;
  const now = deps.clock.now();
  const tokenHash = sessionTokenHash(token);
  const idleCutoff = new Date(now.getTime() - deps.config.idleMs);
  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      role: users.role,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        gt(sessions.lastSeenAt, idleCutoff),
        isNull(users.disabledAt),
      ),
    );
  if (row === undefined) return undefined;
  if (now.getTime() - row.lastSeenAt.getTime() >= deps.config.touchIntervalMs) {
    await db
      .update(sessions)
      .set({ lastSeenAt: now })
      .where(and(eq(sessions.id, row.sessionId), isNull(sessions.revokedAt)));
  }
  return {
    sessionId: row.sessionId,
    tokenHash,
    userId: row.userId,
    role: row.role,
    expiresAt: row.expiresAt,
  };
}

/** Revoke the session behind a token (whatever its state). True when a live row was revoked. */
export async function revokeSessionByToken(
  db: Db | Tx,
  deps: Pick<SessionDeps, 'clock'>,
  token: string | undefined,
): Promise<boolean> {
  if (token === undefined || !TOKEN_RE.test(token)) return false;
  const rows = await db
    .update(sessions)
    .set({ revokedAt: deps.clock.now() })
    .where(and(eq(sessions.tokenHash, sessionTokenHash(token)), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/**
 * Delete sessions that can no longer be used: past the absolute limit, idle past the limit, or
 * revoked more than a day ago (kept briefly so a logout can be investigated). Returns the count.
 */
export async function purgeSessions(db: Db, deps: SessionDeps): Promise<number> {
  const now = deps.clock.now().getTime();
  const rows = await db
    .delete(sessions)
    .where(
      or(
        lt(sessions.expiresAt, new Date(now)),
        lt(sessions.lastSeenAt, new Date(now - deps.config.idleMs)),
        lt(sessions.revokedAt, new Date(now - 86_400_000)),
      ),
    )
    .returning({ id: sessions.id });
  return rows.length;
}

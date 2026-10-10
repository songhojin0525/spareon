import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Db, Tx } from '../db/client.js';
import { toDbError } from '../db/errors.js';
import { sessions, type UserRole, users } from '../db/schema/index.js';
import type { Clock } from '../lib/clock.js';
import type { Ids } from '../lib/ids.js';

/** The terms version a new account must accept. The wording itself is a draft until S23. */
export const CURRENT_TERMS_VERSION = '2026-10-draft';

export const emailSchema = z
  .string()
  .trim()
  .max(320)
  .pipe(z.email({ message: 'must be an email address' }));

/** Emails are case-insensitive (users_email_lower_key): stored and compared in lower case. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly disabledAt: Date | null;
}

export interface UserDeps {
  readonly clock: Clock;
  readonly ids: Ids;
}

export class EmailTakenError extends Error {
  constructor() {
    super('email already registered');
    this.name = 'EmailTakenError';
  }
}

const userColumns = {
  id: users.id,
  email: users.email,
  role: users.role,
  displayName: users.displayName,
  passwordHash: users.passwordHash,
  disabledAt: users.disabledAt,
};

export async function findUserByEmail(db: Db | Tx, email: string): Promise<UserRecord | undefined> {
  const [row] = await db
    .select(userColumns)
    .from(users)
    .where(eq(sql`lower(${users.email})`, normalizeEmail(email)));
  return row;
}

export async function findUserById(db: Db | Tx, id: string): Promise<UserRecord | undefined> {
  const [row] = await db.select(userColumns).from(users).where(eq(users.id, id));
  return row;
}

export interface NewUser {
  readonly email: string;
  readonly role: UserRole;
  readonly displayName: string;
  readonly passwordHash: string;
  /** Accepted terms version (signup); operators created by the CLI have none. */
  readonly termsVersion?: string;
}

/** Insert a user. Throws EmailTakenError when the email (any case) exists. */
export async function createUser(db: Db | Tx, deps: UserDeps, input: NewUser): Promise<string> {
  const now = deps.clock.now();
  const id = deps.ids.newId();
  try {
    await db.insert(users).values({
      id,
      email: normalizeEmail(input.email),
      passwordHash: input.passwordHash,
      role: input.role,
      displayName: input.displayName,
      termsVersion: input.termsVersion ?? null,
      termsAcceptedAt: input.termsVersion === undefined ? null : now,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    const e = toDbError(err);
    if (e.sqlState === '23505') throw new EmailTakenError();
    throw err;
  }
  return id;
}

/** Disable a user and revoke every session (API keys stop working: lookups check disabled_at). */
export async function disableUser(tx: Tx, deps: UserDeps, userId: string): Promise<boolean> {
  const now = deps.clock.now();
  const changed = await tx
    .update(users)
    .set({ disabledAt: now, updatedAt: now })
    .where(and(eq(users.id, userId), isNull(users.disabledAt)))
    .returning({ id: users.id });
  await revokeUserSessions(tx, deps, userId);
  return changed.length > 0;
}

/** Replace the password hash and revoke every session (a reset logs the user out everywhere). */
export async function setPasswordHash(
  tx: Tx,
  deps: UserDeps,
  userId: string,
  passwordHash: string,
): Promise<void> {
  const now = deps.clock.now();
  await tx.update(users).set({ passwordHash, updatedAt: now }).where(eq(users.id, userId));
  await revokeUserSessions(tx, deps, userId);
}

export async function revokeUserSessions(
  db: Db | Tx,
  deps: UserDeps,
  userId: string,
): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: deps.clock.now() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

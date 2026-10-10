/**
 * Password hashing: argon2id with the OWASP Password Storage Cheat Sheet minimum configuration
 * (m = 19 MiB, t = 2, p = 1; checked 2026-10-10). About 30 ms per hash on a desktop CPU, 19 MiB each:
 * login concurrency is bounded by the login rate limits.
 */
import { hash, type Options, verify } from '@node-rs/argon2';

/** algorithm 2 = Argon2id (the package's const enum cannot be imported under verbatimModuleSyntax). */
export const ARGON2_PARAMS = {
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;
const OPTIONS = ARGON2_PARAMS as unknown as Options;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

/** Stored for accounts that cannot log in (development seed users). Never a valid argon2 hash. */
export const UNUSABLE_PASSWORD_HASH = '!unusable';

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordPolicyError';
  }
}

/** Length is the rule (NIST SP 800-63B): 12..256 characters, no composition rules. */
export function checkPasswordPolicy(password: string): void {
  // Code points, not UTF-16 units: a password of 12 emoji is 12 characters.
  const n = Array.from(password).length;
  if (n < PASSWORD_MIN)
    throw new PasswordPolicyError(`password must be at least ${String(PASSWORD_MIN)} characters`);
  if (n > PASSWORD_MAX)
    throw new PasswordPolicyError(`password must be at most ${String(PASSWORD_MAX)} characters`);
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

/** False for a wrong password and for unusable or malformed stored hashes (never throws). */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  if (!stored.startsWith('$argon2')) return false;
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;

/**
 * Burn the same work as a real verification when there is no usable hash (unknown email, disabled or
 * seed account), so response time does not reveal whether an account exists (WEB-07).
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummy ??= hashPassword('spareon-dummy-password-for-timing');
  await verify(await dummy, password).catch(() => false);
  return false;
}

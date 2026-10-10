/**
 * Audit trail of sensitive actions (append-only `audit_log`, UPDATE/DELETE rejected by the database).
 * Record inside the same transaction as the action, so both commit or neither does.
 * `data` is metadata only: never passwords, API keys (the public prefix is fine), prompts or outputs.
 */
import { desc, lt } from 'drizzle-orm';

import type { Db, Tx } from '../db/client.js';
import { auditLog } from '../db/schema/index.js';
import type { Clock } from '../lib/clock.js';
import type { Ids } from '../lib/ids.js';

export type AuditActor =
  | { readonly kind: 'operator' | 'owner' | 'buyer'; readonly userId: string }
  | { readonly kind: 'system'; readonly via: string };

export interface AuditEntry {
  readonly actor: AuditActor;
  /** Dotted lowercase action, e.g. `auth.login`, `api_key.create`, `settings.set`. */
  readonly action: string;
  readonly targetKind?: string;
  readonly targetId?: string;
  readonly data?: Readonly<Record<string, unknown>>;
  /** HMAC of the client IP (hex), never the IP itself. */
  readonly ipHash?: string;
}

export interface AuditDeps {
  readonly clock: Clock;
  readonly ids: Ids;
}

/** Keys that must never appear in audit data (defence in depth against a careless caller). */
const FORBIDDEN_DATA_KEYS =
  /^(password|newPassword|secret|token|apiKey|key|messages|prompt|input|output|choices)$/i;

export class AuditDataError extends Error {
  constructor(key: string) {
    super(`audit data must not contain "${key}"`);
    this.name = 'AuditDataError';
  }
}

function checkData(data: Readonly<Record<string, unknown>>): void {
  for (const k of Object.keys(data)) if (FORBIDDEN_DATA_KEYS.test(k)) throw new AuditDataError(k);
}

export async function recordAudit(
  db: Db | Tx,
  deps: AuditDeps,
  entry: AuditEntry,
): Promise<string> {
  const data = { ...entry.data };
  if (entry.actor.kind === 'system') data['via'] = entry.actor.via;
  checkData(data);
  const id = deps.ids.newId();
  await db.insert(auditLog).values({
    id,
    at: deps.clock.now(),
    actorUserId: entry.actor.kind === 'system' ? null : entry.actor.userId,
    actorKind: entry.actor.kind,
    action: entry.action,
    targetKind: entry.targetKind ?? null,
    targetId: entry.targetId ?? null,
    data,
    ipHash: entry.ipHash ?? null,
  });
  return id;
}

export interface AuditRow {
  readonly id: string;
  readonly at: Date;
  readonly actorKind: string;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly targetKind: string | null;
  readonly targetId: string | null;
  readonly data: unknown;
}

/** Newest first; `before` (an audit id, UUIDv7 = time ordered) pages backwards. */
export async function listAudit(
  db: Db,
  options: { limit: number; before?: string },
): Promise<AuditRow[]> {
  const q = db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      actorKind: auditLog.actorKind,
      actorUserId: auditLog.actorUserId,
      action: auditLog.action,
      targetKind: auditLog.targetKind,
      targetId: auditLog.targetId,
      data: auditLog.data,
    })
    .from(auditLog);
  const filtered = options.before === undefined ? q : q.where(lt(auditLog.id, options.before));
  return filtered.orderBy(desc(auditLog.id)).limit(options.limit);
}

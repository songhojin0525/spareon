/**
 * Buyer output kept for an idempotent replay (ADR 0010: conversational output at most 24 h after
 * delivery, AES-256-GCM, deleted by the retention sweep). Stored only when the buyer sent an
 * Idempotency-Key; otherwise output is never written to the database.
 *
 * SKELETON(S12): the retention module (key rotation, `x-spareon-retention: none`) replaces this.
 */
import { and, eq, gt } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { jobPayloads } from '../db/schema/index.js';
import type { Clock } from '../lib/clock.js';
import type { Ids } from '../lib/ids.js';
import { payloadAad, type PayloadCipher } from '../lib/payload-cipher.js';

export interface PayloadDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly cipher: PayloadCipher;
}

export async function storeOutput(
  deps: PayloadDeps,
  jobId: string,
  text: string,
  retentionMs: number,
): Promise<void> {
  const now = deps.clock.now();
  const plain = Buffer.from(text, 'utf8');
  await deps.db
    .insert(jobPayloads)
    .values({
      id: deps.ids.newId(),
      jobId,
      kind: 'output',
      ciphertext: deps.cipher.seal(plain, payloadAad(jobId, 'output')),
      keyId: deps.cipher.keyId,
      plaintextBytes: plain.length,
      expiresAt: new Date(now.getTime() + retentionMs),
      createdAt: now,
    })
    .onConflictDoNothing();
}

/** The stored output, or undefined when it was never stored or its retention ended. */
export async function readOutput(deps: PayloadDeps, jobId: string): Promise<string | undefined> {
  const [row] = await deps.db
    .select({ ciphertext: jobPayloads.ciphertext, keyId: jobPayloads.keyId })
    .from(jobPayloads)
    .where(
      and(
        eq(jobPayloads.jobId, jobId),
        eq(jobPayloads.kind, 'output'),
        gt(jobPayloads.expiresAt, deps.clock.now()),
      ),
    );
  if (row?.keyId !== deps.cipher.keyId) return undefined;
  return deps.cipher.open(row.ciphertext, payloadAad(jobId, 'output')).toString('utf8');
}

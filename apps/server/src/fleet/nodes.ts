/**
 * Node rows for the walking skeleton.
 *
 * SKELETON(S10): nodes appear on first authenticated connection in the development store and their state
 * is set directly; enrollment, the node state machine with guarded transitions (ARCHITECTURE 5.1),
 * presence intervals and kill switches replace this.
 */
import { and, eq, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { nodes, type NodeState } from '../db/schema/index.js';
import type { Clock } from '../lib/clock.js';

/** Dashboard label of a node; the agent prints the same label so the founder can match them. */
export function devNodeLabel(nodeId: string): string {
  return `PC-${nodeId.slice(-6)}`;
}

export interface DevNodeInput {
  readonly nodeId: string;
  readonly storeId: string;
  readonly publicKey: string;
  readonly fpStore: string;
  readonly fpGlobal: string;
  readonly agentVersion: string;
}

/** States in which a node must not work even with valid credentials. */
const BLOCKED_STATES: readonly NodeState[] = ['pending', 'disabled', 'quarantined', 'excluded'];

/**
 * Create the node on first contact or refresh its identity fields. Returns the node's state so the
 * gateway can refuse blocked nodes (auth.fail).
 */
export async function upsertDevNode(
  db: Db,
  clock: Clock,
  input: DevNodeInput,
): Promise<{ state: NodeState; blocked: boolean }> {
  const now = clock.now();
  const [row] = await db
    .insert(nodes)
    .values({
      id: input.nodeId,
      storeId: input.storeId,
      displayName: devNodeLabel(input.nodeId),
      devicePubkey: input.publicKey,
      fpStore: input.fpStore,
      fpGlobal: input.fpGlobal,
      state: 'offline',
      eligible: false,
      stateChangedAt: now,
      lastSeenAt: now,
      agentVersion: input.agentVersion,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: nodes.id,
      set: {
        devicePubkey: input.publicKey,
        fpStore: input.fpStore,
        fpGlobal: input.fpGlobal,
        agentVersion: input.agentVersion,
        lastSeenAt: now,
        updatedAt: now,
      },
    })
    .returning({ state: nodes.state });
  const state = row?.state ?? 'offline';
  return { state, blocked: BLOCKED_STATES.includes(state) };
}

export interface NodeStatusUpdate {
  readonly state: Extract<NodeState, 'offline' | 'idle' | 'customer' | 'running' | 'paused'>;
  readonly eligible: boolean;
  readonly ineligibleReason?: string | null;
}

/** Set state/eligibility (only for nodes that are not blocked). state_changed_at moves only on change. */
export async function setNodeStatus(
  db: Db,
  clock: Clock,
  nodeId: string,
  update: NodeStatusUpdate,
): Promise<void> {
  const now = clock.now();
  await db
    .update(nodes)
    .set({
      state: update.state,
      eligible: update.eligible,
      ineligibleReason: update.eligible ? null : (update.ineligibleReason ?? null),
      stateChangedAt: sql`CASE WHEN ${nodes.state} = ${update.state} THEN ${nodes.stateChangedAt} ELSE ${now} END`,
      lastSeenAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(nodes.id, nodeId),
        sql`${nodes.state} NOT IN ('pending', 'disabled', 'quarantined', 'excluded')`,
      ),
    );
}

/** Record runtime facts from capabilities (metadata only). */
export async function setNodeCapabilities(
  db: Db,
  clock: Clock,
  nodeId: string,
  facts: { runtimeVersion: string; osBuild: string; gpuSummary: unknown },
): Promise<void> {
  const now = clock.now();
  await db
    .update(nodes)
    .set({
      runtimeVersion: facts.runtimeVersion,
      osBuild: facts.osBuild,
      gpuSummary: facts.gpuSummary,
      updatedAt: now,
    })
    .where(eq(nodes.id, nodeId));
}

export async function touchNode(db: Db, clock: Clock, nodeId: string): Promise<void> {
  await db.update(nodes).set({ lastSeenAt: clock.now() }).where(eq(nodes.id, nodeId));
}

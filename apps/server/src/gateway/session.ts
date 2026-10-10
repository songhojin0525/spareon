import type {
  JobCompletePayload,
  JobFailPayload,
  JobPreemptedPayload,
  JobRejectPayload,
  MessageType,
  PayloadOf,
  ServerMessageType,
} from '@binjari/protocol';

export type SendResult = 'sent' | 'closed' | 'invalid';

/** One authenticated agent connection, as the scheduler sees it. */
export interface AgentSession {
  readonly sessionId: string;
  readonly nodeId: string;
  readonly storeId: string;
  /** Monotonic connection order: "first waiting node" means lowest order (S04 matching; S12 replaces it). */
  readonly order: number;
  /** Models the agent reported in capabilities: protocol model id → sha256. */
  models: ReadonlyMap<string, string>;
  /** Last status said: no customer, eligible, not paused. Unknown (no status yet) counts as false. */
  eligible: boolean;
  /** The attempt this node is busy with (one job per node, maxConcurrentJobs default 1). */
  busyAttemptId: string | null;
  /** Attempts offered through this connection that may still be active (lost when it closes). */
  readonly attemptIds: Set<string>;
  readonly closed: boolean;
  /**
   * Encode (schema-checked) and send. 'closed': the connection is gone. 'invalid': the message breaks the
   * protocol (nothing was sent; for a job.offer this means the job's input cannot be delivered at all).
   */
  send<T extends ServerMessageType>(type: T, payload: PayloadOf<T>, corr?: string): SendResult;
  close(code: number, reason: string): void;
}

/**
 * Port the gateway calls for job traffic and connection lifecycle (ARCHITECTURE 2.2 `AgentJobSink`,
 * implemented by the scheduler and wired by the composition root).
 */
export interface AgentJobSink {
  onSessionReady(session: AgentSession): Promise<void>;
  onSessionStatus(session: AgentSession): Promise<void>;
  onSessionClosed(session: AgentSession): Promise<void>;
  onJobAccept(session: AgentSession, attemptId: string): Promise<void>;
  onJobReject(session: AgentSession, payload: JobRejectPayload): Promise<void>;
  onJobProgress(session: AgentSession, attemptId: string): Promise<void>;
  onJobComplete(session: AgentSession, payload: JobCompletePayload): Promise<void>;
  onJobFail(session: AgentSession, payload: JobFailPayload): Promise<void>;
  onJobPreempted(session: AgentSession, payload: JobPreemptedPayload): Promise<void>;
}

/** Live sessions by node. SKELETON(S11): one server instance; no cross-instance fan-out or resume. */
export class SessionRegistry {
  readonly #byNode = new Map<string, AgentSession>();

  /** Register a session; returns the session it replaced (same node connected again), if any. */
  add(session: AgentSession): AgentSession | undefined {
    const previous = this.#byNode.get(session.nodeId);
    this.#byNode.set(session.nodeId, session);
    return previous;
  }

  /** Remove only if `session` is still the node's current session. */
  remove(session: AgentSession): boolean {
    if (this.#byNode.get(session.nodeId) !== session) return false;
    this.#byNode.delete(session.nodeId);
    return true;
  }

  get(nodeId: string): AgentSession | undefined {
    return this.#byNode.get(nodeId);
  }

  isCurrent(session: AgentSession): boolean {
    return this.#byNode.get(session.nodeId) === session;
  }

  /** Sessions in connection order. */
  list(): AgentSession[] {
    return [...this.#byNode.values()].sort((a, b) => a.order - b.order);
  }
}

export type { MessageType };

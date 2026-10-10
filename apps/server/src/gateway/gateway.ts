/**
 * Agent WebSocket gateway for the walking skeleton: S02 messages decoded and encoded with the shared
 * codec, the real hello → auth.challenge → auth.prove → auth.ok handshake, then job traffic handed to the
 * scheduler (AgentJobSink).
 *
 * SKELETON(S11): device keys are derived from DEV_AGENT_SECRET (no enrollment lookup), there is no
 * session resume window (a closed connection loses its attempts at once), command acks are not tracked
 * or retried, and there is one server instance.
 */
import { randomBytes } from 'node:crypto';

import {
  authSigningBytes,
  defaultCodec,
  devNodePublicKey,
  type ErrorCode,
  isSupportedProtocolHash,
  makeMessage,
  type PayloadOf,
  type ProtocolMessage,
  type ServerMessageType,
  verifyEd25519,
} from '@binjari/protocol';
import { formatTimestamp } from '@binjari/shared';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

import type { Db } from '../db/client.js';
import { setNodeCapabilities, setNodeStatus, touchNode, upsertDevNode } from '../fleet/nodes.js';
import type { Clock } from '../lib/clock.js';
import type { Ids } from '../lib/ids.js';
import { safeErrorText } from '../lib/safe-error.js';
import type { AgentJobSink, AgentSession, SendResult, SessionRegistry } from './session.js';

export const AGENT_WS_PATH = '/agent/v1/ws';

export interface GatewayConfig {
  /** T14: hello → auth.ok must finish in this time; the nonce lives as long. */
  readonly authTimeoutMs: number;
  /** T10: close a connection that sent nothing for this long. */
  readonly idleTimeoutMs: number;
  /** T9: heartbeat interval announced in auth.ok. */
  readonly heartbeatIntervalMs: number;
  /** Rejected messages tolerated per connection before it is closed. */
  // SKELETON(S11): a per-connection count, not PROTOCOL's per-minute rate limit.
  readonly maxRejectedMessages: number;
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  authTimeoutMs: 5_000,
  idleTimeoutMs: 10_000,
  heartbeatIntervalMs: 5_000,
  maxRejectedMessages: 5,
};

export interface GatewayDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly sessions: SessionRegistry;
  readonly sink: AgentJobSink;
  /** The development store new nodes join (a stand-in until S10 enrollment). */
  readonly storeId: string;
  /** Undefined: no agent can authenticate (production until S10/S11). */
  readonly devAgentSecret: string | undefined;
  /** Called for every model an agent reports (development auto-registration until the S09 registry). */
  readonly onModelSeen: (modelId: string) => Promise<void>;
  readonly log: FastifyBaseLogger;
  readonly config: GatewayConfig;
}

const WS_POLICY_VIOLATION = 1008;
const WS_TOO_BIG = 1009;
const WS_INTERNAL = 1011;
const WS_GOING_AWAY = 1001;
/**
 * After a close frame, wait this long for the peer's reply, then drop the TCP connection. A peer that
 * stopped answering (pulled cable) would otherwise keep the socket for ws's 30-second close timeout.
 */
const CLOSE_GRACE_MS = 1_000;

let connectionOrder = 0;

export function registerGateway(app: FastifyInstance, deps: GatewayDeps): void {
  app.get(AGENT_WS_PATH, { websocket: true }, (socket) => {
    handleConnection(socket, deps);
  });
}

type Phase = 'hello' | 'prove' | 'ready' | 'closed';

function handleConnection(socket: WebSocket, deps: GatewayDeps): void {
  const codec = defaultCodec();
  const { clock, ids, log, config } = deps;
  let phase: Phase = 'hello';
  let rejected = 0;
  let queue: Promise<void> = Promise.resolve();
  let session: (AgentSession & { closed: boolean }) | undefined;
  let hello: PayloadOf<'hello'> | undefined;
  let challenge: { id: string; nonce: string; at: number } | undefined;

  const encode = <T extends ServerMessageType>(
    type: T,
    payload: PayloadOf<T>,
    corr?: string,
  ): string => {
    const msg = makeMessage(type, payload, {
      id: ids.newId(),
      ts: formatTimestamp(clock.now()),
      ...(corr === undefined ? {} : { corr }),
    });
    return codec.encodeMessage(msg, 'server');
  };

  const send = <T extends ServerMessageType>(
    type: T,
    payload: PayloadOf<T>,
    corr?: string,
  ): SendResult => {
    if (socket.readyState !== socket.OPEN) return 'closed';
    let text: string;
    try {
      text = encode(type, payload, corr);
    } catch (err) {
      // Never send what the agent would reject; this is a server bug.
      log.error(
        { type, err: err instanceof Error ? err.message : 'encode failed' },
        'refused to send',
      );
      return 'invalid';
    }
    socket.send(text);
    return 'sent';
  };

  /**
   * The session ends when the server decides it (idle, policy, replaced) or when the socket closes,
   * whichever comes first: from then on it gets no offers and its attempts are lost (D-d).
   */
  let ended = false;
  const endSession = (): void => {
    phase = 'closed';
    clearTimeout(authTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    const s = session;
    if (s === undefined || ended) return;
    ended = true;
    s.closed = true;
    queue = queue
      .then(async () => {
        deps.sessions.remove(s);
        await deps.sink.onSessionClosed(s);
      })
      .catch((err: unknown) => {
        log.error({ err: safeErrorText(err) }, 'session close failed');
      });
  };

  const close = (code: number, reason: string): void => {
    if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
      socket.close(code, reason);
      setTimeout(() => {
        if (socket.readyState !== socket.CLOSED) socket.terminate();
      }, CLOSE_GRACE_MS).unref();
    }
    endSession();
  };

  const fail = (code: ErrorCode): void => {
    send('auth.fail', { code });
    close(WS_POLICY_VIOLATION, code);
    phase = 'closed';
  };

  let idleTimer: NodeJS.Timeout | undefined;
  const resetIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      close(WS_GOING_AWAY, 'idle');
    }, config.idleTimeoutMs);
  };
  resetIdle();
  const authTimer = setTimeout(() => {
    if (phase === 'hello' || phase === 'prove') fail('auth_timeout');
  }, config.authTimeoutMs);

  async function onHello(msg: Extract<ProtocolMessage, { type: 'hello' }>): Promise<void> {
    const p = msg.payload;
    if (!isSupportedProtocolHash(p.protocolHash)) {
      fail('protocol_unsupported');
      return;
    }
    if (deps.devAgentSecret === undefined) {
      fail('node_unknown');
      return;
    }
    hello = p;
    challenge = { id: '', nonce: randomBytes(32).toString('hex'), at: clock.now().getTime() };
    const msgId = ids.newId();
    const text = codec.encodeMessage(
      makeMessage(
        'auth.challenge',
        {
          nonce: challenge.nonce,
          serverTime: formatTimestamp(clock.now()),
          expiresInMs: config.authTimeoutMs,
        },
        { id: msgId, ts: formatTimestamp(clock.now()), corr: msg.id },
      ),
      'server',
    );
    challenge.id = msgId;
    phase = 'prove';
    socket.send(text);
    await Promise.resolve();
  }

  async function onProve(msg: Extract<ProtocolMessage, { type: 'auth.prove' }>): Promise<void> {
    const h = hello;
    const c = challenge;
    const secret = deps.devAgentSecret;
    if (h === undefined || c === undefined || secret === undefined || msg.corr !== c.id) {
      fail('not_authenticated');
      return;
    }
    challenge = undefined; // one-time nonce
    if (clock.now().getTime() - c.at > config.authTimeoutMs) {
      fail('auth_nonce_expired');
      return;
    }
    const publicKey = devNodePublicKey(secret, h.nodeId);
    const bytes = authSigningBytes(c.nonce, h.nodeId, h.protocolHash);
    if (!verifyEd25519(publicKey, bytes, msg.payload.signature)) {
      fail('auth_invalid_signature');
      return;
    }
    const node = await upsertDevNode(deps.db, clock, {
      nodeId: h.nodeId,
      storeId: deps.storeId,
      publicKey,
      fpStore: h.fpStore,
      fpGlobal: h.fpGlobal,
      agentVersion: h.agentVersion,
    });
    if (node.blocked) {
      fail(
        node.state === 'quarantined'
          ? 'node_quarantined'
          : node.state === 'excluded'
            ? 'node_excluded'
            : node.state === 'pending'
              ? 'node_pending'
              : 'node_disabled',
      );
      return;
    }
    if (socket.readyState !== socket.OPEN) return;
    clearTimeout(authTimer);
    const s: AgentSession & { closed: boolean } = {
      sessionId: ids.newId(),
      nodeId: h.nodeId,
      storeId: deps.storeId,
      order: ++connectionOrder,
      models: new Map(),
      eligible: false,
      busyAttemptId: null,
      attemptIds: new Set(),
      closed: false,
      send,
      close,
    };
    session = s;
    const previous = deps.sessions.add(s);
    if (previous !== undefined) {
      previous.send('error', {
        code: 'session_replaced',
        message: 'session replaced',
        fatal: true,
      });
      previous.close(WS_POLICY_VIOLATION, 'session_replaced');
    }
    phase = 'ready';
    send(
      'auth.ok',
      {
        sessionId: s.sessionId,
        resumeToken: randomBytes(32).toString('hex'),
        resumed: false,
        configVersion: 1,
        serverTime: formatTimestamp(clock.now()),
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        control: { mode: 'active' },
        needCapabilities: true,
      },
      msg.id,
    );
    await deps.sink.onSessionReady(s);
  }

  async function onReady(s: AgentSession, msg: ProtocolMessage): Promise<void> {
    switch (msg.type) {
      case 'heartbeat':
        send('heartbeat.ack', { serverTime: formatTimestamp(clock.now()) }, msg.id);
        await touchNode(deps.db, clock, s.nodeId);
        return;
      case 'capabilities': {
        const p = msg.payload;
        s.models = new Map(p.cachedModels.map((m) => [m.id, m.sha256]));
        for (const m of p.cachedModels) await deps.onModelSeen(m.id);
        await setNodeCapabilities(deps.db, clock, s.nodeId, {
          runtimeVersion: `${p.runtime.name}-${p.runtime.version}`.slice(0, 64),
          osBuild: p.osBuild,
          gpuSummary: { gpus: p.gpus.map((g) => ({ name: g.name, vramTotalMb: g.vramTotalMb })) },
        });
        await deps.sink.onSessionStatus(s);
        return;
      }
      case 'status': {
        const p = msg.payload;
        const paused = p.state === 'paused';
        const customer = p.presence.customerPresent;
        s.eligible = p.eligible && !customer && !paused;
        await setNodeStatus(deps.db, clock, s.nodeId, {
          state: paused
            ? 'paused'
            : customer
              ? 'customer'
              : s.busyAttemptId !== null
                ? 'running'
                : 'idle',
          eligible: s.eligible,
          ineligibleReason: p.presence.reasonCodes[0] ?? (s.eligible ? null : 'not_eligible'),
        });
        if (paused) {
          // The server never paused this node (no kill switches before S10): the agent paused itself,
          // e.g. on an invalid stop command (PROTOCOL 4절). Re-send the current control state.
          // SKELETON(S11): control state (pause, kill switches) is not stored; it is always active.
          send('control.resume', { scope: 'node', reason: 'operatorRequest' });
        }
        await deps.sink.onSessionStatus(s);
        return;
      }
      case 'job.accept':
        await deps.sink.onJobAccept(s, msg.payload.attemptId);
        return;
      case 'job.reject':
        await deps.sink.onJobReject(s, msg.payload);
        return;
      case 'job.progress':
        await deps.sink.onJobProgress(s, msg.payload.attemptId);
        return;
      case 'job.chunk':
        // SKELETON(S12): streaming output is not relayed; a chunk only renews the lease.
        await deps.sink.onJobProgress(s, msg.payload.attemptId);
        return;
      case 'job.complete':
        await deps.sink.onJobComplete(s, msg.payload);
        return;
      case 'job.fail':
        await deps.sink.onJobFail(s, msg.payload);
        return;
      case 'job.preempted':
        await deps.sink.onJobPreempted(s, msg.payload);
        return;
      case 'error':
        log.warn({ nodeId: s.nodeId, code: msg.payload.code }, 'agent reported an error');
        return;
      default:
        // ack, model.status and a repeated hello/auth.prove need no action in the skeleton.
        return;
    }
  }

  async function onMessage(data: Buffer, isBinary: boolean): Promise<void> {
    if (phase === 'closed') return;
    resetIdle();
    if (isBinary) {
      close(WS_POLICY_VIOLATION, 'text frames only');
      return;
    }
    const decoded = codec.decodeMessage(data, 'server');
    if (!decoded.ok) {
      if (decoded.code === 'message_too_large') {
        close(WS_TOO_BIG, 'message_too_large');
        return;
      }
      send('error', { code: decoded.code, message: 'message rejected', fatal: false }, decoded.id);
      if (++rejected > config.maxRejectedMessages) close(WS_POLICY_VIOLATION, 'too many errors');
      return;
    }
    const msg = decoded.value;
    if (phase === 'hello') {
      if (msg.type === 'hello') await onHello(msg);
      else fail('not_authenticated');
      return;
    }
    if (phase === 'prove') {
      if (msg.type === 'auth.prove') await onProve(msg);
      else fail('not_authenticated');
      return;
    }
    if (session !== undefined) await onReady(session, msg);
  }

  socket.on('message', (data: Buffer, isBinary: boolean) => {
    queue = queue
      .then(() => onMessage(data, isBinary))
      .catch((err: unknown) => {
        // Never log message content: the error message only.
        log.error({ err: safeErrorText(err) }, 'agent message failed');
        send('error', { code: 'internal_error', message: 'internal error', fatal: false });
      });
  });

  socket.on('close', endSession);

  socket.on('error', () => {
    close(WS_INTERNAL, 'socket error');
  });
}

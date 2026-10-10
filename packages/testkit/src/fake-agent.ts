/**
 * A TypeScript agent that speaks the real protocol (S02 messages, the S04 development handshake) so the
 * walking skeleton runs where Go is not installed, and tests can script node behaviour (never accept,
 * go silent, fail, complete twice ...).
 *
 * testkit must not depend on @binjari/protocol (protocol already uses testkit for its Vitest config, and
 * pnpm refuses the cycle), so the caller passes the protocol functions in:
 *   `new FakeAgent({ protocol: await import('@binjari/protocol'), ... })`
 * Messages are encoded with the real codec, so a malformed message fails here, not on the server.
 */
import { createHash, randomBytes } from 'node:crypto';

/** The envelope shape (the codec validates the details). */
export interface FakeEnvelope {
  readonly v: number;
  readonly type: string;
  readonly id: string;
  readonly ts: string;
  readonly corr?: string;
  readonly payload: unknown;
}

export type FakeDecoded =
  | { readonly ok: true; readonly value: FakeEnvelope }
  | { readonly ok: false; readonly code: string; readonly pause: boolean };

/** The subset of @binjari/protocol the fake agent needs (pass the module itself). */
export interface FakeAgentProtocol {
  readonly PROTOCOL_HASH: string;
  defaultCodec(): {
    encodeMessage(message: FakeEnvelope, sender: 'agent'): string;
    decodeMessage(data: string | Uint8Array, receiver: 'agent'): FakeDecoded;
  };
  authSigningBytes(nonce: string, nodeId: string, protocolHash: string): Uint8Array;
  signEd25519(seedHex: string, message: Uint8Array): string;
  capabilitiesDigest(payload: FakeCapabilities): string;
  devAgentIdentity(
    secret: string,
    name: string,
  ): { nodeId: string; seedHex: string; fpStore: string; fpGlobal: string };
  devModelSha256(modelId: string): string;
}

export interface FakeCapabilities {
  gpus: never[];
  cpu: { model: string; cores: number; threads: number };
  ramMb: number;
  cacheDiskFreeMb: number;
  runtime: { name: 'fake'; version: string };
  cachedModels: { id: string; sha256: string }[];
  osBuild: string;
}

export type FakeAcceptMode = 'accept' | 'never' | 'reject';
export type FakeRunMode =
  'complete' | 'silent' | 'fail-retryable' | 'fail-fatal' | 'complete-twice' | 'bad-hash';

export interface FakeBehavior {
  readonly accept: FakeAcceptMode;
  readonly run: FakeRunMode;
  /** Simulated generation time before the result (ms). */
  readonly delayMs: number;
  /** Send job.progress this often while generating (0 = never). */
  readonly progressEveryMs: number;
  /** Ack job.cancel but keep running and report the result anyway (a late completion). */
  readonly ignoreCancel: boolean;
}

export interface FakeAgentOptions {
  readonly url: string;
  readonly secret: string;
  readonly name: string;
  readonly protocol: FakeAgentProtocol;
  readonly models?: readonly string[];
  /** Report eligible (stands in for `--always-available`). */
  readonly available?: boolean;
  readonly behavior?: Partial<FakeBehavior>;
  /** Heartbeat interval (0 = none). */
  readonly heartbeatMs?: number;
  /** How long connect() waits for auth.ok. */
  readonly connectTimeoutMs?: number;
}

export interface FakeAgentStats {
  offers: number;
  accepted: number;
  completed: number;
  failed: number;
  canceled: number;
  preempted: number;
}

export const FAKE_AGENT_VERSION = '0.0.0-fake';

/** Deterministic fake output for an input (the Go fake runtime uses its own text; both are "fake"). */
export function fakeOutput(name: string, input: unknown, seed: number, maxTokens: number): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(input))
    .update(String(seed))
    .digest('hex');
  const words = [`fake`, `reply`, `from`, name, digest.slice(0, 12)];
  return words.slice(0, Math.max(1, Math.min(words.length, maxTokens))).join(' ');
}

function uuidV7(): string {
  const b = randomBytes(16);
  let ms = Date.now();
  for (let i = 5; i >= 0; i--) {
    b[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  b[6] = 0x70 | ((b[6] ?? 0) & 0x0f);
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const isoMs = (): string => new Date().toISOString();

interface Offer {
  attemptId: string;
  params: { maxTokens: number; seed: number };
  input?: { messages?: { content: string }[] };
}

export class FakeAgent {
  readonly nodeId: string;
  readonly stats: FakeAgentStats = {
    offers: 0,
    accepted: 0,
    completed: 0,
    failed: 0,
    canceled: 0,
    preempted: 0,
  };
  /** Types of every message received (for assertions). */
  readonly received: string[] = [];
  behavior: FakeBehavior;

  readonly #opts: FakeAgentOptions;
  readonly #codec: ReturnType<FakeAgentProtocol['defaultCodec']>;
  readonly #identity: ReturnType<FakeAgentProtocol['devAgentIdentity']>;
  #ws: WebSocket | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  readonly #running = new Map<string, { cancel: () => void }>();
  #closed = false;
  #quiet = false;

  constructor(opts: FakeAgentOptions) {
    this.#opts = opts;
    this.#codec = opts.protocol.defaultCodec();
    this.#identity = opts.protocol.devAgentIdentity(opts.secret, opts.name);
    this.nodeId = this.#identity.nodeId;
    this.behavior = {
      accept: 'accept',
      run: 'complete',
      delayMs: 20,
      progressEveryMs: 0,
      ignoreCancel: false,
      ...opts.behavior,
    };
  }

  static async connect(opts: FakeAgentOptions): Promise<FakeAgent> {
    const agent = new FakeAgent(opts);
    await agent.start();
    return agent;
  }

  get connected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN && !this.#closed;
  }

  /** Attempts currently "generating". */
  get runningAttempts(): string[] {
    return [...this.#running.keys()];
  }

  #send(type: string, payload: unknown, corr?: string): void {
    const ws = this.#ws;
    if (ws?.readyState !== WebSocket.OPEN) return;
    const env: FakeEnvelope = {
      v: 1,
      type,
      id: uuidV7(),
      ts: isoMs(),
      ...(corr === undefined ? {} : { corr }),
      payload,
    };
    ws.send(this.#codec.encodeMessage(env, 'agent'));
  }

  #capabilities(): FakeCapabilities {
    const models = this.#opts.models ?? ['fake-echo'];
    return {
      gpus: [],
      cpu: { model: 'fake cpu', cores: 4, threads: 8 },
      ramMb: 16_384,
      cacheDiskFreeMb: 100_000,
      runtime: { name: 'fake', version: '1.0.0' },
      cachedModels: models.map((id) => ({ id, sha256: this.#opts.protocol.devModelSha256(id) })),
      osBuild: 'fake-os',
    };
  }

  #sendStatus(): void {
    const available = this.#opts.available ?? true;
    const busy = this.#running.size > 0;
    this.#send('status', {
      state: busy ? 'running' : available ? 'eligible' : 'ready',
      eligible: available,
      presence: {
        idleForMs: 0,
        customerPresent: false,
        reasonCodes: available ? [] : ['helper_missing'],
      },
      gpus: [],
      runningAttemptIds: [...this.#running.keys()],
      measuredAt: isoMs(),
    });
  }

  start(): Promise<void> {
    const { protocol } = this.#opts;
    const caps = this.#capabilities();
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.#opts.url);
      this.#ws = ws;
      let authed = false;
      const timer = setTimeout(() => {
        reject(new Error('FakeAgent: no auth.ok in time'));
        ws.close();
      }, this.#opts.connectTimeoutMs ?? 5_000);
      ws.addEventListener('open', () => {
        this.#send('hello', {
          protocolHash: protocol.PROTOCOL_HASH,
          agentVersion: FAKE_AGENT_VERSION,
          nodeId: this.nodeId,
          capabilitiesDigest: protocol.capabilitiesDigest(caps),
          fpStore: this.#identity.fpStore,
          fpGlobal: this.#identity.fpGlobal,
        });
      });
      ws.addEventListener('message', (ev: MessageEvent) => {
        if (this.#quiet) return;
        const decoded = this.#codec.decodeMessage(String(ev.data), 'agent');
        if (!decoded.ok) {
          this.received.push(`invalid:${decoded.code}`);
          return;
        }
        const msg = decoded.value;
        this.received.push(msg.type);
        switch (msg.type) {
          case 'auth.challenge': {
            const nonce = (msg.payload as { nonce: string }).nonce;
            const bytes = protocol.authSigningBytes(nonce, this.nodeId, protocol.PROTOCOL_HASH);
            this.#send(
              'auth.prove',
              { signature: protocol.signEd25519(this.#identity.seedHex, bytes) },
              msg.id,
            );
            return;
          }
          case 'auth.ok':
            authed = true;
            clearTimeout(timer);
            this.#send('capabilities', caps);
            this.#sendStatus();
            if ((this.#opts.heartbeatMs ?? 5_000) > 0) {
              this.#heartbeat = setInterval(() => {
                this.#send('heartbeat', {});
              }, this.#opts.heartbeatMs ?? 5_000);
            }
            resolve();
            return;
          case 'auth.fail':
            clearTimeout(timer);
            reject(new Error(`FakeAgent: auth.fail ${(msg.payload as { code: string }).code}`));
            return;
          case 'job.offer':
            this.#onOffer(msg as FakeEnvelope & { payload: Offer });
            return;
          case 'job.cancel': {
            const id = (msg.payload as { attemptId: string }).attemptId;
            if (!this.behavior.ignoreCancel) {
              this.#running.get(id)?.cancel();
              this.#running.delete(id);
            }
            this.stats.canceled++;
            this.#send('ack', { result: 'ok' }, msg.id);
            return;
          }
          default:
            return;
        }
      });
      ws.addEventListener('close', () => {
        this.#closed = true;
        clearInterval(this.#heartbeat);
        for (const r of this.#running.values()) r.cancel();
        this.#running.clear();
        if (!authed) {
          clearTimeout(timer);
          reject(new Error('FakeAgent: connection closed before auth.ok'));
        }
      });
    });
  }

  #onOffer(msg: FakeEnvelope & { payload: Offer }): void {
    this.stats.offers++;
    const offer = msg.payload;
    const b = this.behavior;
    if (b.accept === 'never') return;
    if (b.accept === 'reject') {
      this.#send('job.reject', { attemptId: offer.attemptId, reason: 'busy' }, msg.id);
      return;
    }
    this.#send('job.accept', { attemptId: offer.attemptId }, msg.id);
    this.stats.accepted++;
    let progress: NodeJS.Timeout | undefined;
    if (b.progressEveryMs > 0) {
      progress = setInterval(() => {
        this.#send('job.progress', { attemptId: offer.attemptId, tokensSoFar: 0 });
      }, b.progressEveryMs);
    }
    const done = setTimeout(() => {
      clearInterval(progress);
      this.#running.delete(offer.attemptId);
      this.#finish(offer, b.run);
    }, b.delayMs);
    this.#running.set(offer.attemptId, {
      cancel: () => {
        clearTimeout(done);
        clearInterval(progress);
      },
    });
  }

  #finish(offer: Offer, mode: FakeRunMode): void {
    if (mode === 'silent') {
      // Keep the attempt "running" forever without telling the server anything.
      this.#running.set(offer.attemptId, { cancel: () => undefined });
      return;
    }
    if (mode === 'fail-retryable' || mode === 'fail-fatal') {
      this.stats.failed++;
      this.#send('job.fail', {
        attemptId: offer.attemptId,
        code: mode === 'fail-retryable' ? 'runtime_crash' : 'input_invalid',
        retryable: mode === 'fail-retryable',
      });
      return;
    }
    const text = fakeOutput(
      this.#opts.name,
      offer.input ?? {},
      offer.params.seed,
      offer.params.maxTokens,
    );
    const sha = createHash('sha256').update(text, 'utf8').digest('hex');
    const complete = {
      attemptId: offer.attemptId,
      outputText: text,
      finishReason: 'stop',
      reportedTokensIn: (offer.input?.messages ?? []).reduce(
        (n, m) => n + m.content.split(/\s+/).filter(Boolean).length,
        0,
      ),
      reportedTokensOut: text.split(' ').length,
      timings: { loadMs: 0, promptMs: 1, genMs: this.behavior.delayMs },
      outputSha256: mode === 'bad-hash' ? '0'.repeat(64) : sha,
      runtime: { name: 'fake', version: '1.0.0' },
    };
    this.#send('job.complete', complete);
    if (mode === 'complete-twice') this.#send('job.complete', complete);
    this.stats.completed++;
    this.#sendStatus();
  }

  /** Graceful stop, like Ctrl+C: report running attempts as preempted (shutdown), then close. */
  async shutdown(): Promise<void> {
    for (const id of this.#running.keys()) {
      this.#running.get(id)?.cancel();
      this.#send('job.preempted', { attemptId: id, reason: 'shutdown', lastSeq: -1 });
      this.stats.preempted++;
    }
    this.#running.clear();
    await this.#closeSocket();
  }

  /**
   * Stop talking without closing: no heartbeats, no answers, every message ignored (a hung process). The
   * WebSocket stack itself still answers a close frame; a pulled cable would not.
   */
  goQuiet(): void {
    this.#quiet = true;
    clearInterval(this.#heartbeat);
    for (const r of this.#running.values()) r.cancel();
    this.#running.clear();
  }

  /** Drop the connection without saying anything (a crash: the OS closes the socket). */
  async kill(): Promise<void> {
    for (const r of this.#running.values()) r.cancel();
    this.#running.clear();
    await this.#closeSocket();
  }

  #closeSocket(): Promise<void> {
    clearInterval(this.#heartbeat);
    const ws = this.#ws;
    if (ws === undefined || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      ws.addEventListener('close', () => {
        resolve();
      });
      ws.close();
    });
  }
}

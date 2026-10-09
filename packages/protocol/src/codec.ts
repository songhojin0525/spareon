/**
 * Decode/encode pipeline for protocol messages and enrollment bodies. apps/agent/internal/protocol/codec.go
 * implements the same steps in the same order, and the contract tests require both to return the same
 * verdict code for every fixture.
 *
 * WS message verdict order:
 *   1. byte size > maxMessageBytes                 -> message_too_large
 *   2. strict JSON (strict-json.ts)                -> malformed_json
 *   3. envelope.json                               -> invalid_envelope
 *   4. type not in registry.json                   -> unknown_type
 *   5. receiver is the sender of this type         -> wrong_direction
 *   6. messages/<type>.json                        -> invalid_payload
 *   7. semantic limits (inline text UTF-8 bytes)   -> invalid_payload
 * HTTP bodies: 1 (maxHttpBodyBytes), 2, then http/<name>.json and 7 -> invalid_payload.
 */
import type { ValidateFunction } from 'ajv/dist/2020.js';

import { makeBundle, type ProtocolBundle, protocolHashOf } from './bundle.js';
import { BUNDLE_CANONICAL } from './generated/bundle.js';
import type {
  HttpBodyMap,
  HttpBodyName,
  ManifestKind,
  ManifestMap,
  MessageMap,
  MessageType,
  ProtocolMessage,
} from './generated/protocol.js';
import { HTTP_REGISTRY, LIMITS, MESSAGE_REGISTRY, PROTOCOL_HASH } from './generated/protocol.js';
import { compileValidators } from './validators.js';
import { parseStrictJson } from './wire/strict-json.js';

export type Side = 'agent' | 'server';

export type VerdictCode =
  | 'message_too_large'
  | 'malformed_json'
  | 'invalid_envelope'
  | 'unknown_type'
  | 'wrong_direction'
  | 'invalid_payload';

export type Decoded<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: VerdictCode;
      /** Diagnostic only (never contains message content); not part of the cross-language contract. */
      readonly detail: string;
      /** Envelope id when the envelope was valid, so an `error` reply can set `corr`. */
      readonly id?: string;
    };

export interface DecodeOptions {
  /** Overrides LIMITS.maxMessageBytes / LIMITS.maxHttpBodyBytes (configurable per deployment). */
  readonly maxBytes?: number;
}

export class ProtocolEncodeError extends Error {
  constructor(
    readonly code: VerdictCode,
    detail: string,
  ) {
    super(`refusing to send an invalid message (${code}): ${detail}`);
    this.name = 'ProtocolEncodeError';
  }
}

interface Registries {
  messages: Record<string, { from: string }>;
  http: Record<string, { from: string }>;
}
type Limits = Record<string, number>;

const encoder = new TextEncoder();
const utf8Length = (s: string): number => encoder.encode(s).length;

/** Sum of UTF-8 bytes of the inline buyer text in a payload (prompt, messages, prefix, output). */
export function inlineTextBytes(type: string, payload: unknown): number {
  const p = payload as {
    input?: { messages?: { content: string }[]; prompt?: string; continuationPrefix?: string };
    outputText?: string;
  };
  if (type === 'job.offer' && p.input !== undefined) {
    let n = 0;
    for (const m of p.input.messages ?? []) n += utf8Length(m.content);
    if (p.input.prompt !== undefined) n += utf8Length(p.input.prompt);
    if (p.input.continuationPrefix !== undefined) n += utf8Length(p.input.continuationPrefix);
    return n;
  }
  if (type === 'job.complete' && p.outputText !== undefined) return utf8Length(p.outputText);
  return 0;
}

const errorsText = (v: ValidateFunction): string =>
  (v.errors ?? [])
    .slice(0, 3)
    .map((e) => `${e.instancePath || '/'} ${e.keyword}`)
    .join('; ');

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface ProtocolCodec {
  readonly protocolHash: string;
  readonly limits: Readonly<Limits>;
  decodeMessage(
    data: Uint8Array | string,
    receiver: Side,
    opts?: DecodeOptions,
  ): Decoded<ProtocolMessage>;
  /** Validates and serializes; throws ProtocolEncodeError for anything the receiver would reject. */
  encodeMessage(message: ProtocolMessage, sender: Side): string;
  decodeHttpBody<N extends HttpBodyName>(
    name: N,
    data: Uint8Array | string,
    opts?: DecodeOptions,
  ): Decoded<HttpBodyMap[N]>;
  encodeHttpBody<N extends HttpBodyName>(name: N, body: HttpBodyMap[N]): string;
  /** Schema check for an already strict-parsed manifest object (see sign.ts for the full procedure). */
  isValidManifest<K extends ManifestKind>(kind: K, value: unknown): value is ManifestMap[K];
}

/**
 * Builds a codec for one protocol bundle. The server keeps one codec per supported protocolHash and
 * uses the session's codec for both directions (PROTOCOL.md "버전 정책").
 */
export function createCodec(bundle: ProtocolBundle = defaultBundle()): ProtocolCodec {
  const v = compileValidators(bundle);
  const registry = bundle.files['registry.json'] as Registries;
  const limits = bundle.files['limits.json'] as Limits;
  const limit = (name: string): number => {
    const n = limits[name];
    if (n === undefined) throw new Error(`limits.json lacks ${name}`);
    return n;
  };
  const maxInline = limit('maxInlineTextBytes');

  const sizeOf = (data: Uint8Array | string): number =>
    typeof data === 'string' ? utf8Length(data) : data.length;

  function decodeMessage(
    data: Uint8Array | string,
    receiver: Side,
    opts: DecodeOptions = {},
  ): Decoded<ProtocolMessage> {
    const max = opts.maxBytes ?? limit('maxMessageBytes');
    const size = sizeOf(data);
    if (size > max) return { ok: false, code: 'message_too_large', detail: `${size} > ${max}` };
    const parsed = parseStrictJson(data);
    if (!parsed.ok) return { ok: false, code: 'malformed_json', detail: parsed.reason };
    const msg = parsed.value;
    if (!v.envelope(msg) || !isRecord(msg)) {
      return { ok: false, code: 'invalid_envelope', detail: errorsText(v.envelope) };
    }
    const type = msg['type'] as string;
    const id = msg['id'] as string;
    const info = registry.messages[type];
    const validate = v.messages.get(type);
    if (info === undefined || validate === undefined) {
      return { ok: false, code: 'unknown_type', detail: type, id };
    }
    if (info.from !== 'both' && info.from === receiver) {
      return { ok: false, code: 'wrong_direction', detail: `${type} is sent by ${info.from}`, id };
    }
    if (!validate(msg)) {
      return { ok: false, code: 'invalid_payload', detail: errorsText(validate), id };
    }
    const inline = inlineTextBytes(type, msg['payload']);
    if (inline > maxInline) {
      return {
        ok: false,
        code: 'invalid_payload',
        detail: `inline text ${inline} > ${maxInline}`,
        id,
      };
    }
    return { ok: true, value: msg as unknown as ProtocolMessage };
  }

  function decodeHttpBody<N extends HttpBodyName>(
    name: N,
    data: Uint8Array | string,
    opts: DecodeOptions = {},
  ): Decoded<HttpBodyMap[N]> {
    const validate = v.http.get(name);
    if (validate === undefined) throw new Error(`unknown http body ${name}`);
    const max = opts.maxBytes ?? limit('maxHttpBodyBytes');
    const size = sizeOf(data);
    if (size > max) return { ok: false, code: 'message_too_large', detail: `${size} > ${max}` };
    const parsed = parseStrictJson(data);
    if (!parsed.ok) return { ok: false, code: 'malformed_json', detail: parsed.reason };
    if (!validate(parsed.value)) {
      return { ok: false, code: 'invalid_payload', detail: errorsText(validate) };
    }
    return { ok: true, value: parsed.value as HttpBodyMap[N] };
  }

  return {
    protocolHash: protocolHashOf(bundle),
    limits,
    decodeMessage,
    encodeMessage(message, sender) {
      const text = JSON.stringify(message);
      const receiver: Side = sender === 'agent' ? 'server' : 'agent';
      const back = decodeMessage(text, receiver);
      if (!back.ok) throw new ProtocolEncodeError(back.code, back.detail);
      return text;
    },
    decodeHttpBody,
    encodeHttpBody(name, body) {
      const text = JSON.stringify(body);
      const back = decodeHttpBody(name, text);
      if (!back.ok) throw new ProtocolEncodeError(back.code, back.detail);
      return text;
    },
    isValidManifest<K extends ManifestKind>(kind: K, value: unknown): value is ManifestMap[K] {
      const validate = v.manifests.get(kind);
      if (validate === undefined) throw new Error(`unknown manifest kind ${kind}`);
      return validate(value);
    },
  };
}

let cachedBundle: ProtocolBundle | undefined;
/** The bundle this package was generated from (src/generated/bundle.ts). */
export function defaultBundle(): ProtocolBundle {
  if (cachedBundle === undefined) {
    const parsed = parseStrictJson(BUNDLE_CANONICAL);
    if (!parsed.ok || !isRecord(parsed.value) || !isRecord(parsed.value['files'])) {
      throw new Error('generated bundle is corrupt');
    }
    cachedBundle = makeBundle(parsed.value['files']);
    if (protocolHashOf(cachedBundle) !== PROTOCOL_HASH) {
      throw new Error('generated bundle does not match PROTOCOL_HASH; run gen');
    }
  }
  return cachedBundle;
}

let cachedCodec: ProtocolCodec | undefined;
/** Codec for the current protocol (compiled once per process). */
export function defaultCodec(): ProtocolCodec {
  cachedCodec ??= createCodec();
  return cachedCodec;
}

/** Message metadata supplied by the caller: IDs and time come from injected sources, never from here. */
export interface MessageMeta {
  readonly id: string;
  readonly ts: string;
  readonly corr?: string;
}

/** Builds an envelope. Validation happens in encodeMessage (corr rules, payload schema). */
export function makeMessage<T extends MessageType>(
  type: T,
  payload: MessageMap[T]['payload'],
  meta: MessageMeta,
): MessageMap[T] {
  return {
    v: 1,
    type,
    id: meta.id,
    ts: meta.ts,
    ...(meta.corr !== undefined ? { corr: meta.corr } : {}),
    payload,
  } as unknown as MessageMap[T];
}

/** Which side receives a message type ('both' types can go either way). */
export function receiversOf(type: MessageType): readonly Side[] {
  const from = MESSAGE_REGISTRY[type].from as string;
  return from === 'agent' ? ['server'] : from === 'server' ? ['agent'] : ['agent', 'server'];
}

export { HTTP_REGISTRY, LIMITS, MESSAGE_REGISTRY, PROTOCOL_HASH };

import { describe, expect, it } from 'vitest';

import {
  defaultBundle,
  defaultCodec,
  isSupportedProtocolHash,
  LIMITS,
  makeMessage,
  PROTOCOL_HASH,
  ProtocolEncodeError,
  protocolHashOf,
  receiversOf,
} from '../src/index.js';

const codec = defaultCodec();
const meta = { id: '01920000-0000-7000-8000-000000000001', ts: '2026-10-09T04:36:00.000Z' };
const attemptId = '01920000-0000-7000-8000-000000000040';

const offer = (content: string) =>
  makeMessage(
    'job.offer',
    {
      attemptId,
      jobKind: 'chat',
      model: { id: 'm', sha256: 'e1'.repeat(32) },
      params: {
        maxTokens: 1,
        temperatureMilli: 0,
        topPMilli: 1000,
        stop: [],
        seed: 1,
        greedy: true,
      },
      input: { messages: [{ role: 'user', content }] },
      stream: true,
      timeLimitMs: 600_000,
      leaseTtlMs: 15_000,
    },
    meta,
  );

describe('codec', () => {
  it('embedded bundle hashes to PROTOCOL_HASH and is the only supported hash', () => {
    expect(protocolHashOf(defaultBundle())).toBe(PROTOCOL_HASH);
    expect(codec.protocolHash).toBe(PROTOCOL_HASH);
    expect(isSupportedProtocolHash(PROTOCOL_HASH)).toBe(true);
    expect(isSupportedProtocolHash('00'.repeat(32))).toBe(false);
  });

  it('accepts inline input of exactly maxInlineTextBytes and rejects one byte more', () => {
    const atLimit = 'a'.repeat(LIMITS.maxInlineTextBytes - 2) + 'é'; // é is 2 bytes
    expect(codec.decodeMessage(codec.encodeMessage(offer(atLimit), 'server'), 'agent').ok).toBe(
      true,
    );
    expect(() => codec.encodeMessage(offer(`${atLimit}a`), 'server')).toThrow(ProtocolEncodeError);
  });

  it('applies the default 1 MiB limit and a configured override', () => {
    const big = new Uint8Array(LIMITS.maxMessageBytes + 1).fill(0x20);
    const r = codec.decodeMessage(big, 'server');
    expect(r.ok ? 'ok' : r.code).toBe('message_too_large');
    const msg = codec.encodeMessage(makeMessage('heartbeat', {}, meta), 'agent');
    const small = codec.decodeMessage(msg, 'server', { maxBytes: 10 });
    expect(small.ok ? 'ok' : small.code).toBe('message_too_large');
  });

  it('counts the limit in UTF-8 bytes for string input', () => {
    const msg = codec.encodeMessage(makeMessage('heartbeat', {}, meta), 'agent');
    const bytes = new TextEncoder().encode(msg).length;
    expect(codec.decodeMessage(msg, 'server', { maxBytes: bytes }).ok).toBe(true);
    expect(codec.decodeMessage(msg, 'server', { maxBytes: bytes - 1 }).ok).toBe(false);
  });

  it('returns the envelope id for replies when the envelope was valid', () => {
    const r = codec.decodeMessage(
      JSON.stringify({ v: 1, type: 'job.steal', id: meta.id, ts: meta.ts, payload: {} }),
      'server',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('unknown_type');
      expect(r.id).toBe(meta.id);
    }
  });

  it('refuses to encode messages the receiver would reject', () => {
    expect(() =>
      codec.encodeMessage(makeMessage('job.accept', { attemptId }, meta), 'agent'),
    ).toThrow(
      /invalid_payload/, // corr is required for job.accept
    );
    expect(() =>
      codec.encodeMessage(makeMessage('heartbeat', {}, { ...meta, corr: meta.id }), 'agent'),
    ).toThrow(ProtocolEncodeError);
    expect(() => codec.encodeMessage(makeMessage('heartbeat', {}, meta), 'server')).toThrow(
      /wrong_direction/,
    );
    const withFloat = offer('x');
    (withFloat.payload.params as { temperatureMilli: number }).temperatureMilli = 0.7;
    expect(() => codec.encodeMessage(withFloat, 'server')).toThrow(/malformed_json/);
  });

  it('error messages may travel in both directions', () => {
    expect(receiversOf('error')).toEqual(['agent', 'server']);
    const e = makeMessage(
      'error',
      { code: 'rate_limited', message: 'slow down', fatal: false },
      meta,
    );
    expect(codec.decodeMessage(codec.encodeMessage(e, 'agent'), 'server').ok).toBe(true);
    expect(codec.decodeMessage(codec.encodeMessage(e, 'server'), 'agent').ok).toBe(true);
  });

  it('never puts message content into the diagnostic detail', () => {
    const secret = 'SECRET-PROMPT-CONTENT';
    const m = offer(secret);
    (m.payload as unknown as Record<string, unknown>)['extra'] = secret;
    const r = codec.decodeMessage(JSON.stringify(m), 'agent');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).not.toContain(secret);
  });
});

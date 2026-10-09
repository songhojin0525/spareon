import { describe, expect, it } from 'vitest';

import { defaultCodec, type Side } from '../src/codec.js';
import {
  HTTP_REGISTRY,
  MESSAGE_REGISTRY,
  type ProtocolMessage,
} from '../src/generated/protocol.js';
import { canonicalJson } from '../src/wire/canonical-json.js';
import { parseStrictJson } from '../src/wire/strict-json.js';
import {
  type Fixture,
  invalidFixtures,
  invalidReceiver,
  isHttpBody,
  isMessageType,
  validFixtures,
} from './fixtures.js';

const codec = defaultCodec();
const valid = validFixtures();
const invalid = invalidFixtures();

function receiversFor(type: string): Side[] {
  if (!isMessageType(type)) return ['server'];
  const from = MESSAGE_REGISTRY[type].from as string;
  return from === 'agent' ? ['server'] : from === 'server' ? ['agent'] : ['agent', 'server'];
}

function decodeFixture(f: Fixture, receiver: Side, maxBytes?: number) {
  const opts = maxBytes === undefined ? {} : { maxBytes };
  if (isHttpBody(f.folder)) return codec.decodeHttpBody(f.folder, f.bytes, opts);
  return codec.decodeMessage(f.bytes, receiver, opts);
}

describe('fixture coverage (S02 acceptance 2)', () => {
  const all = [...Object.keys(MESSAGE_REGISTRY), ...Object.keys(HTTP_REGISTRY)];

  it.each(all)('%s has >= 1 valid and >= 3 invalid fixtures of the required kinds', (type) => {
    const v = valid.filter((f) => f.folder === type);
    const inv = invalid.filter((f) => f.folder === type);
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(inv.length).toBeGreaterThanOrEqual(3);
    expect(inv.some((f) => f.caseName.startsWith('missing-'))).toBe(true);
    expect(inv.some((f) => f.caseName.startsWith('type-'))).toBe(true);
    expect(inv.some((f) => f.caseName.startsWith('extra-') || f.caseName.startsWith('size-'))).toBe(
      true,
    );
  });

  it('every fixture folder is a known type or a shared folder', () => {
    const shared = new Set(['_envelope', '_json', '_size', '_direction']);
    for (const f of [...valid, ...invalid]) {
      expect(isMessageType(f.folder) || isHttpBody(f.folder) || shared.has(f.folder), f.rel).toBe(
        true,
      );
    }
  });
});

describe('valid fixtures decode and round-trip', () => {
  it.each(valid.map((f) => [f.rel, f] as const))('%s', (_rel, f) => {
    const original = parseStrictJson(f.bytes);
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    for (const receiver of receiversFor(f.folder)) {
      const r = decodeFixture(f, receiver);
      expect(r.ok ? 'ok' : `${r.code}: ${r.detail}`).toBe('ok');
      if (!r.ok) return;
      // decode -> encode -> decode gives the same meaning (canonical form compares structure exactly).
      let text: string;
      if (isHttpBody(f.folder)) {
        const name = f.folder;
        text = codec.encodeHttpBody(name, r.value as never);
        const again = codec.decodeHttpBody(name, text);
        expect(again.ok && canonicalJson(again.value)).toBe(canonicalJson(original.value));
      } else {
        const msg = r.value as ProtocolMessage;
        expect(msg.type).toBe(f.folder);
        const sender: Side = receiver === 'server' ? 'agent' : 'server';
        text = codec.encodeMessage(msg, sender);
        const again = codec.decodeMessage(text, receiver);
        expect(again.ok && canonicalJson(again.value)).toBe(canonicalJson(original.value));
      }
    }
  });
});

describe('invalid fixtures are rejected with the expected verdict', () => {
  it.each(invalid.map((f) => [f.rel, f] as const))('%s', (_rel, f) => {
    const { receiver, maxBytes } = invalidReceiver(f);
    const r = decodeFixture(f, receiver, maxBytes);
    expect(r.ok ? 'ok' : r.code).toBe(f.expect);
  });
});

describe('agent fail-safe pause (same rule as Go TestAgentFailSafePause)', () => {
  const untyped = new Set(['message_too_large', 'malformed_json', 'invalid_envelope']);
  const registry = MESSAGE_REGISTRY as Record<string, { onInvalid: string }>;

  it('pauses the agent on rejected stop commands and untypeable messages, never the server', () => {
    let pausing = 0;
    for (const f of invalid.filter((x) => !isHttpBody(x.folder))) {
      const { maxBytes } = invalidReceiver(f);
      for (const receiver of ['agent', 'server'] as const) {
        const r = decodeFixture(f, receiver, maxBytes);
        if (r.ok) continue; // a misdirected fixture can be valid for the other side
        const want =
          receiver === 'agent' &&
          (untyped.has(r.code) ||
            (r.code === 'invalid_payload' && registry[r.type ?? '']?.onInvalid === 'pause'));
        expect(r.pause, `${f.rel} as ${receiver}: ${r.code}`).toBe(want);
        if (want && r.code === 'invalid_payload') pausing++;
        expect(r.type === undefined, `${f.rel} type`).toBe(untyped.has(r.code));
      }
    }
    expect(pausing).toBeGreaterThanOrEqual(9);
  });

  it('marks exactly the stop commands as pause-on-invalid', () => {
    const pauses = Object.entries(registry)
      .filter(([, info]) => info.onInvalid === 'pause')
      .map(([type]) => type)
      .sort();
    expect(pauses).toEqual(['control.kill', 'control.pause', 'job.cancel']);
  });
});

describe('maxBytes override', () => {
  const big = ' '.repeat(codec.limits['maxMessageBytes'] ?? 0);
  it.each([0, -1])('maxBytes %d means the protocol default (as in Go)', (maxBytes) => {
    const over = codec.decodeMessage(`${big} `, 'server', { maxBytes });
    expect(over.ok ? 'ok' : over.code).toBe('message_too_large');
    const at = codec.decodeMessage(big, 'server', { maxBytes });
    expect(at.ok ? 'ok' : at.code).toBe('malformed_json');
  });
});

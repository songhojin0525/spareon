import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeBundle, protocolHashOf } from '../src/bundle.js';
import { generateAll, OUTPUTS } from '../src/codegen/generate.js';
import { pascal } from '../src/codegen/ir.js';
import { BUNDLE_CANONICAL } from '../src/generated/bundle.js';
import { PROTOCOL_HASH } from '../src/generated/protocol.js';
import { PACKAGE_ROOT, readSchemaSources } from '../src/schema-source.js';
import { canonicalJson } from '../src/wire/canonical-json.js';

const repoRoot = path.resolve(PACKAGE_ROOT, '..', '..');
const onDisk = (rel: string): string =>
  readFileSync(path.join(repoRoot, ...rel.split('/')), 'utf8').replace(/\r\n/g, '\n');

const source = readSchemaSources();

describe('generated files are up to date (run `pnpm --filter @binjari/protocol gen`)', () => {
  const fresh = generateAll(source);

  it.each([...fresh.keys()])('%s', (rel) => {
    expect(onDisk(rel), `${rel} is stale: run pnpm --filter @binjari/protocol gen`).toBe(
      fresh.get(rel),
    );
  });

  it('covers every output', () => {
    expect([...fresh.keys()].sort()).toEqual(Object.values(OUTPUTS).sort());
  });

  it('a schema-only change makes the committed outputs stale', () => {
    const files = structuredClone(source.files) as Record<string, unknown>;
    const job = files['messages/job.reject.json'] as {
      properties: { payload: { properties: { reason: { enum: string[] } } } };
    };
    job.properties.payload.properties.reason.enum.push('newReason');
    const changed = generateAll(makeBundle(files));
    for (const rel of Object.values(OUTPUTS)) expect(changed.get(rel)).not.toBe(onDisk(rel));
  });
});

describe('protocol hash', () => {
  it('generated constant equals the hash recomputed from the source schemas', () => {
    expect(PROTOCOL_HASH).toBe(protocolHashOf(source));
    expect(PROTOCOL_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it('embedded bundle is the canonical source bundle', () => {
    expect(BUNDLE_CANONICAL).toBe(canonicalJson(source));
  });

  it('ignores formatting and key order but not content', () => {
    const files = structuredClone(source.files) as Record<string, Record<string, unknown>>;
    const reordered = Object.fromEntries(Object.entries(files).reverse());
    expect(protocolHashOf(makeBundle(reordered))).toBe(PROTOCOL_HASH);
    const limits = files['limits.json'] ?? {};
    limits['maxMessageBytes'] = 1_048_577;
    expect(protocolHashOf(makeBundle(files))).not.toBe(PROTOCOL_HASH);
  });
});

describe('pascal()', () => {
  it.each([
    ['job.offer', 'JobOffer'],
    ['attemptId', 'AttemptID'],
    ['topPMilli', 'TopPMilli'],
    ['leaseTtlMs', 'LeaseTTLMs'],
    ['customer_input', 'CustomerInput'],
    ['windows-amd64', 'WindowsAmd64'],
    ['outputSha256', 'OutputSha256'],
    ['gpus', 'GPUs'],
  ])('%s -> %s', (input, expected) => {
    expect(pascal(input)).toBe(expected);
  });
});

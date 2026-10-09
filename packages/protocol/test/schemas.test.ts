import { describe, expect, it } from 'vitest';

import { lintSchema } from '../src/schema-lint.js';
import { readSchemaSources } from '../src/schema-source.js';
import { compileValidators } from '../src/validators.js';

const bundle = readSchemaSources();
const files = bundle.files as Record<string, unknown>;

interface Registry {
  messages: Record<string, { from: string; replies: string[]; timeoutMs?: number }>;
  http: Record<string, { from: string; replies: string[] }>;
}
interface ErrorRegistry {
  codes: Record<string, { from: string; retryable: boolean; fatal: boolean; agentAction: string }>;
}
const registry = files['registry.json'] as Registry;
const errorCodes = files['defs/error-codes.json'] as ErrorRegistry;

describe('schema rules (lint)', () => {
  it('every schema file passes every rule', () => {
    const problems = Object.entries(files).flatMap(([rel, doc]) =>
      rel === 'registry.json' || rel === 'limits.json' || rel === 'defs/error-codes.json'
        ? []
        : lintSchema(rel, doc),
    );
    expect(problems).toEqual([]);
  });

  it.each([
    ['unbounded string', { type: 'string' }, 'string needs maxLength'],
    ['unbounded array', { type: 'array', items: { type: 'boolean' } }, 'array needs maxItems'],
    ['float type', { type: 'number' }, 'type must be one of'],
    ['integer without range', { type: 'integer', minimum: 0 }, 'integer needs minimum and maximum'],
    ['huge integer bound', { type: 'integer', minimum: 0, maximum: 2 ** 60 }, 'within'],
    ['open object', { type: 'object', properties: {} }, 'additionalProperties: false'],
    ['human text', { type: 'boolean', description: 'x' }, 'keyword "description"'],
    ['format', { type: 'string', maxLength: 9, format: 'date-time' }, 'keyword "format"'],
    ['unanchored pattern', { type: 'string', maxLength: 9, pattern: '[a-z]+' }, 'anchored'],
    ['non-ASCII pattern', { type: 'string', maxLength: 9, pattern: '^한$' }, 'anchored'],
    [
      'optional array without minItems',
      {
        type: 'object',
        additionalProperties: false,
        required: [],
        properties: { a: { type: 'array', items: { type: 'boolean' }, maxItems: 2 } },
      },
      'optional array needs minItems',
    ],
    [
      'constraint on undeclared property',
      {
        type: 'object',
        additionalProperties: false,
        required: [],
        properties: { a: { type: 'boolean' } },
        oneOf: [{ required: ['b'] }],
      },
      'undeclared property "b"',
    ],
    [
      'typed constraint',
      {
        type: 'object',
        additionalProperties: false,
        required: [],
        properties: { a: { type: 'boolean' } },
        not: { type: 'object' },
      },
      'not allowed in a constraint',
    ],
  ])('rejects %s', (_name, schema, message) => {
    const problems = lintSchema('t.json', {
      $schema: 'x',
      $defs: { x: schema },
    });
    expect(problems.join('\n')).toContain(message);
  });
});

describe('schema bundle', () => {
  it('compiles with Ajv strict mode', () => {
    const v = compileValidators(bundle);
    expect(v.messages.size).toBe(Object.keys(registry.messages).length);
    expect(v.http.size).toBe(Object.keys(registry.http).length);
    expect([...v.manifests.keys()].sort()).toEqual(['model', 'release']);
  });

  it('registry lists exactly the message and http schema files', () => {
    const msgFiles = Object.keys(files)
      .filter((f) => f.startsWith('messages/'))
      .map((f) => f.slice('messages/'.length, -'.json'.length))
      .sort();
    expect(Object.keys(registry.messages).sort()).toEqual(msgFiles);
    const httpFiles = Object.keys(files)
      .filter((f) => f.startsWith('http/'))
      .map((f) => f.slice('http/'.length, -'.json'.length))
      .sort();
    expect(Object.keys(registry.http).sort()).toEqual(httpFiles);
  });

  it('every reply named in the registry is a known message or http body', () => {
    for (const entry of [...Object.values(registry.messages), ...Object.values(registry.http)]) {
      for (const r of entry.replies) {
        expect(r in registry.messages || r in registry.http, r).toBe(true);
      }
    }
  });

  it('errorCode enum equals the error code registry', () => {
    const common = files['defs/common.json'] as { $defs: { errorCode: { enum: string[] } } };
    expect([...common.$defs.errorCode.enum].sort()).toEqual(Object.keys(errorCodes.codes).sort());
  });

  it('error codes are snake_case and every agent action is from the documented set', () => {
    const actions = new Set([
      'none',
      'dropMessage',
      'closeConnection',
      'reconnectBackoff',
      'waitForUpdate',
      'reenroll',
      'stopAndWait',
      'retryLater',
    ]);
    for (const [code, e] of Object.entries(errorCodes.codes)) {
      expect(code).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
      expect(actions.has(e.agentAction), code).toBe(true);
      expect(['any', 'agent', 'server']).toContain(e.from);
    }
  });

  it('job.offer has no verification flag (ARCHITECTURE D4, ADR 0007)', () => {
    const offer = files['messages/job.offer.json'] as {
      properties: { payload: { properties: Record<string, unknown> } };
    };
    const names = Object.keys(offer.properties.payload.properties).join(' ');
    expect(names).not.toMatch(/verif|canary|duplicate|check/i);
  });
});

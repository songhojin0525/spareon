import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PERMISSIONS } from '../../src/http/permissions.js';
import { type Harness, startHarness } from '../support/skeleton.js';
import { createTestUser, type ErrorBody, loggedIn } from '../support/web.js';

const require = createRequire(import.meta.url);
/**
 * The official OAS 3.1 schema. Its `$dynamicRef: "#meta"` (bound to a plain object-or-boolean schema in
 * schema.json) is replaced by the equivalent static `$ref`: Ajv mis-tracks unevaluatedProperties through
 * $dynamicRef. The embedded schemas are then checked separately against the JSON Schema 2020-12
 * meta-schema (the OpenAPI 3.1 dialect).
 */
const oas31 = JSON.parse(
  readFileSync(
    require.resolve('@apidevtools/openapi-schemas/schemas/v3.1/schema.json'),
    'utf8',
  ).replaceAll('"$dynamicRef": "#meta"', '"$ref": "#/$defs/schema"'),
) as Record<string, unknown>;

/** Every object under a "schema" key (request bodies, responses, parameters). */
function embeddedSchemas(node: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) for (const n of node) embeddedSchemas(n, out);
  else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'schema' && v !== null && typeof v === 'object') out.push(v);
      else embeddedSchemas(v, out);
    }
  }
  return out;
}

describe('OpenAPI 3.1 document and operator routes', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('serves a document that validates against the official OAS 3.1 schema and covers every route', async () => {
    const res = await fetch(`${h.baseUrl}/api/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<
        string,
        Record<string, { operationId: string; responses: Record<string, unknown> }>
      >;
    };
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validate = ajv.compile(oas31);
    const ok = validate(doc);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    // The validator does reject a broken document.
    expect(
      validate({
        openapi: '3.1.0',
        info: { title: 'x' },
        paths: { '/a': { get: { responses: 'no' } } },
      }),
    ).toBe(false);
    expect(doc.openapi).toBe('3.1.0');
    const schemas = embeddedSchemas(doc.paths);
    expect(schemas.length).toBeGreaterThan(20);
    for (const sch of schemas) {
      const r = ajv.validateSchema(sch as object);
      expect(r, JSON.stringify(ajv.errors)).toBe(true);
    }
    const documented = Object.entries(doc.paths).flatMap(([p, ops]) =>
      Object.entries(ops).map(([m, op]) => `${m.toUpperCase()} ${p} ${op.operationId}`),
    );
    const expected = Object.entries(PERMISSIONS).map(
      ([action, r]) => `${r.method} ${r.path.replace(/:([A-Za-z]+)/g, '{$1}')} ${action}`,
    );
    // /healthz is registered by buildApp outside the router (no schema): every other row is documented.
    expect(documented.sort()).toEqual(expected.filter((e) => !e.startsWith('GET /healthz')).sort());
    const chat = doc.paths['/v1/chat/completions']?.['post'];
    expect(Object.keys(chat?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '401', '429']),
    );
  });

  it('operators change settings only within their schema, and the change takes effect and is audited', async () => {
    const op = await createTestUser(h, 'operator');
    const b = await loggedIn(h, op);
    const bad = await b.request('PUT', '/api/ops/settings/api_keys.default_rpm', {
      body: { value: 0 },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as ErrorBody).error.code).toBe('invalid_setting_value');
    expect(
      (await b.request('PUT', '/api/ops/settings/dev.skeleton', { body: { value: {} } })).status,
    ).toBe(404);
    const off = await b.request('PUT', '/api/ops/settings/auth.signup_enabled', {
      body: { value: false },
    });
    expect(off.status).toBe(200);
    const anon = await import('../support/web.js').then(({ Browser }) => Browser.of(h));
    await anon.primeCsrf();
    const closed = await anon.request('POST', '/api/auth/signup', {
      body: {
        email: 'closed@test.spareon',
        password: 'a long enough password',
        displayName: 'x',
        role: 'buyer',
        termsVersion: '2026-10-draft',
      },
    });
    expect(closed.status).toBe(403);
    expect(((await closed.json()) as ErrorBody).error.code).toBe('signup_closed');
    const audit = await b.request('GET', '/api/ops/audit?limit=10');
    const entries = (
      (await audit.json()) as { data: { action: string; actorUserId: string; data: unknown }[] }
    ).data;
    const set = entries.find((e) => e.action === 'settings.set');
    expect(set).toMatchObject({ actorUserId: op.id, data: { previous: true, value: false } });
    await b.request('PUT', '/api/ops/settings/auth.signup_enabled', { body: { value: true } });
  });

  it('operators cannot disable themselves; disabling another user ends their access', async () => {
    const op = await createTestUser(h, 'operator');
    const b = await loggedIn(h, op);
    const self = await b.request('POST', `/api/ops/users/${op.id}/disable`);
    expect(((await self.json()) as ErrorBody).error.code).toBe('cannot_disable_self');
    const victim = await createTestUser(h, 'owner');
    const vb = await loggedIn(h, victim);
    expect((await b.request('POST', `/api/ops/users/${victim.id}/disable`)).status).toBe(200);
    expect((await vb.request('GET', '/api/auth/session')).status).toBe(401);
  });

  it('/readyz answers ready while the database answers', async () => {
    const res = await fetch(`${h.baseUrl}/readyz`);
    expect(await res.json()).toEqual({ status: 'ready' });
  });
});

/**
 * OpenAPI 3.1 document generated from the registered routes' zod schemas (draft 2020-12, which is the
 * schema dialect of OpenAPI 3.1). Served at /api/openapi.json; a test validates it against the
 * official OAS 3.1 schema and checks that every route is documented.
 */
import { z } from 'zod';

import { PERMISSIONS, ROLES } from './permissions.js';
import type { RouteDef } from './router.js';

type AnyDef = RouteDef<z.ZodType | undefined, z.ZodType | undefined, z.ZodType | undefined>;

const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'requestId'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        requestId: { type: 'string' },
        type: { type: 'string', description: 'OpenAI-compatible error type (buyer API only)' },
        details: { type: 'object' },
      },
    },
  },
} as const;

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const s = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  delete s['$schema'];
  return s;
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Invalid request',
  401: 'Not authenticated',
  402: 'Not enough credit',
  403: 'Not permitted (role, scope or CSRF)',
  404: 'Not found (or not yours)',
  409: 'Conflict',
  410: 'Gone',
  413: 'Too large',
  429: 'Rate limited',
  500: 'Internal error',
  502: 'Upstream node failed',
  503: 'Unavailable',
  504: 'Timed out',
};

export function buildOpenApi(
  defs: readonly AnyDef[],
  info: { version: string; serverUrl: string },
) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const def of defs) {
    const row = PERMISSIONS[def.action];
    const path = row.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const parameters: unknown[] = [];
    for (const [where, schema] of [
      ['path', def.params],
      ['query', def.query],
    ] as const) {
      if (schema === undefined) continue;
      const js = jsonSchema(schema, 'input') as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      for (const [name, prop] of Object.entries(js.properties ?? {})) {
        parameters.push({
          name,
          in: where,
          required: where === 'path' || (js.required ?? []).includes(name),
          schema: prop,
        });
      }
    }
    const security =
      row.auth === 'session' ? [{ session: [] }] : row.auth === 'api_key' ? [{ apiKey: [] }] : [];
    const roles = ROLES.filter((r) => row.access[r] !== 'deny')
      .map((r) => (row.access[r] === 'own' ? `${r} (own)` : r))
      .join(', ');
    const success = String(def.successStatus ?? 200);
    const responses: Record<string, unknown> = {
      [success]: {
        description: 'Success',
        ...(def.response === undefined
          ? {}
          : { content: { 'application/json': { schema: jsonSchema(def.response, 'output') } } }),
      },
    };
    const errors = new Set<number>(def.errors ?? []);
    if (row.auth !== 'public' || Object.values(row.access).includes('deny')) {
      errors.add(401);
      errors.add(403);
    }
    if (def.params !== undefined || def.query !== undefined || def.body !== undefined)
      errors.add(400);
    for (const status of [...errors].sort()) {
      responses[String(status)] = {
        description: STATUS_TEXT[status] ?? 'Error',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      };
    }
    paths[path] ??= {};
    paths[path][row.method.toLowerCase()] = {
      operationId: def.action,
      summary: def.summary,
      description: `Allowed: ${roles || 'nobody'}.`,
      tags: [...def.tags],
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(def.body === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: jsonSchema(def.body, 'input') } },
            },
          }),
      security,
      responses,
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Spareon API',
      version: info.version,
      description:
        'People use session cookies (state-changing requests also need x-csrf-token and a same-origin Origin). Buyers call /v1 with an API key.',
    },
    servers: [{ url: info.serverUrl }],
    paths,
    components: {
      schemas: { Error: errorSchema },
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: 'spareon_session' },
        apiKey: { type: 'http', scheme: 'bearer', description: 'sp_test_… buyer API key' },
      },
    },
  };
}

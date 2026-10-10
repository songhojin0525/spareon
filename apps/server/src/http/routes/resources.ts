/**
 * Routes over owned resources: a buyer's API keys and jobs, an owner's stores. `own` scope adds the
 * ownership condition to the query itself, so someone else's resource is indistinguishable from a
 * missing one (404, THREAT_MODEL BUY-06, WEB-04).
 */
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import {
  API_KEY_SCOPES,
  ApiKeyLimitError,
  ApiKeyOwnerError,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from '../../api-keys/api-keys.js';
import { recordAudit } from '../../audit/audit.js';
import { withTransaction } from '../../db/client.js';
import { jobs, models, stores } from '../../db/schema/index.js';
import { AppError, notFound } from '../../lib/errors.js';
import type { Principal, Router } from '../router.js';

const iso = z.iso.datetime();

function actorOf(p: Principal): { kind: 'operator' | 'owner' | 'buyer'; userId: string } {
  if (p.via === 'none') throw new Error('unreachable: anonymous actor');
  return { kind: p.role, userId: p.userId };
}

function userIdOf(p: Principal): string {
  if (p.via === 'none') throw new Error('unreachable: anonymous principal');
  return p.userId;
}

const apiKeySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  rateLimitRpm: z.number().int().nullable(),
  createdAt: iso,
  lastUsedAt: iso.nullable(),
  revokedAt: iso.nullable(),
});

const toIso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function registerResourceRoutes(router: Router): void {
  const { ctx } = router;

  router.add({
    action: 'api_keys.list',
    summary: 'List my API keys (prefix and metadata only, never the key)',
    tags: ['api-keys'],
    response: z.object({ data: z.array(apiKeySchema) }),
    handler: async ({ principal }) => {
      // The table allows only `own` for this action: always the caller's keys.
      const rows = await listApiKeys(ctx.db, userIdOf(principal));
      return {
        data: rows.map((k) => ({
          ...k,
          scopes: [...k.scopes],
          createdAt: k.createdAt.toISOString(),
          lastUsedAt: toIso(k.lastUsedAt),
          revokedAt: toIso(k.revokedAt),
        })),
      };
    },
  });

  router.add({
    action: 'api_keys.create',
    summary: 'Create an API key for myself; the key is in this response only',
    tags: ['api-keys'],
    successStatus: 201,
    errors: [400, 409],
    body: z.object({
      name: z.string().trim().min(1).max(100),
      scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length).optional(),
      rateLimitRpm: z.number().int().min(1).max(10_000).optional(),
    }),
    response: apiKeySchema.extend({ key: z.string() }),
    handler: async ({ principal, body, ipHash }) => {
      const actor = actorOf(principal);
      try {
        const created = await withTransaction(ctx.db, async (tx) => {
          const k = await createApiKey(tx, ctx.apiKeys, {
            userId: actor.userId,
            name: body.name,
            ...(body.scopes === undefined ? {} : { scopes: body.scopes }),
            ...(body.rateLimitRpm === undefined ? {} : { rateLimitRpm: body.rateLimitRpm }),
          });
          await recordAudit(tx, ctx, {
            actor,
            action: 'api_key.create',
            targetKind: 'api_key',
            targetId: k.id,
            data: { prefix: k.prefix, scopes: [...k.scopes], rateLimitRpm: k.rateLimitRpm },
            ipHash: ipHash(),
          });
          return k;
        });
        return {
          ...created,
          scopes: [...created.scopes],
          createdAt: created.createdAt.toISOString(),
          lastUsedAt: null,
          revokedAt: null,
        };
      } catch (err) {
        if (err instanceof ApiKeyLimitError) throw new AppError('too_many_keys', 409, err.message);
        if (err instanceof ApiKeyOwnerError) throw new AppError('forbidden', 403, err.message);
        throw err;
      }
    },
  });

  router.add({
    action: 'api_keys.revoke',
    summary: 'Revoke an API key (buyers: their own; operators: any)',
    tags: ['api-keys'],
    params: z.object({ keyId: z.uuid() }),
    errors: [404],
    response: z.object({ id: z.uuid(), prefix: z.string(), status: z.literal('revoked') }),
    handler: async ({ principal, scope, params, ipHash }) => {
      const actor = actorOf(principal);
      const revoked = await withTransaction(ctx.db, async (tx) => {
        const r = await revokeApiKey(tx, ctx, {
          keyId: params.keyId,
          ...(scope === 'own' ? { ownerUserId: actor.userId } : {}),
        });
        if (r === undefined) return undefined;
        await recordAudit(tx, ctx, {
          actor,
          action: 'api_key.revoke',
          targetKind: 'api_key',
          targetId: r.id,
          data: { prefix: r.prefix, ownerUserId: r.userId },
          ipHash: ipHash(),
        });
        return r;
      });
      if (revoked === undefined) throw notFound('No such active API key.');
      return { id: revoked.id, prefix: revoked.prefix, status: 'revoked' as const };
    },
  });

  const storeSchema = z.object({
    id: z.uuid(),
    name: z.string(),
    timezone: z.string(),
    verifiedAt: iso.nullable(),
    pausedAt: iso.nullable(),
    createdAt: iso,
  });
  const storeColumns = {
    id: stores.id,
    name: stores.name,
    timezone: stores.timezone,
    verifiedAt: stores.verifiedAt,
    pausedAt: stores.pausedAt,
    createdAt: stores.createdAt,
  };
  interface StoreRow {
    id: string;
    name: string;
    timezone: string;
    verifiedAt: Date | null;
    pausedAt: Date | null;
    createdAt: Date;
  }
  const storeOut = (s: StoreRow) => ({
    ...s,
    verifiedAt: toIso(s.verifiedAt),
    pausedAt: toIso(s.pausedAt),
    createdAt: s.createdAt.toISOString(),
  });

  router.add({
    action: 'stores.list',
    summary: 'List stores (owners: their own; operators: all)',
    tags: ['stores'],
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
    response: z.object({ data: z.array(storeSchema) }),
    handler: async ({ principal, scope, query }) => {
      const q = ctx.db.select(storeColumns).from(stores);
      const rows = await (scope === 'own' ? q.where(eq(stores.ownerId, userIdOf(principal))) : q)
        .orderBy(desc(stores.createdAt))
        .limit(query.limit);
      return { data: rows.map(storeOut) };
    },
  });

  router.add({
    action: 'stores.get',
    summary: 'One store (owners: only their own)',
    tags: ['stores'],
    params: z.object({ storeId: z.uuid() }),
    errors: [404],
    response: storeSchema,
    handler: async ({ principal, scope, params }) => {
      const where: SQL[] = [eq(stores.id, params.storeId)];
      if (scope === 'own') where.push(eq(stores.ownerId, userIdOf(principal)));
      const [s] = await ctx.db
        .select(storeColumns)
        .from(stores)
        .where(and(...where));
      if (s === undefined) throw notFound('No such store.');
      return storeOut(s);
    },
  });

  router.add({
    action: 'jobs.get',
    summary: 'Job metadata (buyers: only their own). Never the prompt or the output.',
    tags: ['jobs'],
    params: z.object({ jobId: z.uuid() }),
    errors: [404],
    response: z.object({
      id: z.uuid(),
      model: z.string(),
      status: z.string(),
      tokensIn: z.number().int().nullable(),
      tokensOut: z.number().int().nullable(),
      costUcr: z.string().nullable(),
      failureCode: z.string().nullable(),
      createdAt: iso,
      endedAt: iso.nullable(),
    }),
    handler: async ({ principal, scope, params }) => {
      const where: SQL[] = [eq(jobs.id, params.jobId)];
      if (scope === 'own') where.push(eq(jobs.buyerId, userIdOf(principal)));
      const [j] = await ctx.db
        .select({
          id: jobs.id,
          model: models.slug,
          status: jobs.status,
          tokensIn: jobs.tokensIn,
          tokensOut: jobs.tokensOut,
          costUcr: jobs.costUcr,
          failureCode: jobs.failureCode,
          createdAt: jobs.createdAt,
          endedAt: jobs.endedAt,
        })
        .from(jobs)
        .innerJoin(models, eq(models.id, jobs.modelId))
        .where(and(...where));
      if (j === undefined) throw notFound('No such job.');
      return {
        ...j,
        // Money is bigint minimal units: a decimal string on the wire, never a float.
        costUcr: j.costUcr === null ? null : j.costUcr.toString(),
        createdAt: j.createdAt.toISOString(),
        endedAt: toIso(j.endedAt),
      };
    },
  });
}

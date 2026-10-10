/** Operator routes: settings, audit trail, disabling accounts. Every change is audited. */
import { z } from 'zod';

import { listAudit, recordAudit } from '../../audit/audit.js';
import { disableUser, findUserById } from '../../auth/users.js';
import { withTransaction } from '../../db/client.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import {
  isSettingKey,
  readAllSettings,
  SETTINGS,
  SettingValueError,
  writeSetting,
} from '../../lib/settings.js';
import type { Principal, Router } from '../router.js';

function operatorId(p: Principal): string {
  if (p.via !== 'session' || p.role !== 'operator') throw new Error('unreachable: operator route');
  return p.userId;
}

export function registerOpsRoutes(router: Router): void {
  const { ctx } = router;

  router.add({
    action: 'ops.settings.list',
    summary: 'All operator settings with their current values',
    tags: ['ops'],
    response: z.object({
      data: z.array(
        z.object({
          key: z.string(),
          value: z.unknown(),
          invalidStored: z.unknown().optional(),
          description: z.string(),
        }),
      ),
    }),
    handler: async () => {
      const values = await readAllSettings(ctx.db);
      return {
        data: Object.entries(values).map(([key, v]) => ({
          key,
          ...v,
          description: isSettingKey(key) ? SETTINGS[key].description : '',
        })),
      };
    },
  });

  router.add({
    action: 'ops.settings.set',
    summary: 'Change one operator setting (validated against its schema, audited)',
    tags: ['ops'],
    params: z.object({ key: z.string().max(64) }),
    body: z.object({ value: z.unknown() }),
    errors: [400, 404],
    response: z.object({ key: z.string(), value: z.unknown() }),
    handler: async ({ principal, params, body, ipHash }) => {
      const key = params.key;
      if (!isSettingKey(key)) throw notFound('No such setting.');
      const actor = operatorId(principal);
      try {
        const r = await withTransaction(ctx.db, async (tx) => {
          const w = await writeSetting(tx, ctx.clock, key, body.value, actor);
          await recordAudit(tx, ctx, {
            actor: { kind: 'operator', userId: actor },
            action: 'settings.set',
            targetKind: 'setting',
            targetId: key,
            data: { previous: w.previous, value: w.value },
            ipHash: ipHash(),
          });
          return w;
        });
        ctx.settings.invalidate(key);
        return { key, value: r.value };
      } catch (err) {
        if (err instanceof SettingValueError) {
          throw badRequest('invalid_setting_value', `Invalid value for ${key}.`, {
            issues: [...err.issues],
          });
        }
        throw err;
      }
    },
  });

  router.add({
    action: 'ops.audit.list',
    summary: 'Audit trail, newest first',
    tags: ['ops'],
    query: z.object({
      limit: z.coerce.number().int().min(1).max(500).default(100),
      before: z.uuid().optional(),
    }),
    response: z.object({
      data: z.array(
        z.object({
          id: z.uuid(),
          at: z.iso.datetime(),
          actorKind: z.string(),
          actorUserId: z.uuid().nullable(),
          action: z.string(),
          targetKind: z.string().nullable(),
          targetId: z.string().nullable(),
          data: z.unknown(),
        }),
      ),
    }),
    handler: async ({ query }) => {
      const rows = await listAudit(ctx.db, {
        limit: query.limit,
        ...(query.before === undefined ? {} : { before: query.before }),
      });
      return { data: rows.map((r) => ({ ...r, at: r.at.toISOString() })) };
    },
  });

  router.add({
    action: 'ops.users.disable',
    summary: 'Disable an account: sessions end, API keys stop working',
    tags: ['ops'],
    params: z.object({ userId: z.uuid() }),
    errors: [400, 404],
    response: z.object({ id: z.uuid(), status: z.literal('disabled') }),
    handler: async ({ principal, params, ipHash }) => {
      const actor = operatorId(principal);
      if (params.userId === actor) {
        throw new AppError(
          'cannot_disable_self',
          400,
          'Operators cannot disable their own account.',
        );
      }
      const user = await findUserById(ctx.db, params.userId);
      if (user === undefined) throw notFound('No such user.');
      await withTransaction(ctx.db, async (tx) => {
        const changed = await disableUser(tx, ctx, user.id);
        await recordAudit(tx, ctx, {
          actor: { kind: 'operator', userId: actor },
          action: 'user.disable',
          targetKind: 'user',
          targetId: user.id,
          data: { role: user.role, alreadyDisabled: !changed },
          ipHash: ipHash(),
        });
      });
      return { id: user.id, status: 'disabled' as const };
    },
  });
}

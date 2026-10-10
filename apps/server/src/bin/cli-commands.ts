/**
 * Operator CLI commands (`pnpm --filter @spareon/server cli <command>`). Each write is recorded in
 * audit_log with actor_kind `system`, `via: cli` and the OS user who ran it. Secrets (passwords, API
 * keys) are printed once to stdout and never logged or audited.
 */
import { parseArgs } from 'node:util';

import {
  API_KEY_SCOPES,
  ApiKeyLimitError,
  ApiKeyOwnerError,
  type ApiKeyScope,
  createApiKey,
  findApiKeyByPrefix,
  revokeApiKey,
} from '../api-keys/api-keys.js';
import { listAudit, recordAudit } from '../audit/audit.js';
import { checkPasswordPolicy, hashPassword, PasswordPolicyError } from '../auth/password.js';
import {
  createUser,
  disableUser,
  emailSchema,
  EmailTakenError,
  findUserByEmail,
  setPasswordHash,
} from '../auth/users.js';
import type { ServerEnv } from '../config.js';
import { type Db, withTransaction } from '../db/client.js';
import { USER_ROLES, type UserRole } from '../db/schema/index.js';
import type { Clock } from '../lib/clock.js';
import { randomToken } from '../lib/crypto.js';
import type { Ids } from '../lib/ids.js';
import {
  isSettingKey,
  readAllSettings,
  readSetting,
  SETTING_KEYS,
  SETTINGS,
  SettingValueError,
  writeSetting,
} from '../lib/settings.js';

export interface CliDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly env: Pick<ServerEnv, 'API_KEY_PEPPER' | 'API_KEY_PEPPER_ID' | 'PAYMENTS_MODE'>;
  /** Who ran the command (OS user name), for the audit record. */
  readonly osUser: string;
  out(line: string): void;
  err(line: string): void;
  /** The password from stdin when --password-stdin is given. */
  readPassword(): Promise<string>;
}

export const USAGE = `usage: pnpm --filter @spareon/server cli <command> [options]
  user:create --role <operator|owner|buyer> --email <e> [--name <n>] [--password-stdin]
  user:disable --email <e>
  user:set-password --email <e> [--password-stdin]
  key:create --user <buyer email> [--name <n>] [--scopes chat,batch,models:read] [--rpm <n>]
  key:revoke --prefix <sp_test_xxxxxxxx>
  settings:get [<key>]
  settings:set <key> <json value>
  audit:tail [--limit <n>]
Without --password-stdin a random password is generated and printed once.`;

class CliError extends Error {}

const OPTIONS = {
  role: { type: 'string' },
  email: { type: 'string' },
  name: { type: 'string' },
  user: { type: 'string' },
  scopes: { type: 'string' },
  rpm: { type: 'string' },
  prefix: { type: 'string' },
  limit: { type: 'string' },
  'password-stdin': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

function need(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === '') throw new CliError(`missing --${flag}`);
  return value;
}

function positiveInt(value: string, flag: string): number {
  if (!/^[1-9][0-9]{0,6}$/.test(value)) throw new CliError(`--${flag} must be a positive integer`);
  return Number(value);
}

/** Run one command; returns the process exit code. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    const [command, ...rest] = positionals;
    if (values.help || command === undefined) {
      deps.out(USAGE);
      return command === undefined && !values.help ? 1 : 0;
    }
    const actor = { kind: 'system' as const, via: 'cli' };
    const data = { osUser: deps.osUser };
    const password = async (): Promise<{ value: string; generated: boolean }> => {
      if (values['password-stdin']) {
        const p = (await deps.readPassword()).replace(/\r?\n$/, '');
        checkPasswordPolicy(p);
        return { value: p, generated: false };
      }
      return { value: randomToken(18), generated: true };
    };
    const userByEmail = async (email: string) => {
      const u = await findUserByEmail(deps.db, email);
      if (u === undefined) throw new CliError(`no user with email ${email}`);
      return u;
    };

    switch (command) {
      case 'user:create': {
        const role = need(values.role, 'role');
        if (!(USER_ROLES as readonly string[]).includes(role)) {
          throw new CliError(`--role must be one of ${USER_ROLES.join(', ')}`);
        }
        const parsedEmail = emailSchema.safeParse(need(values.email, 'email'));
        if (!parsedEmail.success) throw new CliError('--email is not an email address');
        const pw = await password();
        const passwordHash = await hashPassword(pw.value);
        const id = await withTransaction(deps.db, async (tx) => {
          const userId = await createUser(tx, deps, {
            email: parsedEmail.data,
            role: role as UserRole,
            displayName: values.name ?? parsedEmail.data,
            passwordHash,
          });
          await recordAudit(tx, deps, {
            actor,
            action: 'user.create',
            targetKind: 'user',
            targetId: userId,
            data: { ...data, role },
          });
          return userId;
        });
        deps.out(`created ${role} ${parsedEmail.data.toLowerCase()} (${id})`);
        if (pw.generated) deps.out(`password (shown once): ${pw.value}`);
        return 0;
      }
      case 'user:disable': {
        const u = await userByEmail(need(values.email, 'email'));
        await withTransaction(deps.db, async (tx) => {
          const changed = await disableUser(tx, deps, u.id);
          await recordAudit(tx, deps, {
            actor,
            action: 'user.disable',
            targetKind: 'user',
            targetId: u.id,
            data: { ...data, alreadyDisabled: !changed },
          });
        });
        deps.out(`disabled ${u.email}: sessions ended, API keys stop working`);
        return 0;
      }
      case 'user:set-password': {
        const u = await userByEmail(need(values.email, 'email'));
        const pw = await password();
        const hash = await hashPassword(pw.value);
        await withTransaction(deps.db, async (tx) => {
          await setPasswordHash(tx, deps, u.id, hash);
          await recordAudit(tx, deps, {
            actor,
            action: 'user.set_password',
            targetKind: 'user',
            targetId: u.id,
            data,
          });
        });
        deps.out(`password of ${u.email} replaced; every session ended`);
        if (pw.generated) deps.out(`password (shown once): ${pw.value}`);
        return 0;
      }
      case 'key:create': {
        const u = await userByEmail(need(values.user, 'user'));
        const scopes = values.scopes?.split(',').map((s) => s.trim());
        if (scopes?.some((s) => !(API_KEY_SCOPES as readonly string[]).includes(s)) === true) {
          throw new CliError(`--scopes must be from ${API_KEY_SCOPES.join(', ')}`);
        }
        const rpm = values.rpm === undefined ? undefined : positiveInt(values.rpm, 'rpm');
        const k = await withTransaction(deps.db, async (tx) => {
          const created = await createApiKey(
            tx,
            {
              clock: deps.clock,
              ids: deps.ids,
              pepper: deps.env.API_KEY_PEPPER,
              pepperId: deps.env.API_KEY_PEPPER_ID,
              mode: deps.env.PAYMENTS_MODE,
            },
            {
              userId: u.id,
              name: values.name ?? 'cli',
              ...(scopes === undefined ? {} : { scopes: scopes as ApiKeyScope[] }),
              ...(rpm === undefined ? {} : { rateLimitRpm: rpm }),
            },
          );
          await recordAudit(tx, deps, {
            actor,
            action: 'api_key.create',
            targetKind: 'api_key',
            targetId: created.id,
            data: { ...data, prefix: created.prefix, ownerUserId: u.id },
          });
          return created;
        });
        deps.out(`created key ${k.prefix} for ${u.email} (scopes ${k.scopes.join(',')})`);
        deps.out(`API key (shown once): ${k.key}`);
        return 0;
      }
      case 'key:revoke': {
        const prefix = need(values.prefix, 'prefix');
        const found = await findApiKeyByPrefix(deps.db, prefix);
        if (found === undefined) throw new CliError(`no key with prefix ${prefix}`);
        const revoked = await withTransaction(deps.db, async (tx) => {
          const r = await revokeApiKey(tx, deps, { keyId: found.id });
          if (r !== undefined) {
            await recordAudit(tx, deps, {
              actor,
              action: 'api_key.revoke',
              targetKind: 'api_key',
              targetId: r.id,
              data: { ...data, prefix: r.prefix, ownerUserId: r.userId },
            });
          }
          return r;
        });
        deps.out(revoked === undefined ? `${prefix} was already revoked` : `revoked ${prefix}`);
        return 0;
      }
      case 'settings:get': {
        const [key] = rest;
        if (key === undefined) {
          const all = await readAllSettings(deps.db);
          for (const k of SETTING_KEYS) {
            const v = all[k];
            const bad =
              v.invalidStored === undefined
                ? ''
                : ` (stored ${JSON.stringify(v.invalidStored)} is invalid and ignored)`;
            deps.out(`${k} = ${JSON.stringify(v.value)}${bad}  # ${SETTINGS[k].description}`);
          }
          return 0;
        }
        if (!isSettingKey(key))
          throw new CliError(`unknown setting ${key} (known: ${SETTING_KEYS.join(', ')})`);
        deps.out(JSON.stringify(await readSetting(deps.db, key)));
        return 0;
      }
      case 'settings:set': {
        const [key, raw] = rest;
        if (key === undefined || raw === undefined)
          throw new CliError('usage: settings:set <key> <json value>');
        if (!isSettingKey(key))
          throw new CliError(`unknown setting ${key} (known: ${SETTING_KEYS.join(', ')})`);
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          throw new CliError('the value must be JSON (e.g. true, 60, "text")');
        }
        const w = await withTransaction(deps.db, async (tx) => {
          const r = await writeSetting(tx, deps.clock, key, value, null);
          await recordAudit(tx, deps, {
            actor,
            action: 'settings.set',
            targetKind: 'setting',
            targetId: key,
            data: { ...data, previous: r.previous, value: r.value },
          });
          return r;
        });
        deps.out(
          `${key}: ${JSON.stringify(w.previous)} -> ${JSON.stringify(w.value)} (servers see it within 5 s)`,
        );
        return 0;
      }
      case 'audit:tail': {
        const limit = values.limit === undefined ? 20 : positiveInt(values.limit, 'limit');
        const rows = await listAudit(deps.db, { limit: Math.min(limit, 1000) });
        for (const r of rows.reverse()) {
          deps.out(
            `${r.at.toISOString()} ${r.actorKind}${r.actorUserId === null ? '' : `:${r.actorUserId}`} ${r.action}` +
              `${r.targetKind === null ? '' : ` ${r.targetKind}:${r.targetId ?? ''}`} ${JSON.stringify(r.data)}`,
          );
        }
        return 0;
      }
      default:
        throw new CliError(`unknown command ${command}\n${USAGE}`);
    }
  } catch (err) {
    if (
      err instanceof CliError ||
      err instanceof PasswordPolicyError ||
      err instanceof ApiKeyOwnerError ||
      err instanceof ApiKeyLimitError
    ) {
      deps.err(err.message);
      return 1;
    }
    if (err instanceof EmailTakenError) {
      deps.err('a user with this email already exists');
      return 1;
    }
    if (err instanceof SettingValueError) {
      deps.err(`invalid value: ${err.issues.join('; ')}`);
      return 1;
    }
    if (
      err instanceof Error &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
    ) {
      deps.err(err.message);
      return 1;
    }
    throw err;
  }
}

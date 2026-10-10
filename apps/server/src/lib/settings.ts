/**
 * Runtime settings an operator may change (CLI `settings:set`, `PUT /api/ops/settings/:key`). Only keys in
 * this registry can be written, and each value is validated by its schema, so a typo or a bad value
 * cannot reach the running server. Unset keys read as their default. Internal records that also live
 * in the `settings` table (e.g. `dev.skeleton`) are not in the registry and cannot be changed this way.
 */
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { Db, Tx } from '../db/client.js';
import { settings } from '../db/schema/index.js';
import type { Clock } from './clock.js';

export const SETTINGS = {
  'auth.signup_enabled': {
    schema: z.boolean(),
    default: true,
    description: 'Whether new owner and buyer accounts can sign up on the web.',
  },
  'api_keys.default_rpm': {
    schema: z.number().int().min(1).max(100_000),
    default: 60,
    description: 'Requests per minute for an API key without its own limit.',
  },
  'api_keys.default_concurrency': {
    schema: z.number().int().min(1).max(256),
    default: 4,
    description: 'Concurrent requests per API key.',
  },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]['schema']>;

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

export class SettingValueError extends Error {
  constructor(
    readonly key: string,
    readonly issues: readonly string[],
  ) {
    super(`invalid value for ${key}: ${issues.join('; ')}`);
    this.name = 'SettingValueError';
  }
}

export function parseSettingValue<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
  const r = SETTINGS[key].schema.safeParse(value);
  if (!r.success)
    throw new SettingValueError(
      key,
      r.error.issues.map((i) => i.message),
    );
  return r.data as SettingValue<K>;
}

/**
 * Reads settings with a short cache (default 5 s), so per-request checks do not each hit the database.
 * A write through this object clears its cache at once; a write from another process (the CLI) is seen
 * within the cache time.
 */
export class SettingsStore {
  readonly #cache = new Map<SettingKey, { value: unknown; at: number }>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly ttlMs = 5_000,
  ) {}

  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const now = this.clock.now().getTime();
    const hit = this.#cache.get(key);
    if (hit !== undefined && now - hit.at < this.ttlMs) return hit.value as SettingValue<K>;
    const value = await readSetting(this.db, key);
    this.#cache.set(key, { value, at: now });
    return value;
  }

  invalidate(key?: SettingKey): void {
    if (key === undefined) this.#cache.clear();
    else this.#cache.delete(key);
  }
}

/** The stored value, or the default when unset. A stored value that no longer validates reads as the default. */
export async function readSetting<K extends SettingKey>(
  db: Db | Tx,
  key: K,
): Promise<SettingValue<K>> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key));
  if (row === undefined) return SETTINGS[key].default as SettingValue<K>;
  const r = SETTINGS[key].schema.safeParse(row.value);
  return (r.success ? r.data : SETTINGS[key].default) as SettingValue<K>;
}

export async function readAllSettings(db: Db | Tx): Promise<Record<SettingKey, unknown>> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, SETTING_KEYS));
  const out = Object.fromEntries(SETTING_KEYS.map((k) => [k, SETTINGS[k].default])) as Record<
    SettingKey,
    unknown
  >;
  for (const r of rows) if (isSettingKey(r.key)) out[r.key] = r.value;
  return out;
}

/** Validate and store; returns the previous value (for the audit record). */
export async function writeSetting<K extends SettingKey>(
  tx: Tx,
  clock: Clock,
  key: K,
  value: unknown,
  updatedBy: string | null,
): Promise<{ previous: unknown; value: SettingValue<K> }> {
  const parsed = parseSettingValue(key, value);
  const previous = await readSetting(tx, key);
  const now = clock.now();
  await tx
    .insert(settings)
    .values({ key, value: parsed, updatedAt: now, updatedBy })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: parsed, updatedAt: now, updatedBy },
    });
  return { previous, value: parsed };
}

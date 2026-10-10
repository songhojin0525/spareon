import { z } from 'zod';

const devSecret = z
  .string()
  .regex(
    /^[\x21-\x7e]{24,256}$/,
    'must be 24..256 printable ASCII characters without spaces (no default on purpose)',
  );

/** Environment variables the server reads. Validated at the boundary; never read process.env elsewhere. */
const envSchema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(8080),
  /**
   * Unset counts as production: development conveniences (dev dashboard, dev credentials) must be
   * switched on explicitly and can never be on in production (S04 review point "demo settings").
   */
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgres:// URL')
    .optional(),
  /**
   * The server always runs its database sessions as this role (S03: least privilege, triggers cannot
   * be disabled), even when the connection URL names a more powerful login. Only binjari_app is
   * accepted: the variable exists so a wrong value fails loudly instead of being ignored.
   */
  DB_ROLE: z.literal('binjari_app').default('binjari_app'),
  // SKELETON(S05): one development API key stands in for buyer accounts and API keys.
  DEV_API_KEY: devSecret.optional(),
  // SKELETON(S11): agents authenticate with keys derived from this shared secret instead of enrollment.
  DEV_AGENT_SECRET: devSecret.optional(),
  DEV_DASHBOARD: z.enum(['0', '1']).optional(),
  /** AES-256-GCM key for buyer content at rest (job_payloads), 64 lowercase hex characters. */
  DATA_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters')
    .optional(),
  DATA_ENCRYPTION_KEY_ID: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
    .default('k1'),
});

export type ServerEnv = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  readonly code = 'CONFIG_INVALID';
  constructor(readonly issues: readonly string[]) {
    super(`Invalid server configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
  }
}

export function parseEnv(env: Readonly<Record<string, string | undefined>>): ServerEnv {
  // Empty values count as unset (a blank line in .env must not become a credential).
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const cfg = result.data;
  const issues: string[] = [];
  if (cfg.NODE_ENV === 'production') {
    // Demo settings must never become production defaults (S04 adversarial review point).
    for (const key of ['DEV_API_KEY', 'DEV_AGENT_SECRET'] as const) {
      if (cfg[key] !== undefined)
        issues.push(`${key}: development credentials are refused in production`);
    }
    if (cfg.DEV_DASHBOARD === '1')
      issues.push('DEV_DASHBOARD: the dev dashboard is refused in production');
  }
  if (cfg.DEV_API_KEY !== undefined && cfg.DEV_API_KEY === cfg.DEV_AGENT_SECRET) {
    issues.push('DEV_AGENT_SECRET: must differ from DEV_API_KEY');
  }
  if (issues.length > 0) throw new ConfigError(issues);
  return cfg;
}

/** The /dev dashboard is registered only in development or with DEV_DASHBOARD=1 (never in production). */
export function devDashboardEnabled(cfg: Pick<ServerEnv, 'NODE_ENV' | 'DEV_DASHBOARD'>): boolean {
  return cfg.NODE_ENV === 'development' || cfg.DEV_DASHBOARD === '1';
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** True when HOST exposes the server beyond this machine (LAN demo); callers log a warning. */
export function isNonLoopbackHost(host: string): boolean {
  return !LOOPBACK_HOSTS.has(host);
}

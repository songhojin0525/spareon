import { z } from 'zod';

const secret = (min: number, what: string) =>
  z
    .string()
    .regex(
      new RegExp(`^[\\x21-\\x7e]{${String(min)},512}$`),
      `must be ${String(min)}..512 printable ASCII characters without spaces (${what})`,
    );

const KEY_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** http(s) URL without credentials, query or fragment. */
const baseUrl = z
  .string()
  .regex(
    /^https?:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/,
    'must be an http(s) URL without query or fragment',
  );

/** An origin exactly as browsers send it in the Origin header: scheme://host[:port], no path. */
const origin = z
  .string()
  .regex(/^https?:\/\/[^\s/?#@]+$/, 'must be an origin like https://app.example.com (no path)');

const days = (def: number, max: number) => z.coerce.number().int().min(1).max(max).default(def);

/**
 * Environment variables the server reads. Validated at the boundary; never read process.env elsewhere.
 * Every variable carries a description: `pnpm --filter @spareon/server env:example` writes
 * apps/server/.env.example from them (a test keeps the file current).
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production').meta({
    description:
      'development | test | production. Unset counts as production: development conveniences must be switched on explicitly.',
  }),
  HOST: z
    .string()
    .min(1)
    .default('127.0.0.1')
    .meta({ description: 'Listen address. 0.0.0.0 opens the server to the network.' }),
  PORT: z.coerce
    .number()
    .int()
    .min(0)
    .max(65_535)
    .default(8080)
    .meta({ description: 'Listen port.' }),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info')
    .meta({
      description: 'pino log level. Buyer content and credentials are redacted at every level.',
    }),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL')
    .meta({ description: 'PostgreSQL connection URL (session mode: the scheduler holds a lock).' }),
  /**
   * The server always runs its database sessions as this role (S03: least privilege, triggers cannot
   * be disabled), even when the connection URL names a more powerful login. Only spareon_app is
   * accepted: the variable exists so a wrong value fails loudly instead of being ignored.
   */
  DB_ROLE: z
    .literal('spareon_app')
    .default('spareon_app')
    .meta({ description: 'Database role every session runs as. Only spareon_app is accepted.' }),
  SESSION_SECRET: secret(32, 'session secret').meta({
    description:
      'Secret for CSRF tokens, IP hashes and idempotency request hashes (32+ printable characters). Changing it invalidates CSRF tokens and makes idempotency keys of the last 24 h answer 409 instead of replaying.',
    example: "generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  }),
  SESSION_IDLE_DAYS: days(7, 90).meta({
    description: 'A login session ends after this many days without use (T34).',
  }),
  SESSION_ABSOLUTE_DAYS: days(30, 365).meta({
    description: 'A login session ends this many days after login, used or not (T34).',
  }),
  API_KEY_PEPPER: secret(32, 'API key pepper').meta({
    description:
      'HMAC key for stored buyer API key hashes (32+ printable characters). Losing it invalidates every API key.',
    example: "generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  }),
  API_KEY_PEPPER_ID: z
    .string()
    .regex(KEY_ID, 'must be a short lowercase id like p1')
    .default('p1')
    .meta({ description: 'Id of API_KEY_PEPPER, stored with each key hash (rotation).' }),
  /** AES-256-GCM key for buyer content at rest (job_payloads), 64 lowercase hex characters. */
  DATA_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters')
    .meta({
      description:
        'AES-256-GCM key for buyer content at rest (64 lowercase hex). Keep it apart from database backups.',
      example:
        "generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    }),
  DATA_ENCRYPTION_KEY_ID: z.string().regex(KEY_ID, 'must be a short lowercase id like k1').meta({
    description: 'Id of DATA_ENCRYPTION_KEY, stored with each ciphertext.',
    example: 'k1',
  }),
  PUBLIC_BASE_URL: baseUrl.meta({
    description:
      'Public URL of this server (buyer API and agents connect here). https in production.',
    example: 'https://api.example.com',
  }),
  WEB_ORIGIN: origin.meta({
    description:
      'Origin of the web app. State-changing cookie requests must come from it (CSRF). https in production.',
    example: 'https://app.example.com',
  }),
  TRUST_PROXY: z
    .string()
    .regex(/^[0-9a-fA-F.:/]+(,[0-9a-fA-F.:/]+)*$/, 'must be a comma-separated list of IPs or CIDRs')
    .optional()
    .meta({
      description:
        'Proxies whose X-Forwarded-For is trusted (comma-separated IPs/CIDRs, ADR 0012). Unset: the socket address is the client.',
    }),
  PAYMENTS_MODE: z
    .enum(['test', 'live'])
    .default('test')
    .meta({ description: 'Only test is allowed: live refuses to start (absolute rule 2).' }),
  CASHOUT_ENABLED: z.enum(['true', 'false', '1', '0']).optional().meta({
    description:
      'Must stay unset or false: true refuses to start (no cash-out before legal review).',
  }),
  EXTERNAL_PROVIDERS: z
    .enum(['mock', 'anthropic'])
    .default('mock')
    .meta({ description: 'External model providers. Only mock is available until S16.' }),
  // SKELETON(S11): agents authenticate with keys derived from this shared secret instead of enrollment.
  DEV_AGENT_SECRET: secret(24, 'no default on purpose').optional().meta({
    description: 'Development only: shared secret for demo agents. Refused in production.',
  }),
  DEV_DASHBOARD: z.enum(['0', '1']).optional().meta({
    description: 'Development only: 1 enables /dev outside development. Refused in production.',
  }),
  /** Removed in S05; present only so an old .env fails loudly instead of being silently ignored. */
  DEV_API_KEY: z.string().optional().meta({
    description: 'Removed in S05: must be unset (buyer API keys are created with the CLI).',
  }),
});

export type ServerEnv = Omit<z.infer<typeof envSchema>, 'DEV_API_KEY'>;

export class ConfigError extends Error {
  readonly code = 'CONFIG_INVALID';
  constructor(readonly issues: readonly string[]) {
    super(`Invalid server configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
  }
}

const TRUE_VALUES = new Set(['true', '1']);

/**
 * Parse and check the environment. Messages name the variable and the rule, never the value (values
 * are secrets). Throws ConfigError with every problem at once.
 */
export function parseEnv(env: Readonly<Record<string, string | undefined>>): ServerEnv {
  // Empty values count as unset (a blank line in .env must not become a credential).
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`),
    );
  }
  const { DEV_API_KEY, ...cfg } = result.data;
  const issues: string[] = [];
  // Safety switches (absolute rule 2): checked in every environment, tests included.
  if (cfg.PAYMENTS_MODE === 'live') {
    issues.push('PAYMENTS_MODE: live payments are not available in v0.1; use test');
  }
  if (cfg.CASHOUT_ENABLED !== undefined && TRUE_VALUES.has(cfg.CASHOUT_ENABLED)) {
    issues.push(
      'CASHOUT_ENABLED: there is no cash-out feature before legal review (manual settlement records only)',
    );
  }
  if (cfg.EXTERNAL_PROVIDERS !== 'mock') {
    issues.push('EXTERNAL_PROVIDERS: only mock is available until S16 (three explicit switches)');
  }
  if (DEV_API_KEY !== undefined) {
    issues.push(
      'DEV_API_KEY: removed in S05; create a buyer API key with `pnpm --filter @spareon/server cli key:create` (the dev server prints one)',
    );
  }
  if (cfg.SESSION_IDLE_DAYS > cfg.SESSION_ABSOLUTE_DAYS) {
    issues.push('SESSION_IDLE_DAYS: must not exceed SESSION_ABSOLUTE_DAYS');
  }
  if (cfg.SESSION_SECRET === cfg.API_KEY_PEPPER) {
    issues.push('API_KEY_PEPPER: must differ from SESSION_SECRET');
  }
  if (cfg.NODE_ENV === 'production') {
    // Demo settings must never become production defaults (S04 adversarial review point).
    if (cfg.DEV_AGENT_SECRET !== undefined)
      issues.push('DEV_AGENT_SECRET: development credentials are refused in production');
    if (cfg.DEV_DASHBOARD === '1')
      issues.push('DEV_DASHBOARD: the dev dashboard is refused in production');
    if (!cfg.WEB_ORIGIN.startsWith('https://'))
      issues.push('WEB_ORIGIN: must be https in production (Secure cookies)');
    if (!cfg.PUBLIC_BASE_URL.startsWith('https://'))
      issues.push('PUBLIC_BASE_URL: must be https in production');
  }
  if (cfg.DEV_AGENT_SECRET !== undefined && cfg.DEV_AGENT_SECRET === cfg.SESSION_SECRET) {
    issues.push('DEV_AGENT_SECRET: must differ from SESSION_SECRET');
  }
  if (issues.length > 0) throw new ConfigError(issues);
  return cfg;
}

/** The /dev dashboard is registered only in development or with DEV_DASHBOARD=1 (never in production). */
export function devDashboardEnabled(cfg: Pick<ServerEnv, 'NODE_ENV' | 'DEV_DASHBOARD'>): boolean {
  return cfg.NODE_ENV === 'development' || cfg.DEV_DASHBOARD === '1';
}

/** Cookies get Secure (and the __Host- prefix) when the web app is served over https. */
export function secureCookies(cfg: Pick<ServerEnv, 'WEB_ORIGIN'>): boolean {
  return cfg.WEB_ORIGIN.startsWith('https://');
}

/** Fastify trustProxy value: only the listed proxies may set X-Forwarded-For (ADR 0012). */
export function trustProxyList(cfg: Pick<ServerEnv, 'TRUST_PROXY'>): string[] | false {
  return cfg.TRUST_PROXY === undefined ? false : cfg.TRUST_PROXY.split(',');
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** True when HOST exposes the server beyond this machine (LAN demo); callers log a warning. */
export function isNonLoopbackHost(host: string): boolean {
  return !LOOPBACK_HOSTS.has(host);
}

/** One line per variable for .env.example: description comment, then NAME= (with a safe example). */
export function renderEnvExample(): string {
  const lines = [
    '# Spareon server environment (apps/server). Generated by `pnpm --filter @spareon/server env:example`',
    '# from src/config.ts — edit the descriptions there, not here. Copy to .env and fill in; never commit .env.',
    '',
  ];
  for (const [name, schema] of Object.entries(envSchema.shape)) {
    const meta = (schema as z.ZodType).meta() as
      { description?: string; example?: string } | undefined;
    const unset = (schema as z.ZodType).safeParse(undefined);
    const dflt =
      unset.success && unset.data !== undefined
        ? ` Default: ${JSON.stringify(unset.data).replace(/^"|"$/g, '')}.`
        : '';
    lines.push(`# ${meta?.description ?? ''}${unset.success ? dflt : ' (required)'}`);
    if (meta?.example?.startsWith('generate:') === true) {
      lines.push(`# ${meta.example}`);
      lines.push(`${name}=`);
    } else {
      lines.push(`${name}=${meta?.example ?? ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

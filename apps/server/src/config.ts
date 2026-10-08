import { z } from 'zod';

/** Environment variables the server reads. Validated at the boundary; never read process.env elsewhere. */
const envSchema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(8080),
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
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  return result.data;
}

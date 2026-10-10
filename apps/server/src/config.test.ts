import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  devDashboardEnabled,
  isNonLoopbackHost,
  parseEnv,
  renderEnvExample,
  secureCookies,
  trustProxyList,
} from './config.js';

const SECRET = 'dev-agent-secret-0123456789abcdef';
const SESSION = 's'.repeat(40);
const PEPPER = 'p'.repeat(40);
const DEK = 'ab'.repeat(32);

/** A complete, valid environment (production unless NODE_ENV says otherwise). */
const BASE = {
  DATABASE_URL: 'postgres://u:pw@db.internal:5432/spareon',
  SESSION_SECRET: SESSION,
  API_KEY_PEPPER: PEPPER,
  DATA_ENCRYPTION_KEY: DEK,
  DATA_ENCRYPTION_KEY_ID: 'k1',
  PUBLIC_BASE_URL: 'https://api.example.com',
  WEB_ORIGIN: 'https://app.example.com',
};

const DEV = { ...BASE, NODE_ENV: 'development', WEB_ORIGIN: 'http://localhost:3000' };

function issuesOf(env: Record<string, string>): string[] {
  try {
    parseEnv(env);
  } catch (err) {
    if (err instanceof ConfigError) return [...err.issues];
    throw err;
  }
  return [];
}

describe('parseEnv', () => {
  it('applies safe defaults when optional variables are absent', () => {
    const cfg = parseEnv(BASE);
    expect(cfg).toMatchObject({
      HOST: '127.0.0.1',
      PORT: 8080,
      NODE_ENV: 'production',
      DB_ROLE: 'spareon_app',
      PAYMENTS_MODE: 'test',
      EXTERNAL_PROVIDERS: 'mock',
      SESSION_IDLE_DAYS: 7,
      SESSION_ABSOLUTE_DAYS: 30,
      API_KEY_PEPPER_ID: 'p1',
      LOG_LEVEL: 'info',
    });
    expect(cfg.DEV_AGENT_SECRET).toBeUndefined();
    expect(cfg.CASHOUT_ENABLED).toBeUndefined();
  });

  it.each([
    'DATABASE_URL',
    'SESSION_SECRET',
    'API_KEY_PEPPER',
    'DATA_ENCRYPTION_KEY',
    'DATA_ENCRYPTION_KEY_ID',
    'PUBLIC_BASE_URL',
    'WEB_ORIGIN',
  ])('requires %s and names it in the error', (name) => {
    const env = Object.fromEntries(Object.entries(BASE).filter(([k]) => k !== name));
    const issues = issuesOf(env);
    expect(issues.some((i) => i.startsWith(`${name}:`))).toBe(true);
  });

  it('reports every problem at once, by name and rule, never by value', () => {
    const leaked = 'leaky-secret-value-should-not-appear';
    const issues = issuesOf({
      ...BASE,
      SESSION_SECRET: 'short',
      API_KEY_PEPPER: leaked + ' with spaces',
      DATA_ENCRYPTION_KEY: leaked,
      DATABASE_URL: `mysql://${leaked}`,
    });
    expect(issues.length).toBeGreaterThanOrEqual(4);
    const text = issues.join('\n');
    expect(text).not.toContain(leaked);
    expect(text).not.toContain('short');
  });

  it('coerces PORT from string', () => {
    expect(parseEnv({ ...BASE, PORT: '3000', HOST: '0.0.0.0' })).toMatchObject({
      HOST: '0.0.0.0',
      PORT: 3000,
    });
  });

  it.each(['-1', '65536', 'abc', '80.5'])('rejects invalid PORT %s with a typed error', (port) => {
    expect(() => parseEnv({ ...BASE, PORT: port })).toThrow(ConfigError);
  });

  it('accepts only the least-privilege database role', () => {
    expect(parseEnv({ ...BASE, DB_ROLE: 'spareon_app' }).DB_ROLE).toBe('spareon_app');
    expect(() => parseEnv({ ...BASE, DB_ROLE: 'postgres' })).toThrow(ConfigError);
  });

  describe('safety switches (absolute rule 2)', () => {
    it('refuses PAYMENTS_MODE=live in every environment', () => {
      expect(issuesOf({ ...BASE, PAYMENTS_MODE: 'live' }).join()).toMatch(/PAYMENTS_MODE/);
      expect(() => parseEnv({ ...DEV, PAYMENTS_MODE: 'live' })).toThrow(ConfigError);
      expect(() => parseEnv({ ...BASE, PAYMENTS_MODE: 'real' })).toThrow(ConfigError);
    });

    it.each(['true', '1'])('refuses CASHOUT_ENABLED=%s with the legal-review message', (v) => {
      expect(issuesOf({ ...BASE, CASHOUT_ENABLED: v }).join()).toMatch(/legal review/);
      expect(() => parseEnv({ ...DEV, CASHOUT_ENABLED: v })).toThrow(ConfigError);
    });

    it.each(['false', '0'])('accepts CASHOUT_ENABLED=%s', (v) => {
      expect(parseEnv({ ...BASE, CASHOUT_ENABLED: v }).CASHOUT_ENABLED).toBe(v);
    });

    it('rejects unknown CASHOUT_ENABLED values instead of guessing', () => {
      expect(() => parseEnv({ ...BASE, CASHOUT_ENABLED: 'yes' })).toThrow(ConfigError);
    });

    it('allows only the mock external provider until S16', () => {
      expect(parseEnv(BASE).EXTERNAL_PROVIDERS).toBe('mock');
      expect(issuesOf({ ...BASE, EXTERNAL_PROVIDERS: 'anthropic' }).join()).toMatch(/S16/);
    });
  });

  describe('development settings', () => {
    it('accepts development credentials in development', () => {
      expect(parseEnv({ ...DEV, DEV_AGENT_SECRET: SECRET }).DEV_AGENT_SECRET).toBe(SECRET);
    });

    it.each([{ DEV_AGENT_SECRET: SECRET }, { DEV_DASHBOARD: '1' }])(
      'refuses development settings in production (also when NODE_ENV is unset): %o',
      (extra) => {
        expect(() => parseEnv({ ...BASE, ...extra })).toThrow(ConfigError);
        expect(() => parseEnv({ ...BASE, NODE_ENV: 'production', ...extra })).toThrow(/production/);
      },
    );

    it('refuses the removed DEV_API_KEY with a pointer to the CLI', () => {
      expect(issuesOf({ ...DEV, DEV_API_KEY: 'x'.repeat(30) }).join()).toMatch(/key:create/);
    });

    it.each(['short', 'has spaces in the middle of it!!', 'é'.repeat(30)])(
      'rejects weak or malformed dev credentials (%s)',
      (value) => {
        expect(() => parseEnv({ ...DEV, DEV_AGENT_SECRET: value })).toThrow(ConfigError);
      },
    );

    it('treats blank values as unset', () => {
      expect(parseEnv({ ...DEV, DEV_AGENT_SECRET: '  ' }).DEV_AGENT_SECRET).toBeUndefined();
    });
  });

  it('requires https origins in production, allows http in development', () => {
    expect(issuesOf({ ...BASE, WEB_ORIGIN: 'http://app.example.com' }).join()).toMatch(/https/);
    expect(issuesOf({ ...BASE, PUBLIC_BASE_URL: 'http://api.example.com' }).join()).toMatch(
      /https/,
    );
    expect(parseEnv(DEV).WEB_ORIGIN).toBe('http://localhost:3000');
  });

  it('accepts an origin only (no path) for WEB_ORIGIN', () => {
    expect(() => parseEnv({ ...BASE, WEB_ORIGIN: 'https://app.example.com/login' })).toThrow(
      ConfigError,
    );
  });

  it('rejects reused secrets and an idle limit above the absolute limit', () => {
    expect(issuesOf({ ...BASE, API_KEY_PEPPER: SESSION }).join()).toMatch(/differ/);
    expect(issuesOf({ ...DEV, DEV_AGENT_SECRET: SESSION }).join()).toMatch(/differ/);
    expect(
      issuesOf({ ...BASE, SESSION_IDLE_DAYS: '40', SESSION_ABSOLUTE_DAYS: '30' }).join(),
    ).toMatch(/SESSION_IDLE_DAYS/);
  });

  it('validates the data encryption key', () => {
    expect(() => parseEnv({ ...BASE, DATA_ENCRYPTION_KEY: 'zz' })).toThrow(ConfigError);
    expect(parseEnv(BASE).DATA_ENCRYPTION_KEY).toBe(DEK);
  });
});

describe('derived settings', () => {
  it('turns the dev dashboard on only in development or with DEV_DASHBOARD=1', () => {
    expect(devDashboardEnabled(parseEnv(BASE))).toBe(false);
    expect(devDashboardEnabled(parseEnv({ ...DEV, NODE_ENV: 'test' }))).toBe(false);
    expect(devDashboardEnabled(parseEnv(DEV))).toBe(true);
    expect(devDashboardEnabled(parseEnv({ ...DEV, NODE_ENV: 'test', DEV_DASHBOARD: '1' }))).toBe(
      true,
    );
  });

  it('uses Secure cookies exactly when the web origin is https', () => {
    expect(secureCookies(parseEnv(BASE))).toBe(true);
    expect(secureCookies(parseEnv(DEV))).toBe(false);
  });

  it('trusts X-Forwarded-For only from listed proxies', () => {
    expect(trustProxyList(parseEnv(BASE))).toBe(false);
    expect(trustProxyList(parseEnv({ ...BASE, TRUST_PROXY: '10.0.0.0/8,127.0.0.1' }))).toEqual([
      '10.0.0.0/8',
      '127.0.0.1',
    ]);
    expect(() => parseEnv({ ...BASE, TRUST_PROXY: 'everyone' })).toThrow(ConfigError);
  });

  it('flags non-loopback hosts', () => {
    expect(isNonLoopbackHost('127.0.0.1')).toBe(false);
    expect(isNonLoopbackHost('::1')).toBe(false);
    expect(isNonLoopbackHost('0.0.0.0')).toBe(true);
  });
});

describe('.env.example', () => {
  it('is generated from the schema and committed up to date (pnpm --filter @spareon/server env:example)', () => {
    const committed = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    expect(committed).toBe(renderEnvExample());
  });

  it('documents every variable and marks the required ones', () => {
    const text = renderEnvExample();
    for (const name of Object.keys(BASE)) {
      expect(text).toMatch(new RegExp(`\\(required\\)\\n(# .*\\n)?${name}=`));
    }
    expect(text).toMatch(/\nCASHOUT_ENABLED=\n/);
  });
});

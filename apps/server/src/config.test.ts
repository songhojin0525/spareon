import { describe, expect, it } from 'vitest';

import { ConfigError, devDashboardEnabled, isNonLoopbackHost, parseEnv } from './config.js';

const KEY = 'dev-api-key-0123456789abcdef';
const SECRET = 'dev-agent-secret-0123456789abcdef';

describe('parseEnv', () => {
  it('applies safe defaults when variables are absent', () => {
    expect(parseEnv({})).toEqual({
      HOST: '127.0.0.1',
      PORT: 8080,
      NODE_ENV: 'production',
      DB_ROLE: 'binjari_app',
      DATA_ENCRYPTION_KEY_ID: 'k1',
    });
  });

  it('coerces PORT from string', () => {
    expect(parseEnv({ PORT: '3000', HOST: '0.0.0.0' })).toMatchObject({
      HOST: '0.0.0.0',
      PORT: 3000,
    });
  });

  it.each(['-1', '65536', 'abc', '80.5'])('rejects invalid PORT %s with a typed error', (port) => {
    expect(() => parseEnv({ PORT: port })).toThrow(ConfigError);
  });

  it('accepts development credentials in development', () => {
    const cfg = parseEnv({ NODE_ENV: 'development', DEV_API_KEY: KEY, DEV_AGENT_SECRET: SECRET });
    expect(cfg.DEV_API_KEY).toBe(KEY);
    expect(cfg.DEV_AGENT_SECRET).toBe(SECRET);
  });

  it.each([{ DEV_API_KEY: KEY }, { DEV_AGENT_SECRET: SECRET }, { DEV_DASHBOARD: '1' }])(
    'refuses development settings in production (also when NODE_ENV is unset): %o',
    (extra) => {
      expect(() => parseEnv({ ...extra })).toThrow(ConfigError);
      expect(() => parseEnv({ NODE_ENV: 'production', ...extra })).toThrow(/production/);
    },
  );

  it.each(['short', 'has spaces in the middle of it!!', 'é'.repeat(30)])(
    'rejects weak or malformed dev credentials (%s)',
    (value) => {
      expect(() => parseEnv({ NODE_ENV: 'development', DEV_API_KEY: value })).toThrow(ConfigError);
    },
  );

  it('treats blank values as unset', () => {
    expect(parseEnv({ DEV_API_KEY: '  ', DEV_AGENT_SECRET: '' }).DEV_API_KEY).toBeUndefined();
  });

  it('requires the agent secret to differ from the API key', () => {
    expect(() =>
      parseEnv({ NODE_ENV: 'development', DEV_API_KEY: KEY, DEV_AGENT_SECRET: KEY }),
    ).toThrow(/differ/);
  });

  it('validates the data encryption key', () => {
    expect(() => parseEnv({ DATA_ENCRYPTION_KEY: 'zz' })).toThrow(ConfigError);
    expect(parseEnv({ DATA_ENCRYPTION_KEY: 'ab'.repeat(32) }).DATA_ENCRYPTION_KEY).toBe(
      'ab'.repeat(32),
    );
  });
});

describe('devDashboardEnabled', () => {
  it('is on only in development or with DEV_DASHBOARD=1', () => {
    expect(devDashboardEnabled(parseEnv({}))).toBe(false);
    expect(devDashboardEnabled(parseEnv({ NODE_ENV: 'test' }))).toBe(false);
    expect(devDashboardEnabled(parseEnv({ NODE_ENV: 'development' }))).toBe(true);
    expect(devDashboardEnabled(parseEnv({ NODE_ENV: 'test', DEV_DASHBOARD: '1' }))).toBe(true);
  });
});

describe('isNonLoopbackHost', () => {
  it('flags LAN bindings only', () => {
    expect(isNonLoopbackHost('127.0.0.1')).toBe(false);
    expect(isNonLoopbackHost('localhost')).toBe(false);
    expect(isNonLoopbackHost('0.0.0.0')).toBe(true);
    expect(isNonLoopbackHost('192.168.0.10')).toBe(true);
  });
});

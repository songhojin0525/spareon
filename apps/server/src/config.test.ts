import { describe, expect, it } from 'vitest';

import { ConfigError, parseEnv } from './config.js';

describe('parseEnv', () => {
  it('applies defaults when variables are absent', () => {
    expect(parseEnv({})).toEqual({ HOST: '127.0.0.1', PORT: 8080 });
  });

  it('coerces PORT from string', () => {
    expect(parseEnv({ PORT: '3000', HOST: '0.0.0.0' })).toEqual({ HOST: '0.0.0.0', PORT: 3000 });
  });

  it.each(['-1', '65536', 'abc', '80.5'])('rejects invalid PORT %s with a typed error', (port) => {
    expect(() => parseEnv({ PORT: port })).toThrow(ConfigError);
  });
});

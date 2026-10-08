import { describe, expect, it } from 'vitest';

import { DEFAULT_LOCALE, resolveLocale, SUPPORTED_LOCALES } from './index.js';

describe('web locale placeholder', () => {
  it('defaults to Korean', () => {
    expect(DEFAULT_LOCALE).toBe('ko');
    expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE);
  });

  it('falls back to the default for unknown or missing locales', () => {
    expect(resolveLocale('KO')).toBe('ko');
    expect(resolveLocale('en')).toBe('ko');
    expect(resolveLocale(undefined)).toBe('ko');
  });
});

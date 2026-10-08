import { afterAll, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { fixedClock } from './lib/clock.js';

describe('GET /healthz', () => {
  const app = buildApp({ clock: fixedClock(new Date('2026-01-02T03:04:05.000Z')) });
  afterAll(async () => {
    await app.close();
  });

  it('returns ok with the time from the injected clock', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.json()).toEqual({ status: 'ok', time: '2026-01-02T03:04:05.000Z' });
  });

  it('returns 404 for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
  });
});

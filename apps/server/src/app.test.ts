import net, { type AddressInfo } from 'node:net';
import { Writable } from 'node:stream';

import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildApp } from './app.js';
import { fixedClock } from './lib/clock.js';
import { AppError, invalidRequest } from './lib/errors.js';
import { createLogger } from './lib/logger.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function capture(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  return {
    stream: new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk.toString('utf8'));
        cb();
      },
    }),
    text: () => chunks.join(''),
  };
}

describe('buildApp', () => {
  const logs = capture();
  const app = buildApp({
    clock: fixedClock(new Date('2026-01-02T03:04:05.000Z')),
    logger: createLogger({ level: 'trace', destination: logs.stream }),
  });
  const MARKER = 'SECRET-PROMPT-MARKER-7f3a';
  app.post('/test/app-error', () => {
    throw new AppError('custom_code', 418, 'Short and stout.', { fields: ['a'] });
  });
  app.post('/test/crash', () => {
    throw new Error(`internal detail with ${MARKER}`);
  });
  app.post('/test/zod', (req) => {
    const r = z.object({ n: z.number() }).safeParse(req.body);
    if (!r.success) throw invalidRequest(r.error.issues);
    return { ok: true };
  });
  app.post('/v1/test', () => {
    throw new AppError('rate_limited', 429, 'Slow down.', undefined, { 'retry-after': '3' });
  });
  afterAll(async () => {
    await app.close();
  });

  it('GET /healthz returns ok with the time from the injected clock and a request id', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.json()).toEqual({ status: 'ok', time: '2026-01-02T03:04:05.000Z' });
    expect(res.headers['x-request-id']).toMatch(UUID_V7);
  });

  it('answers unknown routes with the error format', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: { code: string; message: string; requestId: string } }>();
    expect(body.error.code).toBe('not_found');
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('sends AppError code, message and details', async () => {
    const res = await app.inject({ method: 'POST', url: '/test/app-error' });
    expect(res.statusCode).toBe(418);
    expect(res.json()).toEqual({
      error: {
        code: 'custom_code',
        message: 'Short and stout.',
        requestId: res.headers['x-request-id'],
        details: { fields: ['a'] },
      },
    });
  });

  it('hides unexpected errors behind 500 internal_error, and keeps their message out of the log', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/crash',
      headers: { authorization: `Bearer ${MARKER}`, cookie: `s=${MARKER}` },
      payload: { messages: [{ role: 'user', content: MARKER }] },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('internal_error');
    expect(res.body).not.toContain('internal detail');
    // The log keeps the error type and stack frames, never a non-database error message.
    expect(logs.text()).toContain('"message":"message withheld"');
    expect(logs.text()).not.toContain('internal detail');
  });

  it('reports validation failures by path only, never by value', async () => {
    const res = await app.inject({ method: 'POST', url: '/test/zod', payload: { n: MARKER } });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; details: { fields: string[] } } }>();
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.details.fields).toEqual(['n']);
    expect(res.body).not.toContain(MARKER);
  });

  it('answers malformed JSON with 400 without quoting the body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/zod',
      headers: { 'content-type': 'application/json' },
      payload: `{"n": ${MARKER}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_request');
    expect(res.body).not.toContain(MARKER);
  });

  it('adds the OpenAI error type and response headers on /v1', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/test' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('3');
    expect(res.json<{ error: { type: string; code: string } }>().error).toMatchObject({
      type: 'rate_limit_error',
      code: 'rate_limited',
    });
  });

  it('never logs the bodies, headers or error messages that carried the marker', () => {
    const text = logs.text();
    expect(text).toContain('"route":"/test/crash"');
    expect(text).not.toContain(MARKER);
  });
});

describe('shutdown', () => {
  const stuckRequest = async (drainMs: number): Promise<number> => {
    const app = buildApp({ clock: fixedClock(new Date(0)), closeDrainMs: drainMs });
    // A request that never finishes (a stuck handler or a client that never lets it complete).
    app.get('/stuck', () => new Promise(() => undefined));
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => undefined);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write('GET /stuck HTTP/1.1\r\nHost: x\r\n\r\n');
    await new Promise((r) => setTimeout(r, 200));
    const start = performance.now();
    const closed = app.close().then(() => performance.now() - start);
    const took = await Promise.race([
      closed,
      new Promise<number>((r) =>
        setTimeout(() => {
          r(-1);
        }, 3_000),
      ),
    ]);
    socket.destroy();
    await closed;
    return took;
  };

  it('close() destroys connections still busy after the drain time, so shutdown always ends', async () => {
    const took = await stuckRequest(200);
    expect(took).toBeGreaterThanOrEqual(150);
    expect(took).toBeLessThan(2_000);
  });

  it('without the drain a stuck request would hold close() (the backstop is what ends it)', async () => {
    expect(await stuckRequest(10_000)).toBe(-1);
  });
});

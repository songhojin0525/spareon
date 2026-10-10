/**
 * Acceptance 4 (SLO-9): after requests that carry a prompt marker, an API key, a password, session and
 * CSRF tokens and a buyer output, the captured server log (trace level, everything) contains none of
 * them — on success paths and error paths alike.
 */
import { Writable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../../src/lib/logger.js';
import { chatBody, type Harness, startHarness } from '../support/skeleton.js';
import { Browser, createTestUser } from '../support/web.js';

describe('log redaction over the whole server', () => {
  let h: Harness;
  const lines: string[] = [];

  beforeAll(async () => {
    const logger = createLogger({
      level: 'trace',
      destination: new Writable({
        write(chunk: Buffer, _enc, cb) {
          lines.push(chunk.toString('utf8'));
          cb();
        },
      }),
    });
    h = await startHarness({ logger, topupCr: 10n });
  });
  afterAll(async () => {
    await h.close();
  });

  it('never writes prompts, outputs, keys, passwords or tokens to the log', async () => {
    const MARK = 'PROMPT-MARKER-c0ffee-SLO9';
    const secrets: string[] = [MARK, h.apiKey];
    await h.agent('redact-a');

    // 1. Successful chat with an idempotency key (output stored and replayed).
    const ok = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${h.apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': `idem-${MARK}`,
        'x-api-key': h.apiKey,
      },
      body: JSON.stringify(chatBody(`tell me about ${MARK}`, { stop: [`${MARK}-stop`] })),
    });
    expect(ok.status).toBe(200);
    const output = ((await ok.json()) as { choices: { message: { content: string } }[] }).choices[0]
      ?.message.content;
    expect(output).toBeDefined();
    secrets.push(output ?? 'missing');

    // 2. Error paths: malformed JSON quoting the marker, invalid fields, unknown model, wrong key.
    const bad = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.apiKey}`, 'content-type': 'application/json' },
      body: `{"model":"fake-echo","messages":[{"role":"user","content":"${MARK}"`,
    });
    expect(bad.status).toBe(400);
    expect(
      (await h.chat({ model: MARK.toLowerCase(), messages: [{ role: 'user', content: MARK }] }))
        .status,
    ).toBe(404);
    expect(
      (await h.chat({ model: 'fake-echo', messages: [{ role: 'robot', content: MARK }] })).status,
    ).toBe(400);
    expect(
      (await h.chat(chatBody(MARK), { apiKey: `sp_test_AAAAAAAA_${'B'.repeat(32)}` })).status,
    ).toBe(401);

    // 3. People: signup and login with a password, session use, a failed login.
    const user = await createTestUser(h, 'buyer');
    secrets.push(user.password);
    const b = Browser.of(h);
    await b.primeCsrf();
    expect(
      (
        await b.request('POST', '/api/auth/login', {
          body: { email: user.email, password: user.password },
        })
      ).status,
    ).toBe(200);
    secrets.push(b.sessionToken ?? 'missing', b.cookies.get('spareon_csrf') ?? 'missing');
    const created = await b.request('POST', '/api/api-keys', { body: { name: 'redaction' } });
    const newKey = ((await created.json()) as { key: string }).key;
    secrets.push(newKey);
    expect(
      (
        await b.request('POST', '/api/auth/login', {
          body: { email: user.email, password: `${MARK}-wrong-password` },
        })
      ).status,
    ).toBe(401);
    const anon = Browser.of(h);
    await anon.primeCsrf();
    expect(
      (
        await anon.request('POST', '/api/auth/signup', {
          body: {
            email: 'r@test.spareon',
            password: `${MARK} long password`,
            displayName: 'r',
            role: 'buyer',
            termsVersion: 'x',
          },
        })
      ).status,
    ).toBe(400);

    // Let the scheduler and gateway finish logging the job.
    await new Promise((r) => setTimeout(r, 300));
    const text = lines.join('');
    expect(text.length).toBeGreaterThan(1_000);
    expect(text).toContain('"route":"/v1/chat/completions"');
    for (const s of secrets) {
      expect(text.includes(s), `log contains a secret of length ${String(s.length)}`).toBe(false);
    }
    // The secret part of the API key is never logged even partially.
    expect(text).not.toContain(h.apiKey.split('_')[3] ?? 'x');
  });
});

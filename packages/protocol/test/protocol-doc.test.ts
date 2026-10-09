import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { capabilitiesDigest } from '../src/digest.js';
import type { CapabilitiesPayload } from '../src/generated/protocol.js';
import { FIXTURE_DIR, PACKAGE_ROOT, readSchemaSources } from '../src/schema-source.js';

const repoRoot = path.resolve(PACKAGE_ROOT, '..', '..');
const doc = readFileSync(path.join(repoRoot, 'docs', 'PROTOCOL.md'), 'utf8').replace(/\r\n/g, '\n');
const files = readSchemaSources().files as Record<string, Record<string, unknown>>;
const registry = files['registry.json'] as unknown as {
  messages: Record<string, { from: string; replies: string[]; timeoutMs?: number }>;
  http: Record<string, { from: string; replies: string[] }>;
};
const codes = (
  files['defs/error-codes.json'] as unknown as {
    codes: Record<
      string,
      { from: string; retryable: boolean; fatal: boolean; agentAction: string }
    >;
  }
).codes;

/** Rows of the first markdown table whose header starts with `header`. */
function table(header: string): string[][] {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => l.startsWith(header));
  expect(start, `table "${header}" not found`).toBeGreaterThanOrEqual(0);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(
      line
        .slice(1, -1)
        .split(' | ')
        .map((c) => c.trim()),
    );
  }
  return rows;
}
const ticks = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
const DIR: Record<string, string> = { agent: 'A→S', server: 'S→A', both: '양방향' };

describe('docs/PROTOCOL.md tables match the schemas (docs and code agree)', () => {
  it('message table lists every type with its direction, required fields, replies and time limit', () => {
    const rows = table('| 타입 | 방향 | 필수 필드 |');
    expect(rows.map((r) => ticks(r[0] ?? '')[0]).sort()).toEqual(
      Object.keys(registry.messages).sort(),
    );
    for (const [cType = '', cDir = '', cReq = '', , cReplies = '', cTime = ''] of rows) {
      const type = ticks(cType)[0] ?? '';
      const info = registry.messages[type];
      expect(info, type).toBeDefined();
      if (info === undefined) continue;
      expect(cDir, type).toBe(DIR[info.from]);
      const schema = files[`messages/${type}.json`] as {
        properties: { payload: { required: string[] } };
        required?: string[];
      };
      const [fields = ''] = cReq.split(' · ');
      expect(ticks(fields), type).toEqual(schema.properties.payload.required);
      expect(cReq.includes('`corr` 필수'), type).toBe((schema.required ?? []).includes('corr'));
      expect(ticks(cReplies), type).toEqual(info.replies);
      expect(cTime, type).toBe(info.timeoutMs === undefined ? '—' : `${info.timeoutMs / 1000}초`);
    }
  });

  it('http table lists every enrollment body with its required fields', () => {
    const rows = table('| 이름 | 방향 | 경로 |');
    expect(rows.map((r) => ticks(r[0] ?? '')[0]).sort()).toEqual(Object.keys(registry.http).sort());
    for (const [cName = '', cDir = '', , cReq = ''] of rows) {
      const name = ticks(cName)[0] ?? '';
      expect(cDir, name).toBe(DIR[registry.http[name]?.from ?? '']);
      const req = (files[`http/${name}.json`] as { required: string[] }).required;
      expect(ticks(cReq), name).toEqual(req);
    }
  });

  it('error code table matches the registry', () => {
    const rows = table('| 코드 | 보내는 쪽 |');
    expect(rows.map((r) => ticks(r[0] ?? '')[0]).sort()).toEqual(Object.keys(codes).sort());
    for (const [cCode = '', cFrom = '', cRetry = '', cFatal = '', cAction = ''] of rows) {
      const code = ticks(cCode)[0] ?? '';
      const e = codes[code];
      expect(e, code).toBeDefined();
      if (e === undefined) continue;
      expect(cFrom, code).toBe(e.from);
      expect(cRetry, code).toBe(e.retryable ? '예' : '아니오');
      expect(cFatal, code).toBe(e.fatal ? '예' : '아니오');
      expect(ticks(cAction)[0], code).toBe(e.agentAction);
    }
  });
});

describe('capabilitiesDigest vectors (shared with Go)', () => {
  const vectors = JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, 'vectors', 'digests.json'), 'utf8'),
  ) as { cases: { fixture: string; digest: string }[] };
  it.each(vectors.cases.map((c) => [c.fixture, c] as const))('%s', (_f, c) => {
    const msg = JSON.parse(readFileSync(path.join(FIXTURE_DIR, c.fixture), 'utf8')) as {
      payload: CapabilitiesPayload;
    };
    expect(capabilitiesDigest(msg.payload)).toBe(c.digest);
  });
});

/**
 * Server module dependency direction (docs/ARCHITECTURE.md 2.2): a module may import only modules it
 * reaches by the arrows of that diagram (transitively), and `lib` imports no module. The composition
 * root (http, app.ts, main.ts, bin, skeleton, dev, testing) may import anything; nothing but the root
 * may import the root.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = path.dirname(fileURLToPath(import.meta.url));

/** ARCHITECTURE 2.2 arrows: module → modules it may import directly. */
const ARROWS: Readonly<Record<string, readonly string[]>> = {
  lib: [],
  audit: ['lib'],
  notifications: ['lib'],
  auth: ['audit'],
  ledger: ['audit'],
  registry: ['audit'],
  apiKeys: ['auth'],
  pricing: ['ledger'],
  fleet: ['audit', 'notifications'],
  retention: ['lib'],
  reconciliation: ['ledger'],
  gateway: ['fleet'],
  metering: ['registry', 'pricing', 'ledger'],
  scheduler: ['gateway', 'fleet', 'metering', 'retention'],
  verification: ['scheduler', 'fleet', 'ledger'],
  providers: ['pricing', 'ledger'],
  buyerApi: ['scheduler', 'apiKeys', 'providers'],
  batch: ['buyerApi', 'scheduler'],
};

/** Source folder (or root file) → module. */
const FOLDERS: Readonly<Record<string, string>> = {
  lib: 'lib',
  db: 'lib',
  'config.ts': 'lib',
  audit: 'audit',
  auth: 'auth',
  'api-keys': 'apiKeys',
  ledger: 'ledger',
  fleet: 'fleet',
  gateway: 'gateway',
  scheduler: 'scheduler',
  retention: 'retention',
  'buyer-api': 'buyerApi',
  http: 'root',
  'app.ts': 'root',
  'main.ts': 'root',
  bin: 'root',
  skeleton: 'root',
  dev: 'root',
  testing: 'root',
  // Development seed (S03): a tool built on the test factories, not part of the running server.
  'db/seed.ts': 'root',
};

function reachable(from: string): Set<string> {
  const seen = new Set<string>([from, 'lib']);
  const stack = [from];
  while (stack.length > 0) {
    for (const next of ARROWS[stack.pop() ?? ''] ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

function moduleOf(file: string): string {
  const rel = path.relative(SRC, file).split(path.sep);
  const mod = FOLDERS[rel.join('/')] ?? FOLDERS[rel[0] ?? ''];
  if (mod === undefined)
    throw new Error(`no module mapping for src/${rel.join('/')} (add it to FOLDERS)`);
  return mod;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

const IMPORT_RE = /^\s*(?:import|export)\s[^'"]*?from\s+'(\.[^']+)'/gm;

describe('server module boundaries (ARCHITECTURE 2.2)', () => {
  it('every relative import follows the dependency direction', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const from = moduleOf(file);
      const allowed = from === 'root' ? undefined : reachable(from);
      for (const m of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
        const target = path.resolve(path.dirname(file), (m[1] ?? '').replace(/\.js$/, '.ts'));
        const to = moduleOf(target);
        if (to === from) continue;
        if (to === 'root' || (allowed !== undefined && !allowed.has(to))) {
          violations.push(
            `${path.relative(SRC, file)} (${from}) → ${path.relative(SRC, target)} (${to})`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the checker itself catches an upward import', () => {
    expect(reachable('auth').has('apiKeys')).toBe(false);
    expect(reachable('buyerApi').has('ledger')).toBe(true);
    expect(reachable('lib')).toEqual(new Set(['lib']));
  });
});

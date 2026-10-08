import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSON_SCHEMA_DIALECT } from '@binjari/protocol';
import { MICRO_CR_PER_CR } from '@binjari/shared';
import { defineBinjariVitestConfig } from '@binjari/testkit/vitest-config';
import { resolveLocale } from '@binjari/web';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

interface Pkg {
  name: string;
  private?: boolean;
  type?: string;
  scripts?: Record<string, string>;
}

function workspacePackages(): { dir: string; pkg: Pkg }[] {
  const out: { dir: string; pkg: Pkg }[] = [];
  for (const group of ['apps', 'packages', 'tools']) {
    for (const name of readdirSync(path.join(repoRoot, group))) {
      const dir = path.join(repoRoot, group, name);
      try {
        out.push({
          dir: `${group}/${name}`,
          pkg: JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Pkg,
        });
      } catch {
        // not a JS package (e.g. apps/agent is Go)
      }
    }
  }
  return out;
}

describe('workspace wiring', () => {
  it('internal packages resolve by name through their exports', () => {
    expect(JSON_SCHEMA_DIALECT).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(MICRO_CR_PER_CR).toBe(10n ** 6n);
    expect(resolveLocale('xx')).toBe('ko');
    expect(typeof defineBinjariVitestConfig).toBe('function');
  });

  it('every package follows the naming and module conventions', () => {
    const pkgs = workspacePackages();
    expect(pkgs.length).toBeGreaterThanOrEqual(6);
    for (const { dir, pkg } of pkgs) {
      expect(pkg.name, dir).toBe(`@binjari/${path.basename(dir)}`);
      expect(pkg.private, dir).toBe(true);
      expect(pkg.type, dir).toBe('module');
      expect(pkg.scripts?.['typecheck'], dir).toBeDefined();
    }
  });

  it('every package with tests uses the shared vitest config (so --quick works everywhere)', () => {
    for (const { dir, pkg } of workspacePackages()) {
      if (pkg.scripts?.['test'] === undefined) continue;
      const config = readFileSync(path.join(repoRoot, dir, 'vitest.config.ts'), 'utf8');
      expect(config, dir).toMatch(/defineBinjariVitestConfig\(/);
    }
  });
});

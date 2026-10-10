#!/usr/bin/env node
// @ts-check
// Cross-platform verification gate: `pnpm verify` (all), `--quick` (no *.int.test.ts), `--only=ts|go`.
//
// Rules this script must never break (they are unit-tested in tools/repo-checks):
// - Every child process runs with shell:false. No shell syntax, so it behaves the same on Windows/macOS/Linux.
// - A step is PASS only if every command in it exits with code 0 and no signal. Anything else is FAIL.
// - All steps run even after a failure (so one run shows every problem); the exit code is 1 if any step FAILED.
// - Go missing => Go steps SKIPPED (loudly). With REQUIRE_GO=1 (CI) Go missing is a FAIL.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_DIR = path.join(ROOT, 'apps', 'agent');
/** Keep in sync with package.json "engines.node" (checked by tools/repo-checks). */
export const MIN_NODE = '22.13.0';

const USAGE = `usage: node scripts/verify.mjs [--quick] [--only=ts|go]
  --quick      skip integration tests (*.int.test.ts) and the test database
  --only=ts    run only the TypeScript/docs steps
  --only=go    run only the Go steps
env: REQUIRE_GO=1 turns "Go not installed" into a failure (used by CI)`;

/**
 * @typedef {{ only: 'all' | 'ts' | 'go', quick: boolean, help: boolean }} Options
 * @typedef {'PASS' | 'FAIL' | 'SKIPPED'} Status
 * @typedef {{ code: number | null, signal: NodeJS.Signals | null, error?: Error | undefined, stdout: string }} CommandResult
 * @typedef {{ name: string, status: Status, ms: number, detail?: string }} StepResult
 * @typedef {{ command: string, prefixArgs: string[] }} Invocation
 * @typedef {{ cmd: Invocation, args: string[], cwd?: string, env?: Record<string, string>, captureStdout?: boolean }} CommandSpec
 */

/**
 * @param {readonly string[]} argv
 * @returns {Options}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const opts = { only: 'all', quick: false, help: false };
  for (const arg of argv) {
    if (arg === '--quick') opts.quick = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--only=')) {
      const value = arg.slice('--only='.length);
      if (value !== 'ts' && value !== 'go') throw new Error(`invalid --only value: ${value}`);
      opts.only = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

/**
 * A command result counts as success only with exit code 0, no signal and no spawn error.
 * @param {Pick<CommandResult, 'code' | 'signal' | 'error'>} r
 * @returns {boolean}
 */
export function isSuccess(r) {
  return r.error === undefined && r.signal === null && r.code === 0;
}

/**
 * Find how to invoke pnpm without a shell. Windows cannot spawn pnpm.cmd with shell:false, so prefer
 * running pnpm's JS entry point with the current node binary.
 * @param {{ env: NodeJS.ProcessEnv, platform: NodeJS.Platform, execPath: string, exists?: (p: string) => boolean }} ctx
 * @returns {Invocation | null}
 */
export function resolvePnpm({ env, platform, execPath, exists = existsSync }) {
  const isJs = (/** @type {string} */ p) => /\.(c|m)?js$/i.test(p);
  const execpath = env['npm_execpath'];
  if (execpath && /pnpm/i.test(path.basename(execpath)) && exists(execpath)) {
    return isJs(execpath)
      ? { command: execPath, prefixArgs: [execpath] }
      : { command: execpath, prefixArgs: [] };
  }
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const dirs = (env[pathKey] ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  // Use the target platform's path rules, not the host's (tests resolve Windows paths on Linux CI).
  const pathFor = platform === 'win32' ? path.win32 : path.posix;
  const join = pathFor.join;
  for (const dir of dirs) {
    for (const candidate of [
      join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      join(dir, '..', 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    ]) {
      if (exists(candidate)) return { command: execPath, prefixArgs: [candidate] };
    }
    const exe = join(dir, platform === 'win32' ? 'pnpm.exe' : 'pnpm');
    if (exists(exe)) return { command: exe, prefixArgs: [] };
  }
  const nodeDir = pathFor.dirname(execPath);
  for (const corepack of [
    join(nodeDir, 'node_modules', 'corepack', 'dist', 'corepack.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'),
  ]) {
    if (exists(corepack)) return { command: execPath, prefixArgs: [corepack, 'pnpm'] };
  }
  return null;
}

/**
 * Run one command with shell:false. Output is streamed (never swallowed) unless captured.
 * @param {CommandSpec} spec
 * @returns {Promise<CommandResult>}
 */
export function runCommand(spec) {
  return new Promise((resolve) => {
    let stdout = '';
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(spec.cmd.command, [...spec.cmd.prefixArgs, ...spec.args], {
        cwd: spec.cwd ?? ROOT,
        env: { ...process.env, ...spec.env },
        shell: false,
        stdio: ['ignore', spec.captureStdout === true ? 'pipe' : 'inherit', 'inherit'],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: null, signal: null, error: toError(err), stdout });
      return;
    }
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    /** @type {Error | undefined} */
    let spawnError;
    child.once('error', (err) => {
      spawnError = err;
    });
    child.once('close', (code, signal) => {
      resolve({ code, signal, error: spawnError, stdout });
    });
  });
}

/**
 * True only when the executable does not exist (spawn ENOENT).
 * @param {Pick<CommandResult, 'error'>} r
 */
export function isNotFound(r) {
  return r.error !== undefined && /** @type {NodeJS.ErrnoException} */ (r.error).code === 'ENOENT';
}

/**
 * @param {string} actual e.g. process.versions.node
 * @param {string} minimum e.g. "22.13.0"
 */
export function nodeVersionAtLeast(actual, minimum) {
  const a = actual.split('.').map((x) => Number.parseInt(x, 10));
  const m = minimum.split('.').map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (m[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

/** @param {unknown} err */
function toError(err) {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * @param {CommandSpec} spec
 * @returns {string}
 */
function describe(spec) {
  return [
    path.basename(spec.cmd.command),
    ...spec.cmd.prefixArgs.map((a) => path.basename(a)),
    ...spec.args,
  ].join(' ');
}

/**
 * Run commands in order; stop at the first failure inside the step.
 * @param {string} name
 * @param {CommandSpec[]} specs
 * @param {(r: CommandResult, spec: CommandSpec) => string | undefined} [extraCheck] returns a failure reason
 * @param {(spec: CommandSpec) => Promise<CommandResult>} [runner]
 * @returns {Promise<StepResult>}
 */
export async function runStep(name, specs, extraCheck, runner = runCommand) {
  const started = performance.now();
  for (const spec of specs) {
    process.stdout.write(`\n▶ [${name}] ${describe(spec)}\n`);
    const r = await runner(spec);
    if (!isSuccess(r)) {
      const why = r.error
        ? `could not run (${r.error.message})`
        : r.signal !== null
          ? `killed by ${r.signal}`
          : `exit code ${String(r.code)}`;
      return {
        name,
        status: 'FAIL',
        ms: performance.now() - started,
        detail: `${describe(spec)}: ${why}`,
      };
    }
    const reason = extraCheck?.(r, spec);
    if (reason !== undefined) {
      return { name, status: 'FAIL', ms: performance.now() - started, detail: reason };
    }
  }
  return { name, status: 'PASS', ms: performance.now() - started };
}

/**
 * @param {readonly StepResult[]} results
 * @returns {{ text: string, exitCode: 0 | 1 }}
 */
export function summarize(results) {
  const nameWidth = Math.max(4, ...results.map((r) => r.name.length));
  const lines = [
    '',
    '══ verify summary ══',
    `${'step'.padEnd(nameWidth)}  status   time`,
    `${'-'.repeat(nameWidth)}  -------  --------`,
  ];
  for (const r of results) {
    const time = r.status === 'SKIPPED' ? '-' : `${(r.ms / 1000).toFixed(1)}s`;
    lines.push(
      `${r.name.padEnd(nameWidth)}  ${r.status.padEnd(7)}  ${time}${r.detail ? `  ${r.detail}` : ''}`,
    );
  }
  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIPPED');
  if (skipped.length > 0) {
    lines.push(
      '',
      `!!! ${skipped.length} step(s) SKIPPED — this is NOT a full verification. See details above.`,
    );
  }
  // A run that verified nothing (no step passed) is a failure, never a silent pass.
  const passed = results.filter((r) => r.status === 'PASS');
  const exitCode = failed.length > 0 || passed.length === 0 ? 1 : 0;
  let verdict = `RESULT: PASS (${passed.length} step(s) passed)`;
  if (failed.length > 0) verdict = `RESULT: FAIL (${failed.length} failed step(s))`;
  else if (exitCode === 1) verdict = 'RESULT: FAIL (nothing was verified)';
  lines.push('', verdict);
  return { text: lines.join('\n'), exitCode };
}

/**
 * @param {Options} opts
 * @param {{ env: NodeJS.ProcessEnv, runner?: (spec: CommandSpec) => Promise<CommandResult>, pnpm?: Invocation | null }} ctx
 * @returns {Promise<StepResult[]>}
 */
export async function runAll(opts, ctx) {
  const runner = ctx.runner ?? runCommand;
  /** @type {StepResult[]} */
  const results = [];
  const node = { command: process.execPath, prefixArgs: [] };

  if (opts.only !== 'go') {
    const pnpm =
      ctx.pnpm !== undefined
        ? ctx.pnpm
        : resolvePnpm({ env: ctx.env, platform: process.platform, execPath: process.execPath });
    const testEnv = opts.quick ? { SPAREON_TEST_QUICK: '1' } : { SPAREON_TEST_QUICK: '0' };
    /** @type {Array<[string, CommandSpec[]]>} */
    const tsSteps = [
      [
        'format:check',
        [
          {
            cmd: node,
            args: [path.join('node_modules', 'prettier', 'bin', 'prettier.cjs'), '--check', '.'],
          },
        ],
      ],
      ['docs', [{ cmd: node, args: [path.join('scripts', 'check-docs.mjs')] }]],
    ];
    if (pnpm === null) {
      results.push(...(await runSteps(tsSteps, runner)));
      for (const name of ['lint', 'typecheck', 'test']) {
        results.push({
          name,
          status: 'FAIL',
          ms: 0,
          detail: 'pnpm not found (run via `pnpm verify`)',
        });
      }
    } else {
      tsSteps.push(
        ['lint', [{ cmd: pnpm, args: ['run', 'lint'] }]],
        [
          'typecheck',
          [
            { cmd: pnpm, args: ['-r', '--no-bail', 'run', 'typecheck'] },
            { cmd: pnpm, args: ['exec', 'tsc', '-p', 'tsconfig.json'] },
          ],
        ],
        ['test', [{ cmd: pnpm, args: ['-r', '--no-bail', 'run', 'test'], env: testEnv }]],
      );
      results.push(...(await runSteps(tsSteps, runner)));
    }
  }

  if (opts.only !== 'ts') {
    results.push(...(await runGo(ctx.env, runner)));
  }
  return results;
}

/**
 * @param {Array<[string, CommandSpec[]]>} steps
 * @param {(spec: CommandSpec) => Promise<CommandResult>} runner
 */
async function runSteps(steps, runner) {
  /** @type {StepResult[]} */
  const out = [];
  for (const [name, specs] of steps) out.push(await runStep(name, specs, undefined, runner));
  return out;
}

const GO_STEPS = ['go:gofmt', 'go:vet', 'go:test', 'go:build-windows'];

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {(spec: CommandSpec) => Promise<CommandResult>} runner
 * @returns {Promise<StepResult[]>}
 */
export async function runGo(env, runner = runCommand) {
  const requireGo = env['REQUIRE_GO'] === '1';
  const go = { command: 'go', prefixArgs: [] };
  const gofmt = { command: 'gofmt', prefixArgs: [] };
  const probe = await runner({ cmd: go, args: ['version'], cwd: AGENT_DIR, captureStdout: true });
  if (!isSuccess(probe) && !isNotFound(probe)) {
    // Go exists but is broken (bad binary, permissions, ...): that is a failure, not "not installed".
    let why = `exit code ${String(probe.code)}`;
    if (probe.error) why = probe.error.message;
    else if (probe.signal !== null) why = `killed by ${probe.signal}`;
    return [{ name: 'go:probe', status: 'FAIL', ms: 0, detail: `"go version" failed: ${why}` }];
  }
  if (!isSuccess(probe)) {
    const banner = [
      '',
      '##################################################################',
      `#  Go toolchain not found: Go steps ${requireGo ? 'FAIL (REQUIRE_GO=1)' : 'SKIPPED'}`.padEnd(
        65,
      ) + '#',
      '#  Install Go (see docs/ENVIRONMENT.md) and re-run `pnpm verify`.  #',
      '##################################################################',
    ].join('\n');
    process.stdout.write(`${banner}\n`);
    return GO_STEPS.map((name) =>
      requireGo
        ? {
            name,
            status: /** @type {Status} */ ('FAIL'),
            ms: 0,
            detail: 'Go not installed (REQUIRE_GO=1)',
          }
        : { name, status: /** @type {Status} */ ('SKIPPED'), ms: 0, detail: 'Go not installed' },
    );
  }
  process.stdout.write(`\n${probe.stdout.trim()}\n`);
  const steps = [
    await runStep(
      'go:gofmt',
      [{ cmd: gofmt, args: ['-l', '.'], cwd: AGENT_DIR, captureStdout: true }],
      (r) => {
        const files = r.stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
        return files.length > 0 ? `gofmt needed: ${files.join(', ')}` : undefined;
      },
      runner,
    ),
    await runStep(
      'go:vet',
      [{ cmd: go, args: ['vet', './...'], cwd: AGENT_DIR }],
      undefined,
      runner,
    ),
    await runStep(
      'go:test',
      [{ cmd: go, args: ['test', './...'], cwd: AGENT_DIR }],
      undefined,
      runner,
    ),
    await runStep(
      'go:build-windows',
      [
        {
          cmd: go,
          args: ['build', './...'],
          cwd: AGENT_DIR,
          env: { GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
        },
      ],
      undefined,
      runner,
    ),
  ];
  return steps;
}

async function main() {
  /** @type {Options} */
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${toError(err).message}\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!nodeVersionAtLeast(process.versions.node, MIN_NODE)) {
    process.stderr.write(
      `Node.js ${MIN_NODE} or newer is required (found ${process.versions.node}). See docs/ENVIRONMENT.md.\n`,
    );
    return 1;
  }
  const results = await runAll(opts, { env: process.env });
  const { text, exitCode } = summarize(results);
  process.stdout.write(`${text}\n`);
  return exitCode;
}

function isMain() {
  const arg = process.argv[1];
  if (arg === undefined) return false;
  const norm = (/** @type {string} */ p) =>
    process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  return (
    norm(fileURLToPath(import.meta.url)) === norm(arg) ||
    import.meta.url === pathToFileURL(arg).href
  );
}

if (isMain()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`verify crashed: ${toError(err).stack ?? String(err)}\n`);
      process.exitCode = 1;
    },
  );
}

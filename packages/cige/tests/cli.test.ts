import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { main, type CliIo } from '../src/cli.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CASE = {
  id: 'checkout',
  Context: { environment: 'staging' },
  Intent: 'A shopper can pay by {method}',
  Execution: ['pay by {method}'],
  Variants: [{ id: 'card', params: { method: 'card' } }],
};

// Plain JavaScript, so the test loads it without a TypeScript step; `reset` leaves a mark the test reads.
const CONFIG = `export default {
  cases: 'tests/cige/*.cige.json',
  environments: {
    staging: { config: 'e2e.staging.config.ts', reset() { globalThis.cigeEvents?.push('reset'); } },
    bare: {},
  },
};
`;

function project(withConfig = true): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cige-cli-'));
  dirs.push(dir);
  // Where the default glob looks, so the commands that need no config find it too.
  mkdirSync(path.join(dir, 'tests', 'cige'), { recursive: true });
  writeFileSync(path.join(dir, 'tests', 'cige', 'checkout.cige.json'), JSON.stringify(CASE));
  if (withConfig) writeFileSync(path.join(dir, 'cige.config.mjs'), CONFIG);
  return dir;
}

function io(cwd: string): CliIo & { out: string; err: string; runs: { args: readonly string[]; cwd: string }[] } {
  const state = {
    cwd,
    out: '',
    err: '',
    runs: [] as { args: readonly string[]; cwd: string }[],
    stdout: (text: string) => void (state.out += text),
    stderr: (text: string) => void (state.err += text),
    runE2e: async (args: readonly string[], at: string) => {
      (globalThis as { cigeEvents?: string[] }).cigeEvents?.push('e2e');
      state.runs.push({ args, cwd: at });
      return 1;
    },
  };
  return state;
}

describe('e2e-cige', () => {
  it('prints usage, and exits 2 on no command or an unknown one', async () => {
    const help = io(project());
    expect(await main(['--help'], help)).toBe(0);
    expect(help.out).toContain('Usage: npx e2e-cige');
    expect(await main([], io(project()))).toBe(2);
    const unknown = io(project());
    expect(await main(['heal'], unknown)).toBe(2);
    expect(unknown.err).toContain('unknown command "heal"');
  });

  it('replays one variant in its environment: reset, then e2e with its config, and its exit code', async () => {
    const dir = project();
    const state = io(dir);
    const events: string[] = [];
    (globalThis as { cigeEvents?: string[] }).cigeEvents = events;
    expect(await main(['replay', 'checkout', '--variant', 'card', '--', '--target', 'web'], state)).toBe(1);
    expect(events).toEqual(['reset', 'e2e']);
    expect(state.runs).toEqual([
      { args: ['run', '--config', 'e2e.staging.config.ts', '--tag', 'cige:checkout/card', '--no-cache', '--target', 'web'], cwd: dir },
    ]);
  });

  it('refuses a replay that names no variant of a case that has them, or an undeclared environment', async () => {
    const state = io(project());
    expect(await main(['replay', 'checkout'], state)).toBe(2);
    expect(state.err).toContain('pass --variant card');
    const env = io(project());
    expect(await main(['replay', 'checkout', '--variant', 'card', '--env', 'prod'], env)).toBe(2);
    expect(env.err).toContain('no environment "prod"; known: staging, bare');
    expect(env.runs).toEqual([]);
    const bare = io(project());
    expect(await main(['replay', 'checkout', '--variant', 'card', '--env', 'bare'], bare)).toBe(2);
    expect(bare.err).toContain('environment "bare" has no reset action');
    expect(bare.runs).toEqual([]);
  });

  it('replays a case with no environment under the config e2eConfig names', async () => {
    const dir = project(false);
    writeFileSync(path.join(dir, 'cige.config.mjs'), "export default { e2eConfig: 'e2e.agent.config.ts' };\n");
    writeFileSync(path.join(dir, 'tests', 'cige', 'checkout.cige.json'), JSON.stringify({ ...CASE, Context: {} }));
    const state = io(dir);
    await main(['replay', 'checkout', '--variant', 'card'], state);
    expect(state.runs[0]?.args).toEqual(['run', '--config', 'e2e.agent.config.ts', '--tag', 'cige:checkout/card', '--no-cache']);
  });

  it('replays without a config, treating the environment as prose', async () => {
    const dir = project(false);
    const state = io(dir);
    await main(['replay', 'checkout', '--variant', 'card'], state);
    expect(state.runs[0]?.args).toEqual(['run', '--tag', 'cige:checkout/card', '--no-cache']);
  });

  it('needs a config for env, and an action the environment has', async () => {
    const none = io(project(false));
    expect(await main(['env', 'reset', 'staging'], none)).toBe(2);
    expect(none.err).toContain('no CIGE config');
    const bare = io(project());
    expect(await main(['env', 'reset', 'bare'], bare)).toBe(2);
    expect(bare.err).toContain('environment "bare" has no reset action');
    const bad = io(project());
    expect(await main(['env', 'restart', 'staging'], bad)).toBe(2);
    const ok = io(project());
    expect(await main(['env', 'reset', 'staging'], ok)).toBe(0);
    expect(ok.out).toBe('reset staging: done\n');
  });

  it('writes the refs pointers even with no resolvers', async () => {
    const dir = project(false);
    writeFileSync(path.join(dir, 'tests', 'cige', 'checkout.cige.json'), JSON.stringify({ ...CASE, Context: { buildRef: 'releases/{build}.md' } }));
    const state = io(dir);
    expect(await main(['refs', 'checkout', '--variant', 'card', '--build', '1.2.3'], state)).toBe(0);
    expect(state.out.trim()).toBe(path.join('.e2e', 'cige', 'checkout.card.refs'));
    const index = JSON.parse(readFileSync(path.join(dir, '.e2e', 'cige', 'checkout.card.refs', 'index.json'), 'utf8')) as unknown;
    expect(index).toEqual({ testId: 'checkout', variant: 'card', build: '1.2.3', refs: { build: { pointer: 'releases/1.2.3.md' } } });
  });
});

describe('e2e-cige check', () => {
  it('lists what each case lacks for classification and replay, and fails on a gap', async () => {
    const dir = project();
    writeFileSync(
      path.join(dir, 'tests', 'cige', 'ready.cige.json'),
      JSON.stringify({ id: 'ready', Context: { environment: 'staging', specRef: 'docs/specs/pay.md', buildRef: 'CHANGELOG.md' }, Intent: 'A ready case', Execution: ['x'] }),
    );
    writeFileSync(
      path.join(dir, 'tests', 'cige', 'bare.cige.json'),
      JSON.stringify({ id: 'bare', Context: { environment: 'bare', specRef: 'releases/{build}/spec.md' }, Intent: 'A bare case', Execution: ['x'] }),
    );
    const state = io(dir);
    expect(await main(['check'], state)).toBe(1);
    expect(state.out).toContain('tests/cige/bare.cige.json (bare)\n  no-build-ref:');
    expect(state.out).toContain('  build-unset: a ref uses {build}, but the config sets no build');
    expect(state.out).toContain('  environment-no-reset: environment "bare" has no reset action');
    expect(state.out).toContain('(checkout)\n  no-spec-ref:');
    expect(state.out).not.toContain('(ready)');
    expect(state.out).toContain('2 of 3 CIGE cases have gaps.');
    const json = io(dir);
    expect(await main(['check', '--json', '--warn', '--build', '1.0.0'], json)).toBe(0);
    const report = JSON.parse(json.out) as { cases: number; ready: number; results: { id: string; gaps: { kind: string }[] }[] };
    expect(report).toMatchObject({ cases: 3, ready: 1 });
    expect(report.results.find((result) => result.id === 'bare')?.gaps.map((gap) => gap.kind)).toEqual(['no-build-ref', 'environment-no-reset']);
  });

  it('flags a case that names no environment once the config declares some', async () => {
    const dir = project();
    writeFileSync(path.join(dir, 'tests', 'cige', 'checkout.cige.json'), JSON.stringify({ ...CASE, Context: { specRef: 'a.md', buildRef: 'b.md' } }));
    const state = io(dir);
    expect(await main(['check'], state)).toBe(1);
    expect(state.out).toContain('environment-unset: no Context.environment: a replay has no environment to reset');
  });

  it('lists a plugin readiness gap with the plugin that reported it', async () => {
    const dir = project(false);
    writeFileSync(
      path.join(dir, 'cige.config.mjs'),
      "export default { plugins: [{ name: 'owners', readiness: (testCase) => (testCase.extensions?.['x-owner'] ? undefined : 'no x-owner: nobody triages it') }] };\n",
    );
    writeFileSync(path.join(dir, 'tests', 'cige', 'checkout.cige.json'), JSON.stringify({ ...CASE, Context: { specRef: 'a.md', buildRef: 'b.md' } }));
    const state = io(dir);
    expect(await main(['check'], state)).toBe(1);
    expect(state.out).toContain('  plugin (owners): no x-owner: nobody triages it');
  });

  it('flags an environment the config does not declare', async () => {
    const state = io(project(false));
    expect(await main(['check'], state)).toBe(1);
    expect(state.out).toContain('environment-undeclared: environment "staging" is not in the config\'s environments');
  });
});

describe('e2e-cige diff', () => {
  it('exits 1 when the CIGE config changed, even with every case untouched', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cige-cli-diff-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'cige.config.mjs'), 'export default { hooks: { ok: () => false } };\n');
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=cige@example.test', '-c', 'user.name=cige', ...args], { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    writeFileSync(path.join(dir, 'cige.config.mjs'), 'export default { hooks: { ok: () => true } };\n');
    const state = io(dir);
    expect(await main(['diff', '--base', 'HEAD'], state)).toBe(1);
    expect(state.out).toContain('needs approval  config-changed: cige.config.mjs');
    rmSync(path.join(dir, 'cige.config.mjs'));
    const deleted = io(dir);
    expect(await main(['diff', '--base', 'HEAD'], deleted)).toBe(1);
    expect(deleted.out).toContain('needs approval  config-changed: cige.config.mjs');
  });

  it('refuses a --config that does not exist rather than checking nothing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cige-cli-diff-'));
    dirs.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['-c', 'user.email=cige@example.test', '-c', 'user.name=cige', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: dir, stdio: 'pipe' });
    const state = io(dir);
    expect(await main(['diff', '--base', 'HEAD', '--config', 'nope.ts'], state)).toBe(2);
    expect(state.err).toContain('no CIGE config at nope.ts');
    const directory = io(dir);
    expect(await main(['diff', '--base', 'HEAD', '--config', '.'], directory)).toBe(2);
    expect(directory.err).toContain('no CIGE config at .');
  });
});


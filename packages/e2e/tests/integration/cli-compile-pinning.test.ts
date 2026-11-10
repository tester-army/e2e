/**
 * How `e2e compile` pins a recording to its call, through the built CLI on
 * recordings written straight into the store: a recording made with other
 * params, under another replay policy, or counted with a helper's call is
 * not this call's; an option a block would drop, or a name the lines need
 * that the file binds to something else, keeps the step an `agent.act()`;
 * and a revert stops before editing any file when one holds a broken block.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { instructionDigest, paramsDigest } from '../../src/cache/identity.ts';
import { REPLAY_POLICY_VERSION } from '../../src/cache/relocate.ts';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from '../../src/cache/store.ts';
import { TRACE_SCHEMA_VERSION, type ActionTrace } from '../../src/cache/trace.ts';
import { testId } from '../../src/internal/ids.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));

const CONFIG = `import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({}).engine, app: FAKE_APP }],
  credentials: { admin: { username: 'admin@example.test', password: 'admin-pass' } },
  cache: { mode: 'read-write', dir: 'store' },
};
`;

const cleanupQueue: FixtureProject[] = [];
afterEach(() => {
  for (const each of cleanupQueue.splice(0)) each.cleanup();
});

interface Seed {
  readonly title: string;
  readonly instruction: string;
  readonly params?: Record<string, string>;
  readonly callIndex?: number;
  readonly policyVersion?: string;
  readonly actions?: ActionTrace['actions'];
}

/** A project whose store holds one recording per seed, each a tap on a test id unless it says otherwise. */
async function project(files: Record<string, string>, seeds: readonly Seed[]): Promise<FixtureProject> {
  const created = createProject({ 'e2e.config.ts': CONFIG, ...files });
  cleanupQueue.push(created);
  const store = new FileCacheStore({ directory: path.join(created.dir, 'store'), maxBytes: MAX_CACHE_WIRE_BYTES, writable: true });
  for (const [index, seed] of seeds.entries()) {
    await store.write(index.toString(16).padStart(64, '0'), {
      actions: seed.actions ?? [{ name: 'tap', summary: 'tap save', target: { role: 'button', name: 'Save', testId: 'save' } }],
      executor: { name: 'seeded' },
      summary: 'passed',
      recordedFor: {
        testId: testId('tests/a.e2e.ts', [seed.title]),
        targetId: 'fake',
        instructionDigest: instructionDigest(seed.instruction),
        paramsDigest: paramsDigest(seed.params),
        callIndex: seed.callIndex ?? 0,
        agent: 'default',
      },
      ...(seed.policyVersion === undefined
        ? {}
        : {
            keyedBy: {
              cacheSchema: TRACE_SCHEMA_VERSION,
              policyVersion: seed.policyVersion,
              project: 'unused',
              platform: 'fake',
              engineName: 'fake',
              engineSpiVersion: 1,
              appIdentity: 'fake',
              agentContextDigest: 'none',
            },
          }),
    } as ActionTrace);
  }
  return created;
}

/** One CLI command in a project. */
function cli(created: FixtureProject, args: readonly string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: created.dir, env: { ...process.env, CI: '', NO_COLOR: '1' }, encoding: 'utf8', timeout: 60_000 });
  return { exitCode: result.status, output: result.stdout + result.stderr, stdout: result.stdout };
}

/** Each step's status and code from `compile status --json`. */
function status(created: FixtureProject): { status: string; code?: string; reason?: string }[] {
  const ran = cli(created, ['compile', 'status', '--json']);
  expect(ran.exitCode, ran.output).toBe(0);
  return (JSON.parse(ran.stdout) as { steps: { status: string; code?: string; reason?: string }[] }).steps;
}

const suite = (body: string, preamble = ''): string => `import { test } from 'e2e';\n${preamble}\ntest('t', async ({ agent, screen }) => {\n${body}\n});\n`;

describe('e2e compile: pinning a recording to its call', () => {
  it('compiles a call whose params digest as its recording was keyed', async () => {
    const created = await project({ 'tests/a.e2e.ts': suite("  await agent.act('save it', { params: { name: 'Grace' } });") }, [{ title: 't', instruction: 'save it', params: { name: 'Grace' } }]);
    expect(status(created)).toMatchObject([{ status: 'compiles' }]);
  });

  it('does not take a recording made with other params, or under another replay policy', async () => {
    const otherParams = await project({ 'tests/a.e2e.ts': suite("  await agent.act('save it', { params: { name: 'Grace' } });") }, [{ title: 't', instruction: 'save it', params: { name: 'Ada' } }]);
    expect(status(otherParams)).toMatchObject([{ status: 'not-recorded', code: 'not-recorded' }]);
    const otherPolicy = await project({ 'tests/a.e2e.ts': suite("  await agent.act('save it');") }, [{ title: 't', instruction: 'save it', policyVersion: `${REPLAY_POLICY_VERSION}-old` }]);
    expect(status(otherPolicy)).toMatchObject([{ status: 'not-recorded' }]);
  });

  it('refuses when a helper shares the count: more recordings of the step than calls in the body', async () => {
    const created = await project({ 'tests/a.e2e.ts': suite("  await closeBanner(agent);\n  await agent.act('close the banner');", 'const closeBanner = (agent) => agent.act(\'close the banner\');') }, [
      { title: 't', instruction: 'close the banner', callIndex: 0 },
      { title: 't', instruction: 'close the banner', callIndex: 1 },
    ]);
    expect(status(created)).toMatchObject([{ status: 'stays', code: 'ambiguous-recording' }]);
  });

  it('keeps a call whose options a block would drop', async () => {
    const created = await project({ 'tests/a.e2e.ts': suite("  await agent.act('save it', { onBeforeAction: () => {}, maxSteps: 5 });") }, [{ title: 't', instruction: 'save it' }]);
    expect(status(created)).toMatchObject([{ status: 'stays', code: 'step-options' }]);
  });

  it('uses a name the file imports from its own fixtures module, as the rest of the test does', async () => {
    const typed: ActionTrace['actions'] = [{ name: 'type', summary: 'type', target: { testId: 'email' }, value: 'admin@example.test' }];
    const created = await project(
      { 'tests/a.e2e.ts': suite("  await agent.act('sign in');", "import { credentials } from './fixtures.ts';"), 'tests/fixtures.ts': "export { credentials } from 'e2e';\n" },
      [{ title: 't', instruction: 'sign in', actions: typed }],
    );
    const compiled = cli(created, ['compile', 'tests/a.e2e.ts', '--dry-run']);
    expect(compiled.output).toContain('1 step(s) would compile');
    expect(compiled.output).toContain('+   await screen.getByTestId("email").fill(credentials.user("admin").username);');
    // The file's own import serves the line: no e2e import gains a credentials name.
    expect(compiled.output).not.toMatch(/^[+-] .*import/mu);
  });

  it('keeps a step whose lines need a name the module already binds', async () => {
    const typed: ActionTrace['actions'] = [{ name: 'type', summary: 'type', target: { testId: 'email' }, value: 'admin@example.test' }];
    const created = await project({ 'tests/a.e2e.ts': suite("  await agent.act('sign in');", 'const credentials = { note: 1 };') }, [{ title: 't', instruction: 'sign in', actions: typed }]);
    const compiled = cli(created, ['compile', 'tests/a.e2e.ts', '--dry-run']);
    expect(compiled.output).toContain('[fixtures] the module declares its own credentials');
    expect(compiled.output).toContain('0 step(s) would compile');
  });
});

describe('e2e compile revert', () => {
  it('edits no file when one of them holds a broken block', async () => {
    const good = suite(
      [
        '  /**',
        '   * @compiled agent.act("save it")',
        `   * @from ${JSON.stringify("await agent.act('save it');")}`,
        '   */',
        '  await screen.getByTestId("save").tap();',
        '  /** @end compiled */',
      ].join('\n'),
    );
    const created = await project({ 'tests/a.e2e.ts': good, 'tests/b.e2e.ts': good.replace('/** @end compiled */', '') }, []);
    const reverted = cli(created, ['compile', 'revert', 'tests/a.e2e.ts', 'tests/b.e2e.ts']);
    expect(reverted.exitCode).toBe(2);
    expect(reverted.output).toContain('nothing was reverted');
    expect(readFileSync(path.join(created.dir, 'tests/a.e2e.ts'), 'utf8')).toBe(good);
  });
});

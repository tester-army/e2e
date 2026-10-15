import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Report1Document } from '../../src/report/build.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { contentsUnder, createProject, type FixtureProject } from '../helpers/run-project.ts';
import { readEntries } from '../helpers/trace-cache.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const PRIMARY = 'E2E_FIRST_AVAILABLE_PRIMARY_KEY';
const SECONDARY = 'E2E_FIRST_AVAILABLE_SECONDARY_KEY';
const CREDENTIALS = ['fixture-primary-value', 'fixture-secondary-value', 'fixture-rotated-value'] as const;
const projects: FixtureProject[] = [];

function configSource(plain: boolean): string {
  return `import { appendFileSync } from 'node:fs';
import { ${plain ? '' : 'firstAvailable, '}type E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { installFakeLoopModel, nodeIdFor } from '../../helpers/fake-loop-model.ts';
import { createScriptedInstance } from '../../helpers/scripted-model.ts';

function scripted(provider: string, modelId: string) {
  const loop = installFakeLoopModel((call) => {
    if (call.toolResults.length === 0) {
      return [{ toolName: 'tap', input: { target: nodeIdFor(call.prompt, /button "Increment"/) } }];
    }
    return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'The counter shows 1.' } }];
  });
  return createScriptedInstance(provider, modelId, async (options) => {
    appendFileSync('model-calls.jsonl', JSON.stringify({ provider, modelId, pid: process.pid }) + '\\n');
    if (process.env.E2E_FIRST_AVAILABLE_FORBID_CALLS === '1') throw new Error('Unexpected model call.');
    return loop.doGenerate(options);
  });
}

const primary = scripted('fixture-primary', 'counter-primary');
const secondary = scripted(
  process.env.E2E_FIRST_AVAILABLE_SECONDARY_PROVIDER ?? 'fixture-secondary',
  process.env.E2E_FIRST_AVAILABLE_SECONDARY_MODEL ?? 'counter-secondary',
);

export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [{ name: 'web', engine: web(), app: { url: process.env.E2E_FIRST_AVAILABLE_APP_URL! } }],
  workers: 2,
  retries: 0,
  timeout: 15_000,
  cache: 'read-write',
  agents: { default: { model: ${plain ? 'secondary' : `firstAvailable([
    { env: '${PRIMARY}', model: primary },
    { env: '${SECONDARY}', model: secondary },
  ])`} } },
} satisfies E2EConfig;
`;
}

const SUITE = `import { test, expect } from 'e2e';

test('increments the counter', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('Increment the counter once.');
  await expect(screen.getByRole('status')).toHaveText('1');
});
`;

interface ModelCall {
  provider: string;
  modelId: string;
  pid: number;
}

function fixture(plain = false): FixtureProject {
  const project = createProject({
    'e2e.config.ts': configSource(plain),
    'tests/one.e2e.ts': SUITE,
    'tests/two.e2e.ts': SUITE,
  });
  projects.push(project);
  return project;
}

async function cli(project: FixtureProject, app: FixtureApp, overrides: NodeJS.ProcessEnv = {}, args: string[] = []) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('E2E_FIRST_AVAILABLE_')) delete env[name];
  }
  Object.assign(env, {
    CI: '',
    NO_COLOR: '1',
    E2E_CACHE_DIR: '',
    E2E_TELEMETRY_DISABLED: '1',
    E2E_FIRST_AVAILABLE_APP_URL: app.url,
  }, overrides);
  rmSync(path.join(project.dir, 'model-calls.jsonl'), { force: true });
  rmSync(path.join(project.dir, '.e2e', 'report.json'), { force: true });
  return new Promise<{ exitCode: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'run', ...args], {
      cwd: project.dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => {
      if (signal !== null) reject(new Error(`CLI terminated with ${signal}: ${output}`));
      else resolve({ exitCode, output });
    });
  });
}

function reportOf(project: FixtureProject): Report1Document {
  const report = JSON.parse(readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8')) as Report1Document;
  assertValidReport(report);
  return report;
}

function callsOf(project: FixtureProject): ModelCall[] {
  const file = path.join(project.dir, 'model-calls.jsonl');
  return existsSync(file)
    ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as ModelCall)
    : [];
}

function actSteps(report: Report1Document) {
  const steps = report.run.results.flatMap((result) => result.attempts.flatMap((attempt) => attempt.steps))
    .filter((step) => step.api === 'agent.act');
  expect(report.run.results.map((result) => result.status)).toEqual(['passed', 'passed']);
  expect(steps).toHaveLength(2);
  return steps;
}

function expectRecorded(project: FixtureProject, report: Report1Document, provider: string, model: string): void {
  for (const step of actSteps(report)) {
    expect(step.cache).toMatchObject({ mode: 'missed', reason: 'no-entry', replayedActions: 0 });
    expect(step.metrics?.modelCalls).toBe(2);
    expect(step.model).toMatchObject({ provider, model, calls: 2 });
  }
  const calls = callsOf(project);
  expect(calls).toHaveLength(4);
  expect(calls.every((call) => call.provider === provider && call.modelId === model)).toBe(true);
  expect(calls.every((call) => call.pid !== process.pid)).toBe(true);
}

function expectReplayed(project: FixtureProject, report: Report1Document): void {
  for (const step of actSteps(report)) {
    expect(step.cache).toMatchObject({ mode: 'self-finalized', replayedActions: 1, totalActions: 1 });
    expect(step.metrics?.modelCalls).toBe(0);
  }
  expect(callsOf(project)).toEqual([]);
}

function entryBytes(project: FixtureProject) {
  return readEntries(project).map(({ file }) => [path.basename(file), readFileSync(file, 'utf8')]);
}

function expectNoCredentials(project: FixtureProject, output: string): void {
  const dir = path.join(project.dir, '.e2e');
  const files = existsSync(dir) ? contentsUnder(dir) : [];
  for (const value of CREDENTIALS) {
    expect(output).not.toContain(value);
    for (const [file, contents] of files) expect(contents, file).not.toContain(value);
  }
}

describe('firstAvailable through the built CLI and workers', () => {
  let app: FixtureApp;

  beforeAll(async () => { app = await startFixtureApp(); });
  afterEach(() => { for (const project of projects.splice(0)) project.cleanup(); });
  afterAll(async () => { await app?.close(); });

  it('selects the first nonempty credential and reports its actual provider and model', async () => {
    const project = fixture();
    const ran = await cli(project, app, { [PRIMARY]: CREDENTIALS[0], [SECONDARY]: CREDENTIALS[1] });
    expect(ran.exitCode, ran.output).toBe(0);
    expectRecorded(project, reportOf(project), 'fixture-primary', 'counter-primary');
    expectNoCredentials(project, ran.output);
  }, 90_000);

  it.each([undefined, '', ' \t '])('selects the second credential when the first is %j', async (primary) => {
    const project = fixture();
    const ran = await cli(project, app, { [PRIMARY]: primary, [SECONDARY]: CREDENTIALS[1] });
    expect(ran.exitCode, ran.output).toBe(0);
    expectRecorded(project, reportOf(project), 'fixture-secondary', 'counter-secondary');
    expectNoCredentials(project, ran.output);
  }, 90_000);

  it('replays after credential rotation when the selected identity stays the same', async () => {
    const project = fixture();
    const recorded = await cli(project, app, { [PRIMARY]: CREDENTIALS[0], [SECONDARY]: CREDENTIALS[1] });
    expect(recorded.exitCode, recorded.output).toBe(0);
    expectRecorded(project, reportOf(project), 'fixture-primary', 'counter-primary');
    const entries = entryBytes(project);
    expect(entries).toHaveLength(2);

    const replayed = await cli(project, app, {
      [PRIMARY]: CREDENTIALS[2],
      E2E_FIRST_AVAILABLE_FORBID_CALLS: '1',
    });
    expect(replayed.exitCode, replayed.output).toBe(0);
    expectReplayed(project, reportOf(project));
    expect(entryBytes(project)).toEqual(entries);
    expectNoCredentials(project, recorded.output + replayed.output);
  }, 150_000);

  it.each([
    {
      field: 'candidate',
      initialEnv: { [PRIMARY]: CREDENTIALS[0], [SECONDARY]: CREDENTIALS[1] },
      changedEnv: { [SECONDARY]: CREDENTIALS[1] },
      initial: ['fixture-primary', 'counter-primary'],
      selected: ['fixture-secondary', 'counter-secondary'],
    },
    {
      field: 'provider',
      initialEnv: { [SECONDARY]: CREDENTIALS[1] },
      changedEnv: { [SECONDARY]: CREDENTIALS[1], E2E_FIRST_AVAILABLE_SECONDARY_PROVIDER: 'fixture-other' },
      initial: ['fixture-secondary', 'counter-secondary'],
      selected: ['fixture-other', 'counter-secondary'],
    },
    {
      field: 'model',
      initialEnv: { [SECONDARY]: CREDENTIALS[1] },
      changedEnv: { [SECONDARY]: CREDENTIALS[1], E2E_FIRST_AVAILABLE_SECONDARY_MODEL: 'counter-other' },
      initial: ['fixture-secondary', 'counter-secondary'],
      selected: ['fixture-secondary', 'counter-other'],
    },
  ] as const)('isolates replay when the selected $field changes', async ({ initialEnv, changedEnv, initial, selected }) => {
    const project = fixture();
    const recorded = await cli(project, app, initialEnv);
    expect(recorded.exitCode, recorded.output).toBe(0);
    expectRecorded(project, reportOf(project), initial[0], initial[1]);
    const originalEntries = entryBytes(project);
    expect(originalEntries).toHaveLength(2);

    const strict = await cli(project, app, {
      ...changedEnv, E2E_FIRST_AVAILABLE_FORBID_CALLS: '1',
    }, ['--strict-cache']);
    expect(strict.exitCode, strict.output).toBe(2);
    expect(strict.output).toContain('REPLAY_STALE');
    expect(strict.output).toContain('the selected model');
    expect(callsOf(project)).toEqual([]);
    expect(entryBytes(project)).toEqual(originalEntries);

    const switched = await cli(project, app, changedEnv);
    expect(switched.exitCode, switched.output).toBe(0);
    expectRecorded(project, reportOf(project), selected[0], selected[1]);
    const switchedEntries = entryBytes(project);
    expect(switchedEntries).toHaveLength(4);
    for (const entry of originalEntries) expect(switchedEntries).toContainEqual(entry);

    const restored = await cli(project, app, { ...initialEnv, E2E_FIRST_AVAILABLE_FORBID_CALLS: '1' });
    expect(restored.exitCode, restored.output).toBe(0);
    expectReplayed(project, reportOf(project));
    expect(entryBytes(project)).toEqual(switchedEntries);
    expectNoCredentials(project, recorded.output + switched.output + restored.output);
  }, 210_000);

  it('keeps plain model replay independent of provider and model identity', async () => {
    const project = fixture(true);
    const recorded = await cli(project, app);
    expect(recorded.exitCode, recorded.output).toBe(0);
    expectRecorded(project, reportOf(project), 'fixture-secondary', 'counter-secondary');
    const entries = entryBytes(project);
    expect(entries).toHaveLength(2);

    const replayed = await cli(project, app, {
      E2E_FIRST_AVAILABLE_SECONDARY_PROVIDER: 'fixture-other',
      E2E_FIRST_AVAILABLE_SECONDARY_MODEL: 'counter-other',
      E2E_FIRST_AVAILABLE_FORBID_CALLS: '1',
    });
    expect(replayed.exitCode, replayed.output).toBe(0);
    expectReplayed(project, reportOf(project));
    expect(entryBytes(project)).toEqual(entries);
  }, 150_000);

  it('fails e2e list with MODEL_UNAVAILABLE when no credential is available', async () => {
    const project = fixture();
    const ran = await cli(project, app, {}, ['list']);
    expect(ran.exitCode, ran.output).toBe(2);
    expect(ran.output).toContain('MODEL_UNAVAILABLE');
    expect(ran.output).toContain(PRIMARY);
    expect(ran.output).toContain(SECONDARY);
    expect(callsOf(project)).toEqual([]);
    expectNoCredentials(project, ran.output);
  }, 90_000);

  it('fails config with MODEL_UNAVAILABLE and both variable names when neither credential is available', async () => {
    const project = fixture();
    const ran = await cli(project, app);
    expect(ran.exitCode, ran.output).toBe(2);
    expect(ran.output).toContain('configuration error MODEL_UNAVAILABLE (config)');
    expect(ran.output).toContain(PRIMARY);
    expect(ran.output).toContain(SECONDARY);
    expect(callsOf(project)).toEqual([]);
    expect(readEntries(project)).toEqual([]);
    expectNoCredentials(project, ran.output);
  }, 90_000);
});

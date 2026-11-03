/**
 * `e2e doctor` through the built CLI: the doctor-1 report a host parses, the
 * exit code it gates on, an engine's own checks, and what it says about each
 * agent's model with and without `--check-model`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { DoctorReport } from '../../src/cli/doctor.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const SCHEMA = JSON.parse(readFileSync(fileURLToPath(new URL('../../schema/doctor-v1.schema.json', import.meta.url)), 'utf8')) as object;
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(SCHEMA);
const projects: FixtureProject[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) project.cleanup();
});

/**
 * A config with one target on an engine whose `doctor` reports `toolchain`
 * as `TOOLCHAIN` says, a second on the fake engine, which has no checks, and
 * `agents` as given.
 */
function config(agents = ''): string {
  return `import { appendFileSync } from 'node:fs';
import { APICallError } from 'ai';
import type { E2EConfig } from 'e2e';
import { defineEngine } from 'e2e/engine';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';
import { createScriptedInstance, scriptedResult } from '../../helpers/scripted-model.ts';

const checked = defineEngine({
  name: 'checked',
  version: '1.0.0',
  spiVersion: 1,
  platform: 'fake',
  observe: async () => ({ root: { ref: { id: 'root', revision: '' }, role: 'root' }, viewport: { width: 1, height: 1 } }),
  async doctor(info) {
    if (process.env.TOOLCHAIN === 'throw') throw new Error('toolchain probe crashed');
    if (process.env.TOOLCHAIN === 'malformed') return [{ id: 'Bad Id', status: 'ok' }] as never;
    if (process.env.TOOLCHAIN === 'reserved') return [{ id: 'model', status: 'pass' }];
    if (process.env.TOOLCHAIN === 'hang') {
      info.log('checking');
      return new Promise((resolve) => info.signal.addEventListener('abort', () => resolve([])));
    }
    if (process.env.TOOLCHAIN === 'leak') return [{ id: 'toolchain', status: 'fail', message: 'token sk_live_generic_4242 rejected' }];
    const status = process.env.TOOLCHAIN === 'missing' ? 'fail' : 'pass';
    return [{ id: 'toolchain', status, message: \`\${info.targetName} headed=\${String(info.headed)}\` }];
  },
});
const answering = createScriptedInstance('scripted', 'answers', async () => scriptedResult([{ type: 'text', text: 'OK' }], 'stop'));
const counted = createScriptedInstance('scripted', 'counted', async () => {
  appendFileSync('calls', 'call\\n');
  return scriptedResult([{ type: 'text', text: 'OK' }], 'stop');
});
const refusing = createScriptedInstance('scripted', 'refuses', async () => scriptedResult([], 'content-filter'));
const erroring = createScriptedInstance('scripted', 'errors', async () => scriptedResult([], 'error'));
const failing = createScriptedInstance('scripted', 'fails', async () => {
  throw new Error('provider is down');
});
const refused = createScriptedInstance('scripted', 'refused', async () => {
  appendFileSync('calls', 'call\\n');
  throw new APICallError({ message: 'connect ECONNREFUSED 127.0.0.1:59999', url: 'http://127.0.0.1:59999', requestBodyValues: {}, isRetryable: true });
});

export default {
  tests: 'tests/**/*.e2e.ts',
  secrets: { 'stripe-key': 'sk_live_generic_4242' },
  targets: [
    { name: 'checked', engine: checked, app: FAKE_APP },
    { name: 'plain', platform: 'fake', engine: createFakeEngine({}).engine, app: FAKE_APP },
  ],
  ${agents}
} satisfies E2EConfig;
`;
}

/** Runs `e2e doctor` with `args` in a project of `files`. */
function doctor(files: Record<string, string>, args: readonly string[], env: Record<string, string> = {}) {
  const project = createProject(files);
  projects.push(project);
  const result = spawnSync(process.execPath, [CLI, 'doctor', ...args], {
    cwd: project.dir,
    env: { ...process.env, CI: '', NO_COLOR: '1', XDG_CONFIG_HOME: path.join(project.dir, '.config'), E2E_OAUTH_CREDENTIALS: '', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(result.error).toBeUndefined();
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs `e2e doctor --json` and parses the report, which must match doctor-1. */
function doctorJson(files: Record<string, string>, args: readonly string[] = [], env: Record<string, string> = {}) {
  const { exitCode, stdout, stderr } = doctor(files, ['--json', ...args], env);
  const report = JSON.parse(stdout) as DoctorReport;
  expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  return { exitCode, report, stderr };
}

describe('e2e doctor', () => {
  it('reports the runtime, the config and its targets, and each engine, and exits 0', () => {
    const { exitCode, report } = doctorJson({ 'e2e.config.ts': config() }, ['--headed']);
    expect(exitCode).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.checks.map(({ id, status, target }) => ({ id, status, ...(target === undefined ? {} : { target }) }))).toEqual([
      { id: 'node', status: 'pass' },
      { id: 'config', status: 'pass' },
      { id: 'toolchain', status: 'pass', target: 'checked' },
      { id: 'engine', status: 'skip', target: 'plain' },
      { id: 'model', status: 'skip' },
    ]);
    expect(report.checks.find((check) => check.id === 'toolchain')?.message).toBe('checked headed=true');
    expect(report.checks.find((check) => check.id === 'config')?.targets).toEqual([
      { name: 'checked', platform: 'fake', engine: 'checked' },
      { name: 'plain', platform: 'fake', engine: 'fake' },
    ]);
  });

  it("exits 2 on an engine's failed check or a throw, and prints one line per check", () => {
    expect(doctorJson({ 'e2e.config.ts': config() }, [], { TOOLCHAIN: 'missing' })).toMatchObject({ exitCode: 2, report: { ok: false } });
    const thrown = doctorJson({ 'e2e.config.ts': config() }, ['--target', 'checked'], { TOOLCHAIN: 'throw' });
    expect(thrown.exitCode).toBe(2);
    expect(thrown.report.checks.find((check) => check.target === 'checked')).toMatchObject({ id: 'engine', status: 'fail', message: 'toolchain probe crashed' });
    const list = doctor({ 'e2e.config.ts': config() }, [], { TOOLCHAIN: 'missing' });
    expect(list.exitCode).toBe(2);
    expect(list.stdout).toContain('✗ toolchain  [checked] checked headed=false');
    expect(list.stdout).toContain('1 check failed');
  });

  it("fails an engine whose check is malformed, and redacts the config's secrets from every message", () => {
    const malformed = doctorJson({ 'e2e.config.ts': config() }, ['--target', 'checked'], { TOOLCHAIN: 'malformed' });
    expect(malformed.exitCode).toBe(2);
    expect(malformed.report.checks.at(-2)).toMatchObject({ id: 'engine', status: 'fail', target: 'checked', code: 'ENGINE_FAILURE' });
    const reserved = doctorJson({ 'e2e.config.ts': config() }, ['--target', 'checked'], { TOOLCHAIN: 'reserved' });
    expect(reserved.report.checks.at(-2)).toMatchObject({ id: 'engine', status: 'fail', target: 'checked', code: 'ENGINE_FAILURE' });
    const leaked = doctorJson({ 'e2e.config.ts': config() }, ['--target', 'checked'], { TOOLCHAIN: 'leak' });
    expect(leaked.report.checks.find((check) => check.id === 'toolchain')?.message).toBe('token <secret:stripe-key> rejected');
    expect(doctor({ 'e2e.config.ts': config() }, [], { TOOLCHAIN: 'leak' }).stdout).not.toContain('sk_live_generic_4242');
  });

  it('stops at a config that does not load, with its error code', () => {
    const missing = doctorJson({ 'README.md': '' });
    expect(missing.exitCode).toBe(2);
    expect(missing.report.checks.map(({ id, status, code }) => ({ id, status, code }))).toEqual([
      { id: 'node', status: 'pass', code: undefined },
      { id: 'config', status: 'fail', code: 'CONFIG_NOT_FOUND' },
    ]);
    const unknown = doctorJson({ 'e2e.config.ts': config() }, ['--target', 'nope']);
    expect(unknown.report.checks.at(-1)).toMatchObject({ id: 'config', status: 'fail', code: 'UNKNOWN_TARGET' });
  });

  it("names each agent's model and calls it only with --check-model", () => {
    const files = {
      'e2e.config.ts': config(
        "agents: { default: { model: answering }, down: { model: failing }, split: { model: answering, judge: failing }, broken: { model: erroring }, both: { model: failing, judge: erroring }, brought: { executor: { name: 'own', runStep: async () => ({ status: 'done' }) } as never, judge: failing } },",
      ),
    };
    const unchecked = doctorJson(files);
    expect(unchecked.exitCode).toBe(0);
    expect(unchecked.report.checks.filter((check) => check.id === 'model')).toEqual([
      { id: 'model', status: 'unknown', agent: 'default', model: { provider: 'scripted', modelId: 'answers' }, message: 'the model reads its own credential; --check-model calls it' },
      { id: 'model', status: 'unknown', agent: 'down', model: { provider: 'scripted', modelId: 'fails' }, message: 'the model reads its own credential; --check-model calls it' },
      {
        id: 'model',
        status: 'unknown',
        agent: 'split',
        model: { provider: 'scripted', modelId: 'answers' },
        judge: { provider: 'scripted', modelId: 'fails' },
        message: 'the model reads its own credential; --check-model calls it',
      },
      { id: 'model', status: 'unknown', agent: 'broken', model: { provider: 'scripted', modelId: 'errors' }, message: 'the model reads its own credential; --check-model calls it' },
      {
        id: 'model',
        status: 'unknown',
        agent: 'both',
        model: { provider: 'scripted', modelId: 'fails' },
        judge: { provider: 'scripted', modelId: 'errors' },
        message: 'the model reads its own credential; --check-model calls it',
      },
      { id: 'model', status: 'unknown', agent: 'brought', executor: 'own', judge: { provider: 'scripted', modelId: 'fails' }, message: 'the model reads its own credential; --check-model calls it' },
    ]);
    const checked = doctorJson(files, ['--check-model']);
    expect(checked.exitCode).toBe(2);
    expect(checked.report.checks.filter((check) => check.id === 'model').map(({ agent, status, code, message }) => ({ agent, status, code, message }))).toEqual([
      { agent: 'default', status: 'pass', code: undefined, message: 'answered' },
      { agent: 'down', status: 'fail', code: 'MODEL_PROVIDER_FAILED', message: expect.stringContaining('provider is down') },
      { agent: 'split', status: 'fail', code: 'MODEL_PROVIDER_FAILED', message: expect.stringMatching(/^judge: .*provider is down/) },
      { agent: 'broken', status: 'fail', code: 'MODEL_PROVIDER_FAILED', message: expect.stringContaining('error finish') },
      { agent: 'both', status: 'fail', code: 'MODEL_PROVIDER_FAILED', message: expect.stringMatching(/^model: .*provider is down.*; judge: .*error finish/) },
      { agent: 'brought', status: 'fail', code: 'MODEL_PROVIDER_FAILED', message: expect.stringContaining('provider is down') },
    ]);
  });

  it('makes one call for agents with equal provider options, and counts a refusal as an answer', () => {
    const files = {
      'e2e.config.ts': config(
        "agents: { default: { model: counted, providerOptions: { scripted: { effort: 'low' } } }, twin: { model: counted, providerOptions: { scripted: { effort: 'low' } } }, narrow: { model: counted, providerOptions: { scripted: { effort: 'low' } }, maxInputTokens: 50000 }, shy: { model: refusing } },",
      ),
    };
    const project = createProject(files);
    projects.push(project);
    const result = spawnSync(process.execPath, [CLI, 'doctor', '--json', '--check-model'], {
      cwd: project.dir,
      env: { ...process.env, CI: '', NO_COLOR: '1', XDG_CONFIG_HOME: path.join(project.dir, '.config') },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(result.status).toBe(0);
    expect(report.checks.filter((check) => check.id === 'model').map(({ agent, status }) => ({ agent, status }))).toEqual([
      { agent: 'default', status: 'pass' },
      { agent: 'twin', status: 'pass' },
      { agent: 'narrow', status: 'pass' },
      { agent: 'shy', status: 'pass' },
    ]);
    expect(readFileSync(path.join(project.dir, 'calls'), 'utf8')).toBe('call\ncall\n');
  });

  it('retries a refused connection once and reports its error, not the call timeout', () => {
    const project = createProject({ 'e2e.config.ts': config('agents: { default: { model: refused } },') });
    projects.push(project);
    const result = spawnSync(process.execPath, [CLI, 'doctor', '--json', '--check-model'], {
      cwd: project.dir,
      env: { ...process.env, CI: '', NO_COLOR: '1', XDG_CONFIG_HOME: path.join(project.dir, '.config') },
      encoding: 'utf8',
      timeout: 30_000,
    });
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(result.status).toBe(2);
    expect(report.checks.at(-1)).toMatchObject({ id: 'model', status: 'fail', code: 'MODEL_PROVIDER_FAILED', message: expect.stringContaining('ECONNREFUSED') });
    expect(readFileSync(path.join(project.dir, 'calls'), 'utf8')).toBe('call\ncall\n');
  });

  it('stops the checks at Ctrl-C, reports them, and exits 130', async () => {
    const project = createProject({ 'e2e.config.ts': config() });
    projects.push(project);
    const child = spawn(process.execPath, [CLI, 'doctor', '--json', '--target', 'checked'], {
      cwd: project.dir,
      env: { ...process.env, CI: '', NO_COLOR: '1', XDG_CONFIG_HOME: path.join(project.dir, '.config'), TOOLCHAIN: 'hang' },
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('[checked] checking')) child.kill('SIGINT');
    });
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
    expect(code).toBe(130);
    const report = JSON.parse(stdout) as DoctorReport;
    expect(report.checks.find((check) => check.target === 'checked')).toMatchObject({ id: 'engine', status: 'fail', code: 'CANCELLED' });
  });

  it('reports a config still loading at Ctrl-C as cancelled', async () => {
    const project = createProject({ 'e2e.config.ts': "process.stderr.write('loading\\n');\nawait new Promise((resolve) => setTimeout(resolve, 60_000));\nexport default {};\n" });
    projects.push(project);
    const child = spawn(process.execPath, [CLI, 'doctor', '--json'], { cwd: project.dir, env: { ...process.env, CI: '', NO_COLOR: '1' } });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    setTimeout(() => child.kill('SIGINT'), 2000);
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
    expect(code).toBe(130);
    expect((JSON.parse(stdout) as DoctorReport).checks.at(-1)).toMatchObject({ id: 'config', status: 'fail', code: 'CANCELLED' });
  });

  it('checks the stored login of a subscription model without calling it', () => {
    const files = {
      'e2e.config.ts': config("agents: { default: { model: chatgpt('gpt-6-luna') } },").replace(
        "import { defineEngine } from 'e2e/engine';",
        "import { defineEngine } from 'e2e/engine';\nimport { chatgpt } from 'e2e/oauth/chatgpt';",
      ),
    };
    const absent = doctorJson(files);
    expect(absent.exitCode).toBe(2);
    expect(absent.report.checks.at(-1)).toMatchObject({ id: 'model', status: 'fail', login: 'openai', code: 'MODEL_UNAVAILABLE' });
    const stored = doctorJson(files, [], { E2E_OAUTH_CREDENTIALS: JSON.stringify({ openai: { access: 'a', refresh: 'r', expires: 0 } }) });
    expect(stored.exitCode).toBe(0);
    expect(stored.report.checks.at(-1)).toMatchObject({ id: 'model', status: 'pass', login: 'openai', model: { modelId: 'gpt-6-luna' } });
  });
});

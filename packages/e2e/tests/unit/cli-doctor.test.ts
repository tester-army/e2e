/**
 * `doctor()` in process: what the built CLI cannot show without waiting out
 * the engine budget.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { doctor, type DoctorOptions, type DoctorReport } from '../../src/cli/doctor.ts';
import { cancelledError } from '../../src/internal/time.ts';
import { withProcessOutput } from '../../src/run/process-output.ts';
import { processSecrets } from '../../src/run/secrecy.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const projects: FixtureProject[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) project.cleanup();
  vi.unstubAllEnvs();
});

/** A project whose one target's engine checks until aborted, then closes its connection 200 ms later, marking `closed`. */
function slowProject(): FixtureProject {
  const project = createProject({
    'e2e.config.ts': `import { writeFileSync } from 'node:fs';
import { connectEngine, defineEngine, describeEngine, loopbackTransport, type EngineTransport } from '../../../src/engine/index.ts';
import { FAKE_APP } from '../../helpers/fake-engine.ts';

const hanging = defineEngine({
  name: 'slow',
  version: '1.0.0',
  spiVersion: 1,
  platform: 'fake',
  observe: async () => ({ root: { ref: { id: 'root', revision: '' }, role: 'root' }, viewport: { width: 1, height: 1 } }),
  doctor: (info) => new Promise((resolve) => info.signal.addEventListener('abort', () => resolve([]))),
});
const inner = loopbackTransport(hanging);
const transport: EngineTransport = {
  label: 'slow to close',
  async open(context) {
    const streams = await inner.open(context);
    return {
      ...streams,
      async close(timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        writeFileSync(\`\${context.cwd}/closed\`, '');
        await streams.close(timeoutMs);
      },
    };
  },
};
const slow = connectEngine({ manifest: describeEngine(hanging), transport });

export default { tests: 'tests/**/*.e2e.ts', targets: [{ name: 'slow', engine: slow, app: FAKE_APP }] };
`,
  });
  projects.push(project);
  return project;
}

/** Runs `doctor` on `project` with `signal` and any other options. */
function run(project: FixtureProject, signal: AbortSignal, extra: Partial<DoctorOptions> = {}): Promise<DoctorReport> {
  return withProcessOutput(processSecrets, (output) =>
    doctor({ version: '0.0.0', cwd: project.dir, env: process.env, headed: false, checkModel: false, signal, output, notice: () => {}, ...extra }),
  );
}

describe('doctor', () => {
  it('waits for a cancelled engine to close its connection before it reports', async () => {
    const project = slowProject();
    const controller = new AbortController();
    setTimeout(() => controller.abort(cancelledError()), 200);
    const report = await run(project, controller.signal);
    expect(existsSync(path.join(project.dir, 'closed'))).toBe(true);
    expect(report.checks.find((check) => check.target === 'slow')).toMatchObject({ id: 'engine', status: 'fail', code: 'CANCELLED' });
  });

  it('fails an engine that outlives its budget as ENGINE_FAILURE, after its connection closed', async () => {
    const project = slowProject();
    const report = await run(project, new AbortController().signal, { engineTimeoutMs: 100 });
    expect(existsSync(path.join(project.dir, 'closed'))).toBe(true);
    expect(report.checks.find((check) => check.target === 'slow')).toMatchObject({
      id: 'engine',
      status: 'fail',
      code: 'ENGINE_FAILURE',
      message: 'engine "slow" did not finish its checks within 100ms',
    });
  });

  it('checks the models --model names even when no config loads, and refuses a name that is not one', async () => {
    const project = createProject({ 'README.md': '' });
    projects.push(project);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(project.dir, '.config'));
    vi.stubEnv('E2E_OAUTH_CREDENTIALS', '');
    const invalid = await run(project, new AbortController().signal, { models: ['bogus', 'other/gpt-6', 'openai/'] });
    expect(invalid.checks.map(({ id, status, code }) => ({ id, status, code }))).toEqual([
      { id: 'node', status: 'pass', code: undefined },
      { id: 'config', status: 'fail', code: 'CONFIG_NOT_FOUND' },
      { id: 'model', status: 'fail', code: 'INVALID_CONFIG' },
      { id: 'model', status: 'fail', code: 'INVALID_CONFIG' },
      { id: 'model', status: 'fail', code: 'INVALID_CONFIG' },
    ]);
    expect(invalid.checks[2]?.message).toContain('provider one of openai, github-copilot, opencode-console, spacexai');
    const absent = await run(project, new AbortController().signal, { models: ['openai/gpt-6-luna'] });
    expect(absent.checks.at(-1)).toMatchObject({
      id: 'model',
      status: 'fail',
      login: 'openai',
      code: 'MODEL_UNAVAILABLE',
      model: { modelId: 'gpt-6-luna' },
    });
    // Without a login the credential fails first, so --check-model never reaches the network.
    const called = await run(project, new AbortController().signal, { models: ['openai/gpt-6-luna'], checkModel: true });
    expect(called.checks.at(-1)).toMatchObject({ id: 'model', status: 'fail', code: 'MODEL_UNAVAILABLE' });
  });

  it('passes a named model whose provider key is set, without calling it', async () => {
    const project = createProject({ 'README.md': '' });
    projects.push(project);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(project.dir, '.config'));
    vi.stubEnv('OPENCODE_API_KEY', 'test-key');
    const report = await run(project, new AbortController().signal, { models: ['opencode-console/deepseek-v4.1-flash'] });
    expect(report.checks.at(-1)).toMatchObject({
      id: 'model',
      status: 'pass',
      login: 'opencode-console',
      model: { modelId: 'deepseek-v4.1-flash' },
      message: 'OPENCODE_API_KEY is set',
    });
  });
});

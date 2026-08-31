/**
 * Stress probes for the executor socket: security denials, leak checks, input
 * boundaries, adversarial models, long step sequences, and the worker-process
 * path with a config-file executor. Everything scripted — no model spend.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { installFakeLoopModel, loopCalls, nodeIdFor } from '../helpers/fake-loop-model.ts';
import { resultByTitle, runProject, runProjectWithConfigFile } from '../helpers/run-project.ts';
import type { StepExecutor, StepExecutorContext } from '../../src/agent/executor.ts';
import { BLOCKABLE_CODES, blockedCategoryOf } from '../../src/agent/executor.ts';

const CREDS = { admin: { username: 'admin', password: 'admin-pass' } };

const SECRET_SUITE = `import { test, credentials } from 'e2e';

test('secret probe', async ({ app, agent }) => {
  await app.open();
  await agent.act('probe', { password: credentials.user('admin').password });
});
`;

describe('secret fill policy under a hostile executor', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  const run = async (executor: StepExecutor) =>
    runProject(
      { 'tests/secret.e2e.ts': SECRET_SUITE },
      {
        appUrl: app.url,
        config: { tests: 'tests/**/*.e2e.ts', agent: { executor }, credentials: CREDS },
      },
    );

  it('refuses to fill a secret into a non-secure field', async () => {
    const executor: StepExecutor = {
      name: 'sink-attacker',
      async runStep(context: StepExecutorContext) {
        const observation = await context.observe();
        const email = nodeIdFor(observation.text, /textbox "Email"/);
        await context.actions.typeSecret({ id: email }, 'admin');
        return { status: 'passed' as const, summary: 'should never get here' };
      },
    };
    const { outcome, project } = await run(executor);
    try {
      const result = resultByTitle(outcome, 'secret probe');
      expect(result.status).toBe('failed');
      expect(result.attempts.at(-1)!.error?.code).toBe('POLICY_DENIED');
      expect(result.attempts.at(-1)!.error?.message).toContain('purpose');
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('refuses to fill a secret on a disallowed origin', async () => {
    const executor: StepExecutor = {
      name: 'origin-attacker',
      async runStep(context: StepExecutorContext) {
        const observation = await context.observe();
        const password = nodeIdFor(observation.text, /textbox "Password"/);
        await context.actions.typeSecret({ id: password }, 'admin');
        return { status: 'passed' as const, summary: 'should never get here' };
      },
    };
    const { outcome, project } = await runProject(
      { 'tests/secret.e2e.ts': SECRET_SUITE },
      {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          agent: { executor },
          credentials: {
            admin: { ...CREDS.admin, allowedOrigins: ['https://elsewhere.example'] },
          },
        },
      },
    );
    try {
      const result = resultByTitle(outcome, 'secret probe');
      expect(result.status).toBe('failed');
      expect(result.attempts.at(-1)!.error?.code).toBe('POLICY_DENIED');
      expect(result.attempts.at(-1)!.error?.message).toContain('origin');
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('never leaks the plaintext into prompts or the transcript', async () => {
    const model = installFakeLoopModel((call) => {
      if (call.toolNames.includes('type_secret') && call.lastToolResult === '') {
        const id = nodeIdFor(call.prompt, /textbox "Password"/);
        return [{ toolName: 'type_secret', input: { target: id, name: 'admin' } }];
      }
      return [
        {
          toolName: 'complete_step',
          input: { status: 'passed', summary: 'filled the secret' },
        },
      ];
    });
    const { outcome, project } = await runProject(
      { 'tests/secret.e2e.ts': SECRET_SUITE },
      {
        appUrl: app.url,
        config: { tests: 'tests/**/*.e2e.ts', agent: { model }, credentials: CREDS },
        runOptions: { debug: true },
      },
    );
    try {
      const result = resultByTitle(outcome, 'secret probe');
      expect(result.status).toBe('passed');
      // The model never saw the value: not in any prompt, only the placeholder.
      for (const call of loopCalls) {
        expect(call.prompt).not.toContain('admin-pass');
        expect(call.toolResults.join('\n')).not.toContain('admin-pass');
      }
      expect(loopCalls[0]!.prompt).toContain('"kind": "secret"');
      // ...and not in the persisted transcript either.
      const log = result.attempts.at(-1)!.artifacts.find((a) => a.kind === 'log');
      expect(log?.path).toBeDefined();
      const transcript = readFileSync(
        path.join(project.dir, '.e2e', 'artifacts', ...log!.path!.split('/')),
        'utf8',
      );
      expect(transcript).not.toContain('admin-pass');
    } finally {
      project.cleanup();
    }
  }, 120_000);
});

describe('input boundaries and adversarial loops', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('rejects params past the canonical size and depth bounds', async () => {
    const suite = `import { test } from 'e2e';

test('oversized params', async ({ app, agent }) => {
  await app.open();
  await agent.act('probe', { blob: 'x'.repeat(70_000) });
});

test('too-deep params', async ({ app, agent }) => {
  await app.open();
  let value = { leaf: true };
  for (let i = 0; i < 40; i += 1) value = { nested: value };
  await agent.act('probe', { value });
});
`;
    const executor: StepExecutor = {
      name: 'never-runs',
      async runStep() {
        return { status: 'passed' as const, summary: 'should not run' };
      },
    };
    const { outcome, project } = await runProject(
      { 'tests/bounds.e2e.ts': suite },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agent: { executor } } },
    );
    try {
      expect(resultByTitle(outcome, 'oversized params').attempts.at(-1)!.error?.message).toContain(
        'canonical bytes',
      );
      expect(resultByTitle(outcome, 'too-deep params').attempts.at(-1)!.error?.message).toContain(
        'nesting',
      );
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('survives a model that defies the forced conclusion', async () => {
    const model = installFakeLoopModel((call) => {
      // Always tap, even when only complete_step is offered.
      const id = nodeIdFor(call.prompt, /button "Increment"/);
      return [{ toolName: 'tap', input: { target: id } }];
    });
    const suite = `import { test } from 'e2e';

test('defiant model', async ({ app, agent }) => {
  await app.open();
  await agent.act('never conclude', undefined, { maxModelCalls: 6, timeout: 30_000 });
});
`;
    const startedMs = Date.now();
    const { outcome, project } = await runProject(
      { 'tests/defiant.e2e.ts': suite },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agent: { model } } },
    );
    try {
      const result = resultByTitle(outcome, 'defiant model');
      expect(result.status).toBe('failed');
      // Any sane terminal code is fine; hanging or passing is not.
      expect([
        'STEP_NO_CONCLUSION',
        'MODEL_PROVIDER_FAILED',
        'MODEL_OUTPUT_INVALID',
        'STEP_BUDGET_EXHAUSTED',
      ]).toContain(result.attempts.at(-1)!.error?.code);
      expect(Date.now() - startedMs).toBeLessThan(30_000);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('runs ten sequential act steps with fresh budgets each', async () => {
    const executor: StepExecutor = {
      name: 'counter-executor',
      async runStep(context: StepExecutorContext) {
        const observation = await context.observe();
        const id = nodeIdFor(observation.text, /button "Increment"/);
        await context.actions.tap({ id });
        return { status: 'passed' as const, summary: 'tapped once' };
      },
    };
    const calls = Array.from({ length: 10 }, () => "  await agent.act('tap once');").join('\n');
    const suite = `import { test, expect } from 'e2e';

test('ten steps', async ({ app, agent, screen }) => {
  await app.open();
${calls}
  await expect(screen.getByRole('status')).toHaveText('10');
});
`;
    const { outcome, project } = await runProject(
      { 'tests/ten.e2e.ts': suite },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agent: { executor } } },
    );
    try {
      const result = resultByTitle(outcome, 'ten steps');
      expect(result.status).toBe('passed');
      const steps = result.attempts.at(-1)!.steps.filter((s) => s.api === 'agent.act');
      expect(steps).toHaveLength(10);
      for (const step of steps) expect(step.metrics!.actionSteps).toBe(1);
    } finally {
      project.cleanup();
    }
  }, 120_000);
});

describe('taxonomy and run derivation under mixed outcomes', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('every blockable code names a category; others name none', () => {
    for (const code of BLOCKABLE_CODES) {
      expect(blockedCategoryOf(code)).toBeDefined();
    }
    expect(blockedCategoryOf('CANCELLED')).toBeUndefined();
    expect(blockedCategoryOf('ACTION_FAILED')).toBeUndefined();
    expect(blockedCategoryOf('SEED_DATA_MISSING')).toBe('seed_data');
    expect(blockedCategoryOf('AUTH_CREDENTIAL_INVALID')).toBe('credentials');
  });

  it('blocks the run on a new code, but one real failure keeps it failed', async () => {
    const suite = `import { test } from 'e2e';

test('blocked by seed data', async ({ app, agent }) => {
  await app.open();
  await agent.act('needs seed data');
});

test('genuinely broken', async ({ app, agent }) => {
  await app.open();
  await agent.act('the app is broken');
});
`;
    const executor: StepExecutor = {
      name: 'mixed-executor',
      async runStep(context: StepExecutorContext) {
        if (context.step.instruction.includes('seed')) {
          return {
            status: 'blocked' as const,
            summary: 'no fixtures exist in this environment',
            errorCode: 'SEED_DATA_MISSING' as const,
          };
        }
        return { status: 'failed' as const, summary: 'the button does nothing' };
      },
    };
    const { outcome, project } = await runProject(
      { 'tests/mixed.e2e.ts': suite },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agent: { executor } } },
    );
    try {
      const blocked = resultByTitle(outcome, 'blocked by seed data');
      expect(blocked.attempts.at(-1)!.error?.code).toBe('SEED_DATA_MISSING');
      expect(
        blocked.attempts.at(-1)!.steps.find((s) => s.api === 'agent.act')?.status,
      ).toBe('blocked');
      // One genuine product failure outvotes the blocked result.
      expect(outcome.report.run.status).not.toBe('blocked');
    } finally {
      project.cleanup();
    }
  }, 120_000);
});

describe('config-file executor across worker processes', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('reconstructs the executor per worker and passes in parallel', async () => {
    const configSource = `import { defineConfig } from 'e2e';
import type { StepExecutor } from 'e2e';

const executor: StepExecutor = {
  name: 'worker-executor',
  version: '1',
  async runStep(context) {
    const observation = await context.observe();
    if (!observation.text.includes('Increment')) {
      return { status: 'failed', summary: 'unexpected page' };
    }
    return { status: 'passed', summary: 'saw the fixture home' };
  },
};

export default defineConfig({
  app: { url: process.env.APP_URL! },
  workers: 2,
  agent: { executor },
});
`;
    const testFile = (name: string) => `import { test } from 'e2e';

test('${name}', async ({ app, agent }) => {
  await app.open();
  await agent.act('look around');
});
`;
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/w1.e2e.ts': testFile('worker one'),
        'tests/w2.e2e.ts': testFile('worker two'),
        'tests/w3.e2e.ts': testFile('worker three'),
      },
      { appUrl: app.url, configSource },
    );
    try {
      expect(resultByTitle(outcome, 'worker one').status).toBe('passed');
      expect(resultByTitle(outcome, 'worker two').status).toBe('passed');
      expect(resultByTitle(outcome, 'worker three').status).toBe('passed');
      expect(outcome.exitCode).toBe(0);
    } finally {
      project.cleanup();
    }
  }, 180_000);
});

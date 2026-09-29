/**
 * Runner<->engine contract tests (`e2e/engine`). Drives the real
 * runner with an instrumented in-memory engine so the guarantees out-of-tree
 * engines rely on - lifecycle order, operation contexts, error mapping,
 * capability gating - can never silently regress.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { engineFailure } from '../helpers/engine-runtime.ts';
import { createFakeEngine, FAKE_APP_URL, type FakeEngineHandle } from '../helpers/fake-engine.ts';
import { engineConfig } from '../helpers/fixture-config.ts';
import { installFakeModel, judgment } from '../helpers/fake-model.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';
import type { E2EConfig } from '../../src/index.ts';
import { TestError } from '../../src/engine/index.ts';

const APP_URL = FAKE_APP_URL;

const PASSING_TEST = `import { test } from 'e2e';

test('taps a node', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Submit' }).tap();
});
`;

const OBSERVE_TEST = `import { test } from 'e2e';

test('asserts a node', async ({ app, agent }) => {
  await app.open('/');
  await agent.assert('the Submit button is visible');
});
`;

const WAIT_TEST = `import { test } from 'e2e';

test('waits for a condition', async ({ app, agent }) => {
  await app.open('/');
  await agent.waitFor('the Submit button is enabled', { interval: 100, timeout: 1500 });
});
`;

describe('runner <-> engine contract', () => {
  it(
    'hands init the harness-resolved facts and every attempt its own context',
    async () => {
      const fake = createFakeEngine();
      const { outcome, project } = await runProject(
        { 'tests/contract.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: engineConfig(fake.engine) },
      );
      expect(resultByTitle(outcome, 'taps a node').status).toBe('passed');
      expect(fake.inits).toHaveLength(1);
      const info = fake.inits[0]!;
      expect(info.app.site).toBe('127.0.0.1');
      expect((info.app as { baseUrl?: unknown }).baseUrl).toBeUndefined();
      expect((info as { testIdAttribute?: unknown }).testIdAttribute).toBeUndefined();
      expect(info.headed).toBe(false);
      expect(info.runId).toBe(outcome.report.run.id);
      expect(info.targetName).toBe('fake');

      expect(fake.attempts).toHaveLength(1);
      const attempt = fake.attempts[0]!;
      expect(attempt.artifactsDir.length).toBeGreaterThan(0);
      expect(attempt.attemptId).not.toBe('');
      expect(attempt.signal.aborted).toBe(false);

      const target = outcome.report.run.targets.find((entry) => entry.id === 'fake');
      expect(target?.engine).toEqual({ name: 'fake', version: '1.0.0', spiVersion: 1 });
      expect(target?.capabilities).toEqual(['actions', 'location', 'observation']);
      assertValidReport(outcome.report);
      project.cleanup();
    },
    60_000,
  );

  it(
    'runs init once, before the first attempt, and dispose once after the last',
    async () => {
      const fake = createFakeEngine();
      const files = {
        'tests/one.e2e.ts': PASSING_TEST,
        'tests/two.e2e.ts': `import { test } from 'e2e';

test('second test', async ({ app }) => {
  await app.open('/');
});

test('third test', async ({ app }) => {
  await app.open('/');
});
`,
      };
      const { outcome, project } = await runProject(files, {
        appUrl: APP_URL,
        config: engineConfig(fake.engine),
      });
      expect(outcome.exitCode).toBe(0);
      const stats = fake.stats();
      expect(stats.inits).toBe(1);
      expect(stats.disposes).toBe(1);
      expect(stats.maxConcurrentAttempts).toBe(1);
      expect(stats.attemptsStarted).toBe(3);
      expect(stats.attemptsEnded).toBe(3);
      expect(fake.events[0]).toBe('init');
      expect(fake.events.at(-1)).toBe('dispose');
      expect(fake.events.slice(1, -1)).toEqual([
        'startAttempt:0',
        'endAttempt:0',
        'startAttempt:1',
        'endAttempt:1',
        'startAttempt:2',
        'endAttempt:2',
      ]);
      project.cleanup();
    },
    60_000,
  );

  it(
    'classifies an init failure as infrastructure and never starts an attempt',
    async () => {
      const fake = createFakeEngine({
        onInit: () => {
          throw new Error('no device for you');
        },
      });
      const { outcome, project } = await runProject(
        { 'tests/init-fails.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: engineConfig(fake.engine) },
      );
      expect(outcome.exitCode).toBe(3);
      expect(fake.stats().attemptsStarted).toBe(0);
      const result = resultByTitle(outcome, 'taps a node');
      expect(result.attempts[0]!.error?.category).toBe('infrastructure');
      expect(result.attempts[0]!.error?.message).toContain('no device for you');
      assertValidReport(outcome.report);
      project.cleanup();
    },
    60_000,
  );

  it(
    'threads a consistent, live OperationContext through every engine call',
    async () => {
      const fake = createFakeEngine();
      const { outcome, project } = await runProject(
        { 'tests/ops.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: engineConfig(fake.engine) },
      );
      expect(outcome.exitCode).toBe(0);
      expect(fake.operations.length).toBeGreaterThan(2);
      for (const operation of fake.operations) {
        expect(operation.runId, operation.method).toBe(outcome.report.run.id);
        expect(operation.attemptId, operation.method).not.toBe('');
        expect(operation.timeoutMs, operation.method).toBeGreaterThanOrEqual(1);
        expect(operation.abortedAtCall, operation.method).toBe(false);
      }
      const attemptIds = new Set(fake.operations.map((operation) => operation.attemptId));
      expect(attemptIds.size).toBe(1);
      project.cleanup();
    },
    60_000,
  );

  it(
    'ends the attempt after a failure and starts a fresh one for the retry',
    async () => {
      const fake = createFakeEngine();
      // Attempts run in fresh module realms, so first-attempt state lives on disk.
      const file = `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'e2e';

test('flaky against engine', { retries: 1 }, async ({ app }) => {
  await app.open('/');
  const marker = process.env.ENGINE_CONTRACT_MARKER!;
  if (!existsSync(marker)) {
    writeFileSync(marker, 'attempted');
    throw new Error('first attempt fails');
  }
});
`;
      const marker = `/tmp/e2e-engine-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      process.env['ENGINE_CONTRACT_MARKER'] = marker;
      const { outcome, project } = await runProject(
        { 'tests/retry.e2e.ts': file },
        { appUrl: APP_URL, config: engineConfig(fake.engine) },
      );
      delete process.env['ENGINE_CONTRACT_MARKER'];
      rmSync(marker, { force: true });
      const result = resultByTitle(outcome, 'flaky against engine');
      expect(result.status).toBe('flaky');
      expect(fake.events.filter((event) => event.includes('Attempt'))).toEqual([
        'startAttempt:0',
        'endAttempt:0',
        'startAttempt:1',
        'endAttempt:1',
      ]);
      expect(fake.stats().maxConcurrentAttempts).toBe(1);
      project.cleanup();
    },
    60_000,
  );

  it(
    'classifies a startAttempt EngineError as infrastructure, never consuming retry budget',
    async () => {
      const fake = createFakeEngine({
        onStartAttempt() {
          throw engineFailure('ENGINE_FAILURE', 'engine exploded');
        },
      });
      const file = PASSING_TEST.replace(
        "test('taps a node',",
        "test('taps a node', { retries: 2 },",
      );
      const { outcome, project } = await runProject(
        { 'tests/launch-fail.e2e.ts': file },
        { appUrl: APP_URL, config: engineConfig(fake.engine) },
      );
      const result = resultByTitle(outcome, 'taps a node');
      expect(result.status).toBe('failed');
      const error = result.attempts[0]!.error;
      expect(error?.phase).toBe('launch');
      expect(error?.category).toBe('infrastructure');
      expect(error?.code).toBe('ENGINE_FAILURE');
      expect(error?.message).toContain('engine exploded');
      // Infrastructure failures are not retry-eligible: one attempt despite retries: 2.
      expect(result.attempts).toHaveLength(1);
      expect(outcome.exitCode).toBe(3);
      // A failed launch still ends the attempt it may have half-opened.
      expect(fake.stats().attemptsEnded).toBe(1);
      expect(fake.stats().disposes).toBe(1);
      project.cleanup();
    },
    60_000,
  );

  it(
    'classifies EngineErrors from fixture surfaces (app.open) with the canonical mapping',
    async () => {
      const failure = createFakeEngine({
        onNavigate() {
          throw engineFailure('ENGINE_FAILURE', 'renderer crashed');
        },
      });
      const { outcome, project } = await runProject(
        { 'tests/open-fail.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: engineConfig(failure.engine) },
      );
      const result = resultByTitle(outcome, 'taps a node');
      expect(result.status).toBe('failed');
      expect(result.attempts[0]!.error?.category).toBe('infrastructure');
      expect(result.attempts[0]!.error?.code).toBe('ENGINE_FAILURE');
      expect(outcome.exitCode).toBe(3);
      expect(failure.stats().attemptsEnded).toBe(1);
      project.cleanup();

      const unsupported = createFakeEngine({
        onNavigate() {
          throw engineFailure('UNSUPPORTED_CAPABILITY', 'deep links unsupported');
        },
      });
      const second = await runProject(
        { 'tests/open-unsupported.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: engineConfig(unsupported.engine) },
      );
      const secondResult = resultByTitle(second.outcome, 'taps a node');
      expect(secondResult.attempts[0]!.error?.category).toBe('configuration');
      expect(secondResult.attempts[0]!.error?.code).toBe('UNSUPPORTED_CAPABILITY');
      expect(second.outcome.exitCode).toBe(2);
      second.project.cleanup();
    },
    60_000,
  );

  it(
    'names APP_UNREACHABLE, with the URL, when the network refused the navigation',
    async () => {
      const refused = createFakeEngine({
        onNavigate(url) {
          throw engineFailure('ENGINE_FAILURE', `navigation failed: page.goto: net::ERR_CONNECTION_REFUSED at ${url}`);
        },
      });
      const { outcome, project } = await runProject(
        { 'tests/open-refused.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: engineConfig(refused.engine) },
      );
      const result = resultByTitle(outcome, 'taps a node');
      expect(result.status).toBe('failed');
      expect(result.attempts[0]!.error).toMatchObject({
        category: 'infrastructure',
        code: 'APP_UNREACHABLE',
        message: expect.stringMatching(
          /^nothing answered at http:\/\/\S+ \(ERR_CONNECTION_REFUSED\); start the app there, point the engine's url at where it runs, or give the engine a command so the runner starts it$/,
        ),
      });
      expect(outcome.exitCode).toBe(3);
      project.cleanup();
    },
    60_000,
  );

  it(
    'maps a hung startAttempt to an infrastructure LAUNCH_TIMEOUT',
    async () => {
      const fake = createFakeEngine({
        onStartAttempt: () => new Promise<never>(() => {}),
      });
      const { outcome, project } = await runProject(
        { 'tests/launch-hang.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: engineConfig(fake.engine, { launchTimeout: 1_000 }) },
      );
      const result = resultByTitle(outcome, 'taps a node');
      expect(result.status).toBe('failed');
      expect(result.attempts[0]!.error?.code).toBe('LAUNCH_TIMEOUT');
      expect(result.attempts[0]!.error?.category).toBe('infrastructure');
      // The hook that outlived its budget was told to stop, and the isolation
      // it may have opened was ended, so nothing of it can race a retry.
      expect(fake.attempts[0]!.signal.aborted).toBe(true);
      expect(fake.stats().attemptsEnded).toBe(1);
      project.cleanup();
    },
    60_000,
  );

  it(
    'a failing endAttempt marks cleanup failed with a secondary error but keeps the test passed',
    async () => {
      const fake = createFakeEngine({
        onEndAttempt() {
          throw new Error('close exploded');
        },
      });
      const { outcome, project } = await runProject(
        { 'tests/close-fail.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: engineConfig(fake.engine) },
      );
      const result = resultByTitle(outcome, 'taps a node');
      expect(result.status).toBe('passed');
      const attempt = result.attempts[0]!;
      expect(attempt.cleanup).toBe('failed');
      expect(attempt.secondaryErrors.some((error) => error.phase === 'cleanup')).toBe(true);
      expect(outcome.exitCode).toBe(0);
      project.cleanup();
    },
    60_000,
  );

  it(
    'a failure settleAttempt throws after the body is the verdict, with its own code',
    async () => {
      const fake = createFakeEngine({
        onSettleAttempt() {
          throw new TestError('ASSERTION_FAILED', 'a callback the body left running failed');
        },
      });
      const { outcome, project } = await runProject(
        { 'tests/settle-fail.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: engineConfig(fake.engine) },
      );
      const result = resultByTitle(outcome, 'taps a node');
      expect(result.status).toBe('failed');
      const attempt = result.attempts[0]!;
      expect(attempt.error).toMatchObject({ code: 'ASSERTION_FAILED', phase: 'body' });
      expect(attempt.cleanup).toBe('complete');
      expect(outcome.exitCode).toBe(1);
      project.cleanup();
    },
    60_000,
  );

  it(
    'a failing dispose is a cleanup run error and fails the run',
    async () => {
      const fake = createFakeEngine({
        onDispose() {
          throw new Error('device lease release exploded');
        },
      });
      const { outcome, project } = await runProject(
        { 'tests/dispose-fail.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: engineConfig(fake.engine) },
      );
      expect(resultByTitle(outcome, 'taps a node').status).toBe('passed');
      // Disposal happens after the last unit reported, so its error rides the
      // worker's final message; it must still reach the report and exit code.
      const disposal = outcome.report.run.errors.find((entry) =>
        entry.message.includes('device lease release exploded'),
      );
      expect(disposal?.phase).toBe('cleanup');
      expect(disposal?.category).toBe('infrastructure');
      expect(outcome.exitCode).toBe(3);
      assertValidReport(outcome.report);
      project.cleanup();
    },
    60_000,
  );

  it(
    'boots the same handle again after dispose when an in-process worker is retired for another target',
    async () => {
      const fake = createFakeEngine();
      const { outcome, project } = await runProject(
        { 'tests/two-targets.e2e.ts': PASSING_TEST },
        {
          appUrl: APP_URL,
          config: engineConfig(fake.engine, {
            targets: [
              { name: 'first', platform: 'web', engine: fake.engine },
              { name: 'second', platform: 'web', engine: fake.engine },
            ],
          }),
        },
      );
      expect(outcome.exitCode).toBe(0);
      // One in-process worker at a time: the first target's worker is disposed
      // before the second boots, on the very same config-held handle.
      const lifecycle = fake.events.filter((event) => event === 'init' || event === 'dispose');
      expect(lifecycle).toEqual(['init', 'dispose', 'init', 'dispose']);
      project.cleanup();
    },
    60_000,
  );

  it(
    'reaching a fixture the engine does not contribute is a configuration error',
    async () => {
      const fake = createFakeEngine();
      const file = `import { test } from 'e2e';

test('needs web', async ({ app, web }) => {
  await app.open('/');
  await web.goto('/somewhere');
});
`;
      const { outcome, project } = await runProject(
        { 'tests/no-web.e2e.ts': file },
        { appUrl: APP_URL, config: engineConfig(fake.engine) },
      );
      const result = resultByTitle(outcome, 'needs web');
      expect(result.status).toBe('failed');
      expect(result.attempts[0]!.error?.code).toBe('UNSUPPORTED_CAPABILITY');
      expect(result.attempts[0]!.error?.category).toBe('configuration');
      expect(result.attempts[0]!.error?.message).toContain('web');
      project.cleanup();
    },
    60_000,
  );

  it(
    'session.save without a state capability fails with UNSUPPORTED_CAPABILITY',
    async () => {
      const fake = createFakeEngine({ state: false });
      // Setup tests only run when a selected test depends on their session.
      const files = {
        'tests/no-state.setup.e2e.ts': `import { test } from 'e2e';

test.setup('capture session', { sessions: ['acct'] }, async ({ app, session }) => {
  await app.open('/');
  await session.save('acct');
});
`,
        'tests/wants-session.e2e.ts': `import { test } from 'e2e';

test('wants session', { session: 'acct' }, async ({ app }) => {
  await app.open('/');
});
`,
      };
      const { outcome, project } = await runProject(files, {
        appUrl: APP_URL,
        config: engineConfig(fake.engine),
      });
      const result = resultByTitle(outcome, 'capture session');
      expect(result.status).toBe('failed');
      expect(result.attempts[0]!.error?.code).toBe('UNSUPPORTED_CAPABILITY');
      expect(resultByTitle(outcome, 'wants session').status).not.toBe('passed');
      project.cleanup();
    },
    60_000,
  );

  it(
    'round-trips captured state into the dependent attempt via state.restore',
    async () => {
      const fake = createFakeEngine({ state: true });
      const files = {
        'tests/auth.setup.e2e.ts': `import { test } from 'e2e';

test.setup('capture session', { sessions: ['acct'] }, async ({ app, session }) => {
  await app.open('/');
  await session.save('acct');
});
`,
        'tests/uses-session.e2e.ts': `import { test } from 'e2e';

test('consumes session', { session: 'acct' }, async ({ app }) => {
  await app.open('/');
});
`,
      };
      const { outcome, project } = await runProject(files, {
        appUrl: APP_URL,
        config: engineConfig(fake.engine),
      });
      expect(resultByTitle(outcome, 'capture session').status).toBe('passed');
      expect(resultByTitle(outcome, 'consumes session').status).toBe('passed');
      expect(fake.capturedStates).toHaveLength(1);
      expect(fake.restoredStates).toHaveLength(1);
      expect(fake.restoredStates[0]).toMatchObject({ format: 'fake-state', version: 1, data: { ok: true } });
      project.cleanup();
    },
    60_000,
  );

  it(
    'retries retryable stale nodes against the engine and never repeats a possibly committed action',
    async () => {
      let performCalls = 0;
      const fake = createFakeEngine({
        perform() {
          performCalls += 1;
          if (performCalls === 1) {
            throw engineFailure('NODE_STALE', 'node went stale', true);
          }
        },
      });
      const { outcome, project } = await runProject(
        { 'tests/stale.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: engineConfig(fake.engine) },
      );
      expect(resultByTitle(outcome, 'taps a node').status).toBe('passed');
      expect(performCalls).toBe(2);

      let committedCalls = 0;
      const committed = createFakeEngine({
        perform() {
          committedCalls += 1;
          throw engineFailure('ACTION_MAY_HAVE_COMMITTED', 'maybe committed');
        },
      });
      const second = await runProject(
        { 'tests/committed.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: engineConfig(committed.engine) },
      );
      const result = resultByTitle(second.outcome, 'taps a node');
      expect(result.status).toBe('failed');
      expect(result.attempts[0]!.error?.code).toBe('ACTION_FAILED');
      expect(committedCalls).toBe(1);
      project.cleanup();
      second.project.cleanup();
    },
    60_000,
  );

  it(
    're-observes when an engine reports a retryable observation failure',
    async () => {
      let observeCalls = 0;
      const fake = createFakeEngine({
        observe() {
          observeCalls += 1;
          if (observeCalls === 1) {
            throw engineFailure('NODE_STALE', 'execution context was destroyed', true);
          }
        },
      });
      const model = installFakeModel(() => judgment(true, 'the Submit button is visible'));
      const { outcome, project } = await runProject(
        { 'tests/observe-race.e2e.ts': OBSERVE_TEST },
        { appUrl: APP_URL, config: engineConfig(fake.engine, { agents: { default: { model } } }) },
      );
      expect(resultByTitle(outcome, 'asserts a node').status).toBe('passed');
      expect(observeCalls).toBe(2);
      project.cleanup();
    },
    60_000,
  );

  it(
    'fails an agent call when a non-retryable observation failure repeats',
    async () => {
      const fake = createFakeEngine({
        observe() {
          throw engineFailure('ENGINE_FAILURE', 'observation is broken');
        },
      });
      const model = installFakeModel(() => judgment(true, 'unreachable'));
      const { outcome, project } = await runProject(
        { 'tests/observe-broken.e2e.ts': OBSERVE_TEST },
        { appUrl: APP_URL, config: engineConfig(fake.engine, { agents: { default: { model } } }) },
      );
      const result = resultByTitle(outcome, 'asserts a node');
      expect(result.status).toBe('failed');
      expect(result.attempts.at(-1)!.error?.code).toBe('APP_UNREACHABLE');
      project.cleanup();
    },
    60_000,
  );

  it(
    'leaves vision out of an inconclusive judgment on an engine that declares no screenshot capture',
    async () => {
      const fake = createFakeEngine();
      const model = installFakeModel(() => judgment('inconclusive', 'the tree lists no state for the Submit button'));
      const { outcome, project } = await runProject(
        { 'tests/observe-inconclusive.e2e.ts': OBSERVE_TEST },
        { appUrl: APP_URL, config: engineConfig(fake.engine, { agents: { default: { model } } }) },
      );
      const result = resultByTitle(outcome, 'asserts a node');
      expect(result.status).toBe('failed');
      const error = result.attempts.at(-1)!.error!;
      expect(error.code).toBe('ASSERTION_INCONCLUSIVE');
      // A retry with vision: true could only record UNSUPPORTED_CAPABILITY here.
      expect(error.message).toBe('the tree lists no state for the Submit button');
      project.cleanup();
    },
    60_000,
  );

  it(
    'words the vision hint as a condition on an engine that declares screenshots but has produced no pixels',
    async () => {
      // The SPI has no pixel-capture declaration: an engine with the artifacts
      // capability may still return no pixels from observe, as this one does.
      const fake = createFakeEngine({ artifacts: true });
      const model = installFakeModel(() => judgment('inconclusive', 'the tree lists no state for the Submit button'));
      const { outcome, project } = await runProject(
        { 'tests/observe-inconclusive-artifacts.e2e.ts': OBSERVE_TEST },
        { appUrl: APP_URL, config: engineConfig(fake.engine, { agents: { default: { model } } }) },
      );
      const error = resultByTitle(outcome, 'asserts a node').attempts.at(-1)!.error!;
      expect(error.code).toBe('ASSERTION_INCONCLUSIVE');
      expect(error.message).toBe(
        'the tree lists no state for the Submit button; the judge saw the semantic tree only; if the engine captures pixels, pass vision: true when the answer is in pixels',
      );
      project.cleanup();
    },
    60_000,
  );

  it(
    'leaves vision out of an inconclusive judgment once a pixel request of the attempt was degraded',
    async () => {
      // The engine declares screenshots and returns no pixels: the first
      // judgment asked for them, got the tree, and recorded the degradation.
      // Asking again could only degrade again, so the hint would send the
      // user down a path this attempt has already seen fail.
      const fake = createFakeEngine({ artifacts: true });
      const model = installFakeModel((call) =>
        call.instruction === 'the Submit button is visible'
          ? judgment(true, 'the Submit button is listed')
          : judgment('inconclusive', 'the tree lists no state for the Submit button'),
      );
      const { outcome, project } = await runProject(
        {
          'tests/observe-degraded.e2e.ts': `import { test } from 'e2e';

test('asserts after a degraded pixel request', async ({ app, agent }) => {
  await app.open('/');
  await agent.assert('the Submit button is visible', { vision: true });
  await agent.assert('the Submit button is enabled');
});
`,
        },
        { appUrl: APP_URL, config: engineConfig(fake.engine, { agents: { default: { model } } }) },
      );
      const attempt = resultByTitle(outcome, 'asserts after a degraded pixel request').attempts.at(-1)!;
      const [first, second] = attempt.steps.filter((step) => step.api === 'agent.assert');
      expect(first!.visionDegraded).toBe('UNSUPPORTED_CAPABILITY');
      expect(first!.visionInput).toBeUndefined();
      expect(second!.status).toBe('failed');
      expect(attempt.error!.code).toBe('ASSERTION_INCONCLUSIVE');
      expect(attempt.error!.message).toBe('the tree lists no state for the Submit button');
      project.cleanup();
    },
    60_000,
  );

  it(
    'reports the step timeout when an observation outlives the deadline that bounded it',
    async () => {
      // An observation is handed whatever remains of the invocation deadline,
      // so one starting near the end cannot finish. The engine failure that
      // follows describes a truncated budget, not a broken app.
      let observeCalls = 0;
      const fake = createFakeEngine({
        async observe(operation) {
          observeCalls += 1;
          if (observeCalls === 1) return;
          await new Promise((resolve) => setTimeout(resolve, operation.timeoutMs + 50));
          throw engineFailure('ENGINE_FAILURE', 'observation ran out of budget');
        },
      });
      const model = installFakeModel(() => judgment(false, 'the Submit button is disabled'));
      const { outcome, project } = await runProject(
        { 'tests/observe-deadline.e2e.ts': WAIT_TEST },
        { appUrl: APP_URL, config: engineConfig(fake.engine, { agents: { default: { model } } }) },
      );
      const result = resultByTitle(outcome, 'waits for a condition');
      expect(result.status).toBe('failed');
      expect(result.attempts.at(-1)!.error?.code).toBe('STEP_TIMEOUT');
      expect(result.attempts.at(-1)!.error?.message).toContain('the Submit button is disabled');
      project.cleanup();
    },
    60_000,
  );

  it(
    'surfaces UNSUPPORTED_ARTIFACT before any attempt when a target demands more than the engine offers',
    async () => {
      const fake = createFakeEngine();
      const { outcome, project } = await runProject(
        { 'tests/artifact.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: { targets: [{ name: 'fake', platform: 'fake', engine: fake.engine, trace: 'on' }] } },
      );
      expect(outcome.status).toBe('error');
      expect(fake.stats().attemptsStarted).toBe(0);
      expect(outcome.report.run.errors.find((error) => error.code === 'UNSUPPORTED_ARTIFACT')?.message).toBe(
        "target \"fake\" (engine fake) cannot record a trace, and the target sets trace: 'on'",
      );
      project.cleanup();
    },
    60_000,
  );

  it(
    'normalizes a plain Error thrown by an engine member to infrastructure ENGINE_FAILURE',
    async () => {
      const fake = createFakeEngine({
        onNavigate() {
          throw new TypeError('renderer gone');
        },
      });
      const { outcome, project } = await runProject(
        { 'tests/plain-error.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: engineConfig(fake.engine) },
      );
      const result = resultByTitle(outcome, 'taps a node');
      expect(result.status).toBe('failed');
      expect(result.attempts[0]!.error?.category).toBe('infrastructure');
      expect(result.attempts[0]!.error?.code).toBe('ENGINE_FAILURE');
      expect(result.attempts[0]!.error?.message).toContain('renderer gone');
      expect(outcome.exitCode).toBe(3);
      project.cleanup();
    },
    60_000,
  );

  it(
    'ends the attempt when session restore fails after it started',
    async () => {
      const fake = createFakeEngine({
        state: true,
        onRestore() {
          throw engineFailure('ENGINE_FAILURE', 'cannot seed storage');
        },
      });
      const files = {
        'tests/auth.setup.e2e.ts': `import { test } from 'e2e';

test.setup('capture session', { sessions: ['acct'] }, async ({ app, session }) => {
  await app.open('/');
  await session.save('acct');
});
`,
        'tests/uses-session.e2e.ts': `import { test } from 'e2e';

test('consumes session', { session: 'acct' }, async ({ app }) => {
  await app.open('/');
});
`,
      };
      const { outcome, project } = await runProject(files, {
        appUrl: APP_URL,
        config: engineConfig(fake.engine),
      });
      const result = resultByTitle(outcome, 'consumes session');
      expect(result.status).toBe('failed');
      expect(result.attempts[0]!.error?.code).toBe('ENGINE_FAILURE');
      expect(fake.stats().attemptsEnded).toBe(fake.stats().attemptsStarted);
      expect(fake.stats().maxConcurrentAttempts).toBe(1);
      project.cleanup();
    },
    60_000,
  );

  it(
    'runs a contributed fixture with harness discipline: steps, namespaces, accessors, bounds, matchers, artifacts',
    async () => {
      const fake = createFakeEngine({ fixtures: true });
      const file = `import { test, expect } from 'e2e';

test('drives the gadget', async (fixtures) => {
  const gadget = (fixtures as any).gadget;
  await gadget.poke('once');
  await gadget.knobs.turn('volume');
  if (gadget.describe() !== 'gadget on fake') throw new Error('accessor was wrapped');
  let thrown: unknown;
  try {
    gadget.broken();
  } catch (cause) {
    thrown = cause;
  }
  if (!(thrown instanceof Error) || thrown.message !== 'accessor broke') {
    throw new Error('a synchronous throw must stay a synchronous throw');
  }
  await gadget.slow({ timeout: 20 });
  await gadget.dropFile();
  await expect(gadget).toBePoked(1);
});

test('bounds a hanging fixture call', async (fixtures) => {
  await (fixtures as any).gadget.hang({ timeout: 200 });
});
`;
      const { outcome, project } = await runProject(
        { 'tests/gadget.e2e.ts': file },
        { appUrl: APP_URL, config: engineConfig(fake.engine, { actionTimeout: 2_000 }) },
      );
      const drives = resultByTitle(outcome, 'drives the gadget');
      expect(drives.status, JSON.stringify(drives.attempts[0]?.error)).toBe('passed');
      const steps = drives.attempts[0]!.steps;
      const apis = steps.map((step) => step.api);
      expect(apis).toEqual(
        expect.arrayContaining(['gadget.poke', 'gadget.knobs.turn', 'gadget.slow', 'gadget.dropFile', 'expect.toBePoked']),
      );
      // Undeclared synchronous accessors keep their identity and are never steps.
      expect(apis).not.toContain('gadget.describe');
      expect(apis).not.toContain('gadget.broken');
      expect(steps.find((step) => step.api === 'gadget.poke')?.label).toBe('once');
      expect(steps.find((step) => step.api === 'gadget.poke')?.kind).toBe('resource');
      expect(steps.find((step) => step.api === 'expect.toBePoked')?.kind).toBe('assertion');
      const dropped = steps.find((step) => step.api === 'gadget.dropFile');
      expect(dropped?.artifacts).toHaveLength(1);
      expect(drives.attempts[0]!.artifacts.some((artifact) => artifact.kind === 'log')).toBe(true);
      expect(fake.fixtureCalls).toEqual(['poke:once', 'turn:volume', 'slow']);

      const hangs = resultByTitle(outcome, 'bounds a hanging fixture call');
      expect(hangs.status).toBe('failed');
      expect(hangs.attempts[0]!.error?.code).toBe('ACTION_FAILED');
      expect(hangs.attempts[0]!.error?.message).toContain('gadget.hang exceeded its timeout of 200ms');
      assertValidReport(outcome.report);
      project.cleanup();
    },
    60_000,
  );

  it(
    'gates requires against the declared capability set at selection',
    async () => {
      const fake = createFakeEngine({ fixtures: true });
      const file = `import { test } from 'e2e';

test('needs gadget', { requires: ['gadget'] }, async () => {});
test('needs web', { requires: ['web'] }, async () => {});
`;
      const { outcome, project } = await runProject(
        { 'tests/requires.e2e.ts': file },
        { appUrl: APP_URL, config: engineConfig(fake.engine) },
      );
      expect(resultByTitle(outcome, 'needs gadget').status).toBe('passed');
      const web = resultByTitle(outcome, 'needs web');
      expect(web.status).toBe('skipped');
      expect(web.skip?.cause).toBe('capability-unavailable');
      project.cleanup();
    },
    60_000,
  );

  it(
    'registers an engine screenshot as an attempt artifact and reports unsupported gestures honestly',
    async () => {
      const fake = createFakeEngine({ artifacts: true });
      const file = `import { test } from 'e2e';

test('takes evidence', async ({ app }) => {
  await app.open('/');
  await app.screenshot('after-open');
});

test('swipes without a swipe capability', async ({ screen }) => {
  await screen.swipe({ direction: 'down' });
});
`;
      const { outcome, project } = await runProject(
        { 'tests/evidence.e2e.ts': file },
        { appUrl: APP_URL, config: engineConfig(fake.engine) },
      );
      const evidence = resultByTitle(outcome, 'takes evidence');
      expect(evidence.status).toBe('passed');
      expect(evidence.attempts[0]!.artifacts.some((artifact) => artifact.kind === 'screenshot')).toBe(true);
      expect(fake.operations.some((op) => op.method === 'artifacts.screenshot(after-open)')).toBe(true);
      const swipes = resultByTitle(outcome, 'swipes without a swipe capability');
      expect(swipes.status).toBe('failed');
      expect(swipes.attempts[0]!.error?.code).toBe('UNSUPPORTED_CAPABILITY');
      expect(swipes.attempts[0]!.error?.message).toContain('swipe');
      project.cleanup();
    },
    60_000,
  );

  it(
    'hands click modifiers only to an engine that declares tapModifiers, and refuses them before perform otherwise',
    async () => {
      const file = `import { test } from 'e2e';

test('shift-clicks', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByRole('button', { name: 'Submit' }).click({ modifiers: ['Shift'] });
});
`;
      const run = async (fake: FakeEngineHandle) => {
        const { outcome, project } = await runProject(
          { 'tests/modifiers.e2e.ts': file },
          { appUrl: APP_URL, config: engineConfig(fake.engine) },
        );
        project.cleanup();
        const result = resultByTitle(outcome, 'shift-clicks');
        return { result, performs: fake.callsOf(result.attempts[0]!.id, 'perform').map((call) => call.action) };
      };

      const declaring = await run(createFakeEngine({ tapModifiers: true }));
      expect(declaring.result.status).toBe('passed');
      expect(declaring.performs).toEqual([{ kind: 'tap', modifiers: ['Shift'] }]);

      const predating = await run(createFakeEngine());
      expect(predating.result.status).toBe('failed');
      expect(predating.result.attempts[0]!.error).toMatchObject({
        code: 'UNSUPPORTED_CAPABILITY',
        category: 'configuration',
        message: expect.stringContaining('modifiers on the "tap" action'),
      });
      expect(predating.performs).toEqual([]);
    },
    60_000,
  );
});

describe('video artifacts', () => {
  const FAILING_TEST = `import { test } from 'e2e';

test('fails on purpose', async ({ app }) => {
  await app.open('/');
  throw new Error('nope');
});
`;

  /** The video artifacts of one attempt of a result, the first by default. */
  const videosOf = (outcome: Awaited<ReturnType<typeof runProject>>['outcome'], title: string, attempt = 0) =>
    resultByTitle(outcome, title).attempts[attempt]!.artifacts.filter((artifact) => artifact.kind === 'video');

  /** A config that sets no recording, so `--video` is the only one asking. */
  const plainConfig = (fake: FakeEngineHandle): Partial<E2EConfig> => ({
    targets: [{ name: 'fake', platform: 'fake', engine: fake.engine }],
  });

  it(
    'applies --video best-effort: an engine that cannot record runs without one, and the run says so once',
    async () => {
      const fake = createFakeEngine({ artifacts: true });
      const notices: { target: string; message: string }[] = [];
      const { outcome, project } = await runProject(
        { 'tests/video.e2e.ts': PASSING_TEST },
        {
          appUrl: APP_URL,
          config: plainConfig(fake),
          runOptions: { video: 'on', onEvent: (event) => { if (event.type === 'notice') notices.push({ target: event.target, message: event.message }); } },
        },
      );
      expect(outcome.status).toBe('passed');
      expect(videosOf(outcome, 'taps a node')).toEqual([]);
      expect(notices).toEqual([
        { target: 'run', message: 'video records only on targets whose engine can record it; target "fake" (engine fake) records no video' },
      ]);
      project.cleanup();
    },
    60_000,
  );

  it(
    'records every attempt for --video: the segment is an artifact with its start time, marked unredacted',
    async () => {
      const fake = createFakeEngine({ video: true });
      const { outcome, project } = await runProject(
        { 'tests/video.e2e.ts': PASSING_TEST },
        // The default trace is best-effort: the fake has no trace, and the run does not mind.
        { appUrl: APP_URL, config: plainConfig(fake), runOptions: { video: 'on' } },
      );
      expect(outcome.status).toBe('passed');
      assertValidReport(outcome.report);
      const videos = videosOf(outcome, 'taps a node');
      expect(videos).toHaveLength(1);
      const video = videos[0]!;
      expect(video).toMatchObject({ mediaType: 'video/webm', redaction: 'incomplete', producer: { kind: 'attempt' } });
      expect(video.path).toMatch(/\/attempt-0\/video\/fake\.webm$/);
      expect(video.size).toBe(8);
      expect(Number.isNaN(Date.parse(video.startedAt!))).toBe(false);
      expect(existsSync(path.join(project.dir, '.e2e', 'artifacts', video.path!))).toBe(true);
      expect(fake.operations.map((op) => op.method)).toEqual(
        expect.arrayContaining(['artifacts.startVideo', 'artifacts.stopVideo']),
      );
      project.cleanup();
    },
    60_000,
  );

  it(
    'keeps only failed attempts with retain-on-failure',
    async () => {
      const fake = createFakeEngine({ video: true });
      const { outcome, project } = await runProject(
        { 'tests/pass.e2e.ts': PASSING_TEST, 'tests/fail.e2e.ts': FAILING_TEST },
        {
          appUrl: APP_URL,
          config: engineConfig(fake.engine, { video: 'retain-on-failure' }),
        },
      );
      expect(outcome.status).toBe('failed');
      expect(videosOf(outcome, 'taps a node')).toEqual([]);
      const passedDir = path.join(project.dir, '.e2e', 'artifacts', 'fake');
      expect(readdirSync(passedDir).some((entry) => entry.includes('pass'))).toBe(true);
      const kept = videosOf(outcome, 'fails on purpose');
      expect(kept).toHaveLength(1);
      expect(existsSync(path.join(project.dir, '.e2e', 'artifacts', kept[0]!.path!))).toBe(true);
      // The passing attempt's recording was written, then removed with its verdict.
      const passedVideos = readdirSync(passedDir, { recursive: true })
        .map(String)
        .filter((entry) => entry.endsWith('fake.webm') && entry.includes('pass'));
      expect(passedVideos).toEqual([]);
      project.cleanup();
    },
    60_000,
  );

  it(
    'fails the cleanup on an engine link that is not http(s), and still keeps its other recordings',
    async () => {
      const fake = createFakeEngine({ video: true, videoLinks: ['file:///tmp/r.mp4', 'https://recordings.example/r.mp4'] });
      const { outcome, project } = await runProject(
        { 'tests/video.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: engineConfig(fake.engine, { video: 'on' }) },
      );
      assertValidReport(outcome.report);
      const attempt = resultByTitle(outcome, 'taps a node').attempts[0]!;
      expect(attempt.cleanup).toBe('failed');
      expect(attempt.secondaryErrors).toEqual([expect.objectContaining({ code: 'ENGINE_FAILURE', message: expect.stringContaining('"file:///tmp/r.mp4"') })]);
      const videos = attempt.artifacts.filter((artifact) => artifact.kind === 'video');
      expect(videos.map((video) => video.url ?? video.path)).toEqual([
        'https://recordings.example/r.mp4',
        expect.stringMatching(/\/attempt-0\/video\/fake\.webm$/),
      ]);
      project.cleanup();
    },
    60_000,
  );

  it(
    'records only the first retry with on-first-retry, and nothing for a test that passes first time',
    async () => {
      const fake = createFakeEngine({ video: true });
      const { outcome, project } = await runProject(
        { 'tests/pass.e2e.ts': PASSING_TEST, 'tests/fail.e2e.ts': FAILING_TEST },
        { appUrl: APP_URL, config: engineConfig(fake.engine, { video: 'on-first-retry', retries: 1 }) },
      );
      expect(outcome.status).toBe('failed');
      expect(videosOf(outcome, 'taps a node')).toEqual([]);
      expect(videosOf(outcome, 'fails on purpose', 0)).toEqual([]);
      expect(videosOf(outcome, 'fails on purpose', 1)).toHaveLength(1);
      project.cleanup();
    },
    60_000,
  );

  it(
    'records every retry with on-all-retries',
    async () => {
      const fake = createFakeEngine({ video: true });
      const { outcome, project } = await runProject(
        { 'tests/fail.e2e.ts': FAILING_TEST },
        { appUrl: APP_URL, config: engineConfig(fake.engine, { video: 'on-all-retries', retries: 2 }) },
      );
      expect([0, 1, 2].map((attempt) => videosOf(outcome, 'fails on purpose', attempt).length)).toEqual([0, 1, 1]);
      project.cleanup();
    },
    60_000,
  );

  it(
    "lets a test's own video win over --video, and a target's win over the config",
    async () => {
      const fake = createFakeEngine({ video: true });
      const tests = `import { test } from 'e2e';

test('keeps quiet', { video: 'off' }, async ({ app }) => {
  await app.open('/');
});

test('follows the run', async ({ app }) => {
  await app.open('/');
});
`;
      const flagged = await runProject({ 'tests/video.e2e.ts': tests }, { appUrl: APP_URL, config: engineConfig(fake.engine), runOptions: { video: 'on' } });
      expect(videosOf(flagged.outcome, 'keeps quiet')).toEqual([]);
      expect(videosOf(flagged.outcome, 'follows the run')).toHaveLength(1);
      flagged.project.cleanup();

      const targeted = createFakeEngine({ video: true });
      const byTarget = await runProject(
        { 'tests/video.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: { targets: [{ name: 'fake', platform: 'fake', engine: targeted.engine, video: 'off' }], video: 'on' } },
      );
      expect(videosOf(byTarget.outcome, 'taps a node')).toEqual([]);
      byTarget.project.cleanup();
    },
    60_000,
  );

  it(
    'fails pre-flight only when a test that runs would record on an engine that cannot',
    async () => {
      const file = `import { test } from 'e2e';

test.describe('checkout', () => {
  test('records', { video: 'on' }, async ({ app }) => {
    await app.open('/');
  });
});
`;
      const fake = createFakeEngine({ artifacts: true });
      const refused = await runProject({ 'tests/video.e2e.ts': file }, { appUrl: APP_URL, config: engineConfig(fake.engine) });
      expect(refused.outcome.status).toBe('error');
      expect(fake.stats().attemptsStarted).toBe(0);
      expect(refused.outcome.report.run.errors.find((error) => error.code === 'UNSUPPORTED_ARTIFACT')?.message).toBe(
        "target \"fake\" (engine fake) cannot record video, and test \"checkout > records\" in tests/video.e2e.ts sets video: 'on'",
      );
      refused.project.cleanup();

      // A mode a target sets is required of its engine, like a test's.
      const targeted = createFakeEngine({ artifacts: true });
      const byTarget = await runProject(
        { 'tests/video.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: { targets: [{ name: 'fake', platform: 'fake', engine: targeted.engine, video: 'retain-on-failure' }] } },
      );
      expect(byTarget.outcome.report.run.errors.find((error) => error.code === 'UNSUPPORTED_ARTIFACT')?.message).toBe(
        "target \"fake\" (engine fake) cannot record video, and the target sets video: 'retain-on-failure'",
      );
      byTarget.project.cleanup();

      // on-first-retry with no retries never records, and a --video run whose tests all opt out asks nothing.
      for (const [config, runOptions, body] of [
        [{ video: 'on-first-retry' as const, retries: 0 }, {}, PASSING_TEST],
        [{}, { video: 'on' as const }, PASSING_TEST.replace("test('taps a node', async", "test('taps a node', { video: 'off' }, async")],
      ] as const) {
        const quiet = createFakeEngine({ artifacts: true });
        const run = await runProject({ 'tests/video.e2e.ts': body }, { appUrl: APP_URL, config: engineConfig(quiet.engine, config), runOptions });
        expect(run.outcome.status).toBe('passed');
        run.project.cleanup();
      }
    },
    60_000,
  );
});

describe('trace capability and plan notices', () => {
  /** Runs `files` on `fake` with `config` and returns the outcome with the run's notices. */
  const runWithNotices = async (fake: FakeEngineHandle, files: Record<string, string>, config: Partial<E2EConfig> = {}) => {
    const notices: string[] = [];
    const { outcome, project } = await runProject(files, {
      appUrl: APP_URL,
      config: engineConfig(fake.engine, config),
      runOptions: { onEvent: (event) => { if (event.type === 'notice' && event.target === 'run') notices.push(event.message); } },
    });
    project.cleanup();
    return { outcome, notices };
  };

  it(
    'applies a config trace best-effort, naming the targets that cannot trace, and says nothing for the default',
    async () => {
      const set = await runWithNotices(createFakeEngine({ artifacts: true }), { 'tests/a.e2e.ts': PASSING_TEST }, { trace: 'on' });
      expect(set.outcome.status).toBe('passed');
      expect(set.notices).toEqual(['trace records only on targets whose engine can record it; target "fake" (engine fake) records no trace']);
      const fallback = await runWithNotices(createFakeEngine({ artifacts: true }), { 'tests/a.e2e.ts': PASSING_TEST });
      expect(fallback.outcome.status).toBe('passed');
      expect(fallback.notices).toEqual([]);
    },
    60_000,
  );

  it(
    "refuses a test's trace on an engine that cannot trace, naming the test",
    async () => {
      const fake = createFakeEngine({ artifacts: true });
      const { outcome } = await runWithNotices(fake, {
        'tests/a.e2e.ts': PASSING_TEST.replace("test('taps a node', async", "test('taps a node', { trace: 'retain-on-failure' }, async"),
      });
      expect(outcome.status).toBe('error');
      expect(fake.stats().attemptsStarted).toBe(0);
      expect(outcome.report.run.errors.find((error) => error.code === 'UNSUPPORTED_ARTIFACT')?.message).toBe(
        "target \"fake\" (engine fake) cannot record a trace, and test \"taps a node\" in tests/a.e2e.ts sets trace: 'retain-on-failure'",
      );
    },
    60_000,
  );

  it(
    'warns at plan time that a retry mode with no retries records no traces',
    async () => {
      const fake = createFakeEngine({ trace: true });
      const { outcome, notices } = await runWithNotices(fake, { 'tests/a.e2e.ts': PASSING_TEST }, { trace: 'on-first-retry', retries: 0 });
      expect(outcome.status).toBe('passed');
      expect(notices).toEqual([
        "trace: 'on-first-retry' records retries only, and 1 test runs with retries: 0, so no traces will be recorded for it; set retries, or trace: 'on'",
      ]);
      expect(fake.operations.some((operation) => operation.method === 'artifacts.startTrace')).toBe(false);
    },
    60_000,
  );

  it(
    'warns at plan time that a retry mode with no retries records no videos, as for traces',
    async () => {
      const fake = createFakeEngine({ video: true });
      const { outcome, notices } = await runWithNotices(fake, { 'tests/a.e2e.ts': PASSING_TEST }, { video: 'on-all-retries', retries: 0 });
      expect(outcome.status).toBe('passed');
      expect(notices).toEqual([
        "video: 'on-all-retries' records retries only, and 1 test runs with retries: 0, so no videos will be recorded for it; set retries, or video: 'on'",
      ]);
      expect(fake.operations.some((operation) => operation.method === 'artifacts.startVideo')).toBe(false);
    },
    60_000,
  );

  it(
    'traces with the fake engine, keeping a passed attempt out of the report under retain-on-failure',
    async () => {
      const fake = createFakeEngine({ trace: true });
      const { outcome } = await runWithNotices(fake, { 'tests/a.e2e.ts': PASSING_TEST }, { trace: 'retain-on-failure' });
      expect(outcome.status).toBe('passed');
      const attempt = resultByTitle(outcome, 'taps a node').attempts[0]!;
      expect(attempt.artifacts.filter((artifact) => artifact.kind === 'trace')).toEqual([]);
      expect(existsSync(path.join(fake.attempts[0]!.artifactsDir, 'trace', 'fake.zip'))).toBe(false);
      expect(fake.operations.map((operation) => operation.method)).toEqual(expect.arrayContaining(['artifacts.startTrace', 'artifacts.stopTrace']));
    },
    60_000,
  );
});

describe('artifact directories', () => {
  /** A describe long enough that the two test ids below share their first 120 characters. */
  const LONG_DESCRIBE =
    'a returning customer with a saved card and an expired coupon on file who reloads the checkout page twice before paying';
  const SHARED_PREFIX_FILE = `import { test } from 'e2e';

test.describe(${JSON.stringify(LONG_DESCRIBE)}, () => {
  test('keeps the coupon after a reload', async ({ app }) => {
    await app.open('/');
    throw new Error('first');
  });

  test('drops the coupon after sign-out', async ({ app }) => {
    await app.open('/');
    throw new Error('second');
  });
});
`;

  it(
    'two failing tests whose ids share a 120-character prefix keep their evidence apart, on disk and in the report',
    async () => {
      const fake = createFakeEngine({ artifacts: true });
      const { outcome, project } = await runProject(
        { 'tests/checkouts.e2e.ts': SHARED_PREFIX_FILE },
        { appUrl: APP_URL, config: engineConfig(fake.engine) },
      );
      const first = resultByTitle(outcome, 'keeps the coupon after a reload');
      const second = resultByTitle(outcome, 'drops the coupon after sign-out');
      expect(first.test.id.slice(0, 120)).toBe(second.test.id.slice(0, 120));
      expect([first.status, second.status]).toEqual(['failed', 'failed']);

      const screenshotOf = (result: typeof first) =>
        result.attempts[0]!.artifacts.find((artifact) => artifact.kind === 'screenshot')!;
      const [a, b] = [screenshotOf(first), screenshotOf(second)];
      expect(a.path).not.toBe(b.path);
      expect(a.sha256).not.toBe(b.sha256);
      for (const artifact of [a, b]) {
        const absolute = path.join(project.dir, '.e2e', 'artifacts', artifact.path!);
        expect(existsSync(absolute)).toBe(true);
        expect(createHash('sha256').update(readFileSync(absolute)).digest('hex')).toBe(artifact.sha256);
      }
      // One directory per test under the target, not one written twice.
      expect(readdirSync(path.join(project.dir, '.e2e', 'artifacts', 'fake'))).toHaveLength(2);
      assertValidReport(outcome.report);
      project.cleanup();
    },
    60_000,
  );
});

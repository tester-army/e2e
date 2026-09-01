/**
 * Runner<->driver SPI contract tests (spec/api/driver.d.ts, spec/10-drivers.md).
 * Drives the real runner with an instrumented in-memory driver so the
 * guarantees third-party drivers rely on can never silently regress.
 */

import { describe, expect, it } from 'vitest';
import { createFakeDriver, BuiltDriverError, type FakeDriverHandle } from '../helpers/fake-driver.ts';
import { installFakeModel, judgment } from '../helpers/fake-model.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';
import type { E2EConfig } from '../../src/index.ts';

const APP_URL = 'http://127.0.0.1:4599';

function fakeConfig(fake: FakeDriverHandle, extra: Partial<E2EConfig> = {}): E2EConfig {
  return {
    specVersion: '0.1',
    app: { url: APP_URL },
    targets: [{ name: 'fake', platform: 'web', driver: fake.driver }],
    artifacts: [],
    ...extra,
  } as E2EConfig;
}

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
  await agent.waitFor('the Submit button is enabled', { intervalMs: 100, timeout: 1500 });
});
`;

describe('runner <-> driver contract', () => {
  it(
    'passes the documented launch context shape to the driver',
    async () => {
      const fake = createFakeDriver();
      const { outcome, project } = await runProject(
        { 'tests/contract.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: fakeConfig(fake) },
      );
      expect(resultByTitle(outcome, 'taps a node').status).toBe('passed');
      expect(fake.launches).toHaveLength(1);

      const context = fake.launches[0]!;
      expect(context.app.baseUrl).toContain('127.0.0.1:4599');
      expect(context.app.allowedOrigins.length).toBeGreaterThan(0);
      expect(context.app.environment).toBe('test');
      expect(context.app.allowProduction).toBe(false);
      expect(context.app.testIdAttribute).toBe('data-testid');
      expect(context.artifactsDir.length).toBeGreaterThan(0);
      expect(context.runId).toBe(outcome.report.run.id);
      expect(context.attemptId).not.toBe('');
      expect(context.launchOptions.headed).toBe(false);
      expect(context.operation.timeoutMs).toBeGreaterThan(0);
      expect(context.operation.signal.aborted).toBe(false);
      expect(context.targetId).toBe('fake');

      assertValidReport(outcome.report);
      project.cleanup();
    },
    60_000,
  );

  it(
    'runs prepare once, before any launch, with every target the driver serves',
    async () => {
      const fake = createFakeDriver();
      const { outcome, project } = await runProject(
        { 'tests/prepare.e2e.ts': PASSING_TEST },
        {
          appUrl: APP_URL,
          config: fakeConfig(fake, {
            targets: [
              { name: 'fake', platform: 'web', driver: fake.driver },
              { name: 'fake2', platform: 'web', driver: fake.driver },
            ],
          } as Partial<E2EConfig>),
        },
      );
      expect(outcome.exitCode).toBe(0);

      // Once per driver, not once per target: provisioning is shared backend
      // work, and repeating it per target would repeat the download.
      expect(fake.prepares).toHaveLength(1);
      expect(fake.prepares[0]!.map((entry) => entry.name).toSorted()).toEqual(['fake', 'fake2']);

      // Provisioning that ran after a launch would defeat its whole purpose.
      expect(fake.events[0]).toBe('prepare:2');
      expect(fake.events.indexOf('prepare:2')).toBeLessThan(
        fake.events.findIndex((event) => event.startsWith('launch:')),
      );
      project.cleanup();
    },
    60_000,
  );

  it(
    'aborts the run when prepare fails, before any session launches',
    async () => {
      const fake = createFakeDriver({
        onPrepare: () => {
          throw new Error('no browsers for you');
        },
      });
      const { outcome, project } = await runProject(
        { 'tests/prepare-fails.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: fakeConfig(fake) },
      );
      expect(outcome.exitCode).toBe(3);
      expect(fake.launches).toHaveLength(0);
      const errors = outcome.report.run.errors ?? [];
      expect(errors.some((entry) => entry.message.includes('no browsers for you'))).toBe(true);
      assertValidReport(outcome.report);
      project.cleanup();
    },
    60_000,
  );

  it(
    'threads a consistent, live OperationContext through every driver call',
    async () => {
      const fake = createFakeDriver();
      const { outcome, project } = await runProject(
        { 'tests/ops.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: fakeConfig(fake) },
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
    'strictly serializes sessions: never launches while a session is open, one fresh session per attempt',
    async () => {
      const fake = createFakeDriver();
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
        config: fakeConfig(fake),
      });
      expect(outcome.exitCode).toBe(0);
      const stats = fake.stats();
      expect(stats.maxConcurrentSessions).toBe(1);
      expect(stats.sessionsOpened).toBe(3);
      expect(stats.closes).toBe(3);
      expect(fake.events.filter((event) => event.startsWith('launch:') || event.startsWith('close:'))).toEqual([
        'launch:0',
        'close:0',
        'launch:1',
        'close:1',
        'launch:2',
        'close:2',
      ]);
      project.cleanup();
    },
    60_000,
  );

  it(
    'closes the session after a failing attempt and uses a fresh session for the retry',
    async () => {
      const fake = createFakeDriver();
      // Attempts run in fresh module realms, so first-attempt state lives on disk.
      const file = `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'e2e';

test('flaky against driver', { retries: 1 }, async ({ app }) => {
  await app.open('/');
  const marker = process.env.DRIVER_CONTRACT_MARKER!;
  if (!existsSync(marker)) {
    writeFileSync(marker, 'attempted');
    throw new Error('first attempt fails');
  }
});
`;
      const marker = `/tmp/e2e-driver-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      process.env['DRIVER_CONTRACT_MARKER'] = marker;
      const { outcome, project } = await runProject(
        { 'tests/retry.e2e.ts': file },
        { appUrl: APP_URL, config: fakeConfig(fake) },
      );
      const result = resultByTitle(outcome, 'flaky against driver');
      expect(result.status).toBe('flaky');
      expect(fake.events.filter((event) => event.startsWith('launch:') || event.startsWith('close:'))).toEqual([
        'launch:0',
        'close:0',
        'launch:1',
        'close:1',
      ]);
      expect(fake.stats().maxConcurrentSessions).toBe(1);
      project.cleanup();
    },
    60_000,
  );

  it(
    'disposes the driver exactly once, after every session is closed',
    async () => {
      const fake = createFakeDriver();
      const { outcome, project } = await runProject(
        { 'tests/dispose.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: fakeConfig(fake) },
      );
      expect(outcome.exitCode).toBe(0);
      expect(fake.stats().disposes).toBe(1);
      expect(fake.events[fake.events.length - 1]).toBe('dispose');
      expect(fake.events.indexOf('dispose')).toBeGreaterThan(fake.events.indexOf('close:0'));
      project.cleanup();
    },
    60_000,
  );

  it(
    'classifies a launch DriverError as infrastructure, never consuming retry budget',
    async () => {
      const fake = createFakeDriver({
        onLaunch() {
          throw new BuiltDriverError('DRIVER_FAILURE', 'backend exploded', { retryable: false });
        },
      });
      const file = PASSING_TEST.replace(
        "test('taps a node',",
        "test('taps a node', { retries: 2 },",
      );
      const { outcome, project } = await runProject(
        { 'tests/launch-fail.e2e.ts': file },
        { appUrl: APP_URL, config: fakeConfig(fake) },
      );
      const result = resultByTitle(outcome, 'taps a node');
      expect(result.status).toBe('failed');
      const error = result.attempts[0]!.error;
      expect(error?.phase).toBe('launch');
      expect(error?.category).toBe('infrastructure');
      expect(error?.code).toBe('DRIVER_FAILURE');
      expect(error?.message).toContain('backend exploded');
      // Infrastructure failures are not retry-eligible: one attempt despite retries: 2.
      expect(result.attempts).toHaveLength(1);
      expect(outcome.exitCode).toBe(3);
      expect(fake.stats().closes).toBe(0);
      expect(fake.stats().disposes).toBe(1);
      project.cleanup();
    },
    60_000,
  );

  it(
    'classifies DriverErrors from fixture surfaces (app.open) with the canonical mapping',
    async () => {
      const failure = createFakeDriver({
        onAppOpen() {
          throw new BuiltDriverError('DRIVER_FAILURE', 'renderer crashed', { retryable: false });
        },
      });
      const { outcome, project } = await runProject(
        { 'tests/open-fail.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: fakeConfig(failure) },
      );
      const result = resultByTitle(outcome, 'taps a node');
      expect(result.status).toBe('failed');
      expect(result.attempts[0]!.error?.category).toBe('infrastructure');
      expect(result.attempts[0]!.error?.code).toBe('DRIVER_FAILURE');
      expect(outcome.exitCode).toBe(3);
      expect(failure.stats().closes).toBe(1);
      project.cleanup();

      const unsupported = createFakeDriver({
        onAppOpen() {
          throw new BuiltDriverError('UNSUPPORTED_CAPABILITY', 'deep links unsupported', {
            retryable: false,
          });
        },
      });
      const second = await runProject(
        { 'tests/open-unsupported.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: fakeConfig(unsupported) },
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
    'maps a hung launch to an infrastructure LAUNCH_TIMEOUT',
    async () => {
      const fake = createFakeDriver({
        onLaunch: () => new Promise<never>(() => {}),
      });
      const { outcome, project } = await runProject(
        { 'tests/launch-hang.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: fakeConfig(fake, { launchTimeout: 1_000 }) },
      );
      const result = resultByTitle(outcome, 'taps a node');
      expect(result.status).toBe('failed');
      expect(result.attempts[0]!.error?.code).toBe('LAUNCH_TIMEOUT');
      expect(result.attempts[0]!.error?.category).toBe('infrastructure');
      project.cleanup();
    },
    60_000,
  );

  it(
    'a failing close marks cleanup failed with a secondary error but keeps the test passed',
    async () => {
      const fake = createFakeDriver({
        onClose() {
          throw new Error('close exploded');
        },
      });
      const { outcome, project } = await runProject(
        { 'tests/close-fail.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: fakeConfig(fake) },
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
    'requesting the web fixture from a driver without web support is a configuration error',
    async () => {
      const fake = createFakeDriver();
      const file = `import { test } from 'e2e';

test('needs web', async ({ app, web }) => {
  await app.open('/');
  await web.goto('/somewhere');
});
`;
      const { outcome, project } = await runProject(
        { 'tests/no-web.e2e.ts': file },
        { appUrl: APP_URL, config: fakeConfig(fake) },
      );
      const result = resultByTitle(outcome, 'needs web');
      expect(result.status).toBe('failed');
      expect(result.attempts[0]!.error?.code).toBe('UNSUPPORTED_CAPABILITY');
      expect(result.attempts[0]!.error?.category).toBe('configuration');
      project.cleanup();
    },
    60_000,
  );

  it(
    'session.save without driver state capture fails with UNSUPPORTED_CAPABILITY',
    async () => {
      const fake = createFakeDriver({ state: false });
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
        config: fakeConfig(fake),
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
    'round-trips captured state into the dependent test launch via restoreState',
    async () => {
      const fake = createFakeDriver({ state: true });
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
        config: fakeConfig(fake),
      });
      expect(resultByTitle(outcome, 'capture session').status).toBe('passed');
      expect(resultByTitle(outcome, 'consumes session').status).toBe('passed');
      expect(fake.capturedStates).toHaveLength(1);
      expect(fake.restoredStates).toHaveLength(1);
      expect(fake.restoredStates[0]).toMatchObject({
        format: 'fake-driver-state',
        version: 1,
      });
      project.cleanup();
    },
    60_000,
  );

  it(
    'retries retryable stale nodes against the driver and never repeats a possibly committed action',
    async () => {
      let performCalls = 0;
      const fake = createFakeDriver({
        perform() {
          performCalls += 1;
          if (performCalls === 1) {
            throw new BuiltDriverError('NODE_STALE', 'node went stale', { retryable: true });
          }
        },
      });
      const { outcome, project } = await runProject(
        { 'tests/stale.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: fakeConfig(fake) },
      );
      expect(resultByTitle(outcome, 'taps a node').status).toBe('passed');
      expect(performCalls).toBe(2);

      let committedCalls = 0;
      const committed = createFakeDriver({
        perform() {
          committedCalls += 1;
          throw new BuiltDriverError('ACTION_MAY_HAVE_COMMITTED', 'maybe committed', {
            retryable: false,
          });
        },
      });
      const second = await runProject(
        { 'tests/committed.e2e.ts': PASSING_TEST },
        { appUrl: APP_URL, config: fakeConfig(committed) },
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
    're-observes when a driver reports a retryable observation failure',
    async () => {
      let observeCalls = 0;
      const fake = createFakeDriver({
        observe() {
          observeCalls += 1;
          if (observeCalls === 1) {
            throw new BuiltDriverError('NODE_STALE', 'execution context was destroyed', {
              retryable: true,
            });
          }
        },
      });
      const model = installFakeModel(() => judgment(true, 'the Submit button is visible'));
      const { outcome, project } = await runProject(
        { 'tests/observe-race.e2e.ts': OBSERVE_TEST },
        { appUrl: APP_URL, config: fakeConfig(fake, { agent: { model } }) },
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
      const fake = createFakeDriver({
        observe() {
          throw new BuiltDriverError('DRIVER_FAILURE', 'observation is broken', {
            retryable: false,
          });
        },
      });
      const model = installFakeModel(() => judgment(true, 'unreachable'));
      const { outcome, project } = await runProject(
        { 'tests/observe-broken.e2e.ts': OBSERVE_TEST },
        { appUrl: APP_URL, config: fakeConfig(fake, { agent: { model } }) },
      );
      const result = resultByTitle(outcome, 'asserts a node');
      expect(result.status).toBe('failed');
      expect(result.attempts.at(-1)!.error?.code).toBe('APP_UNREACHABLE');
      project.cleanup();
    },
    60_000,
  );

  it(
    'reports the step timeout when an observation outlives the deadline that bounded it',
    async () => {
      // An observation is handed whatever remains of the invocation deadline,
      // so one starting near the end cannot finish. The driver failure that
      // follows describes a truncated budget, not a broken app, and reporting
      // it verbatim sent authors chasing infrastructure for a slow page.
      let observeCalls = 0;
      const fake = createFakeDriver({
        async observe(operation) {
          observeCalls += 1;
          // The first capture succeeds so the wait owns a judgment to report;
          // every later one outlives the shrinking budget it was handed.
          if (observeCalls === 1) return;
          await new Promise((resolve) => setTimeout(resolve, operation.timeoutMs + 50));
          throw new BuiltDriverError('DRIVER_FAILURE', 'observation ran out of budget', {
            retryable: false,
          });
        },
      });
      const model = installFakeModel(() => judgment(false, 'the Submit button is disabled'));
      const { outcome, project } = await runProject(
        { 'tests/observe-deadline.e2e.ts': WAIT_TEST },
        { appUrl: APP_URL, config: fakeConfig(fake, { agent: { model } }) },
      );
      const result = resultByTitle(outcome, 'waits for a condition');
      expect(result.status).toBe('failed');
      expect(result.attempts.at(-1)!.error?.code).toBe('STEP_TIMEOUT');
      // The wait still owns the message, so the last judgment survives.
      expect(result.attempts.at(-1)!.error?.message).toContain('the Submit button is disabled');
      project.cleanup();
    },
    60_000,
  );

  it(
    'surfaces UNSUPPORTED_ARTIFACT before any session launches when config demands more than the driver offers',
    async () => {
      const fake = createFakeDriver();
      const { outcome, project } = await runProject(
        { 'tests/artifact.e2e.ts': PASSING_TEST },
        {
          appUrl: APP_URL,
          config: fakeConfig(fake, { artifacts: ['video'] }),
        },
      );
      expect(outcome.status).toBe('error');
      expect(fake.stats().launches).toBe(0);
      expect(
        outcome.report.run.errors.some((error) => error.code === 'UNSUPPORTED_ARTIFACT'),
      ).toBe(true);
      project.cleanup();
    },
    60_000,
  );
});

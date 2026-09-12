/**
 * Post-run failure analysis end to end: a real browser run whose failures
 * leave failure-time evidence on the attempt, get analyzed by the configured
 * model after their last attempt with the project's instructions and
 * evidence, and carry the verdict on the event stream and in the report —
 * without the analysis ever touching a test's status.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { fakeCalls, installFakeModel } from '../helpers/fake-model.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import {
  createProject,
  resultByTitle,
  runExisting,
  type FixtureProject,
  type RunOutcome,
} from '../helpers/run-project.ts';
import type { RunEvent } from '../../src/run/events.ts';
import type { FailureAnalyzer, FailureContext, FailureEvidenceProvider } from '../../src/types.ts';

const SUITE = `import { test, expect } from 'e2e';

test('counter shows the wrong total', async ({ app, screen }) => {
  await app.open();
  await screen.getByRole('button', { name: 'Increment' }).tap();
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('2');
});

test('a link that does not exist', async ({ app, screen }) => {
  await app.open();
  await screen.getByRole('link', { name: 'About us' }).tap();
});

test('counter increments once', async ({ app, screen }) => {
  await app.open();
  await screen.getByRole('button', { name: 'Increment' }).tap();
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('1');
});
`;

const RUN_CONFIG = {
  tests: 'tests/**/*.e2e.ts',
  reporters: ['json'] as const,
  assertionTimeout: 500,
  actionTimeout: 1_500,
  cache: 'off' as const,
};

describe('failure analysis with the built-in analyzer', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let outcome: RunOutcome;
  const events: RunEvent[] = [];
  const seenByProvider: FailureContext[] = [];

  const gitDiff: FailureEvidenceProvider = {
    name: 'git diff',
    async collect(context) {
      seenByProvider.push(context);
      return '-  <output id="count">0</output>\n+  <output id="count" role="status">0</output>';
    },
  };
  const exploding: FailureEvidenceProvider = {
    name: 'server log',
    async collect() {
      throw new Error('log server down');
    },
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/analysis.e2e.ts': SUITE });
    const model = installFakeModel((call) => {
      if (call.schemaName !== 'failure-analysis') throw new Error(`unexpected call ${call.schemaName}`);
      return {
        classification: 'test-bug',
        confidence: 'high',
        summary: 'The counter shows 1 after one tap; the test expects 2.',
        evidence: ['error: expected "2", found "1"', 'screen: status "Counter" reads 1'],
        suggestedFix: 'Expect "1" after a single tap.',
        // The screen has this control, so the suggestion survives validation.
        suggestedLocator: { role: 'button', name: 'Increment' },
      };
    });
    outcome = await runExisting(project, {
      appUrl: app.url,
      config: {
        ...RUN_CONFIG,
        analysis: {
          model,
          maxFailures: 1,
          instructions: 'Controls are addressed by role and name; the app has no test ids.',
          evidence: [gitDiff, exploding],
        },
      },
      runOptions: {
        onEvent: (event) => {
          events.push(event);
        },
      },
    });
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('fails the run on the tests alone; analysis changes no status', () => {
    expect(outcome.exitCode).toBe(1);
    expect(resultByTitle(outcome, 'counter shows the wrong total').status).toBe('failed');
    expect(resultByTitle(outcome, 'a link that does not exist').status).toBe('failed');
    expect(resultByTitle(outcome, 'counter increments once').status).toBe('passed');
  });

  it('captures a masked screenshot and the redacted screen when the failure lands', () => {
    const result = resultByTitle(outcome, 'counter shows the wrong total');
    const attempt = result.attempts[0]!;
    expect(attempt.failure).toBeDefined();
    const screenshot = attempt.artifacts.find((artifact) => artifact.id === attempt.failure?.screenshot);
    const observation = attempt.artifacts.find((artifact) => artifact.id === attempt.failure?.screen);
    expect(screenshot).toMatchObject({ kind: 'screenshot', mediaType: 'image/png', redaction: 'complete' });
    expect(observation).toMatchObject({ kind: 'log', mediaType: 'text/plain' });
    const artifactsRoot = path.join(project.dir, '.e2e', 'artifacts');
    expect(existsSync(path.join(artifactsRoot, screenshot!.path!))).toBe(true);
    const snapshot = readFileSync(path.join(artifactsRoot, observation!.path!), 'utf8');
    expect(snapshot).toContain('# Screen at failure');
    expect(snapshot).toContain(`url: ${app.url}/`);
    expect(snapshot).toMatch(/status "Counter"/);
  });

  it('captures nothing for a passing attempt', () => {
    expect(resultByTitle(outcome, 'counter increments once').attempts[0]?.failure).toBeUndefined();
  });

  it('analyzes the first failure with the model and files the verdict on the result', () => {
    const result = resultByTitle(outcome, 'counter shows the wrong total');
    expect(result.analysis).toMatchObject({
      status: 'analyzed',
      analyzer: 'e2e-failure-analyst',
      classification: 'test-bug',
      confidence: 'high',
      summary: 'The counter shows 1 after one tap; the test expects 2.',
      suggestedFix: 'Expect "1" after a single tap.',
      suggestedLocator: { role: 'button', name: 'Increment' },
      sources: ['git diff'],
      model: { provider: 'fake', model: 'scripted', inputTokens: 100, outputTokens: 20 },
    });
    if (result.analysis?.status !== 'analyzed') throw new Error('expected an analyzed record');
    expect(result.analysis.artifacts).toEqual({
      screenshot: result.attempts[0]!.failure!.screenshot,
      screen: result.attempts[0]!.failure!.screen,
    });
  });

  it('gives the model the policy with the project instructions, then the error, the timeline, the evidence, and the screen', () => {
    expect(fakeCalls).toHaveLength(1);
    const call = fakeCalls[0]!;
    expect(call.system).toContain('You are the failure analyst');
    expect(call.system).toContain('Controls are addressed by role and name; the app has no test ids.');
    expect(call.prompt).toContain('<error>\ncategory: test\ncode: ');
    expect(call.prompt).toContain('expect.toHaveText');
    // In-process fixture runs load test files without source maps, so the
    // failing frame cannot be located and no source is sent rather than a
    // wrong line; the worker path (see the testbed suite) maps it.
    expect(call.prompt).not.toContain('<source>');
    expect(call.prompt).toContain('<evidence name="git diff">\n-  <output id="count">0</output>');
    // The provider that threw contributes nothing and stops nothing.
    expect(call.prompt).not.toContain('server log');
    expect(call.prompt).toContain('<screen>\nurl: ');
    expect(call.prompt).not.toContain('# Screen at failure');
    expect(call.prompt).toMatch(/status "Counter"/);
    // Vision is off by default: no image part.
    expect(call.images).toHaveLength(0);
  });

  it('hands each evidence provider the context so far, with the attempt artifacts by absolute path', () => {
    expect(seenByProvider).toHaveLength(1);
    const context = seenByProvider[0]!;
    expect(context.test.titlePath.at(-1)).toBe('counter shows the wrong total');
    expect(context.agent).toBe('default');
    expect(context.evidence).toEqual([]);
    expect(context.artifacts.map((artifact) => artifact.kind).toSorted()).toEqual(['log', 'screenshot', 'trace']);
    for (const artifact of context.artifacts) expect(path.isAbsolute(artifact.path)).toBe(true);
  });

  it('records later failures as unanalyzed once maxFailures is reached', () => {
    const result = resultByTitle(outcome, 'a link that does not exist');
    expect(result.analysis).toMatchObject({ status: 'unavailable', reason: 'limit-reached' });
  });

  it('streams each verdict as an analysis event after that test finished', () => {
    const analyses = events.filter((event) => event.type === 'analysis');
    expect(analyses).toHaveLength(2);
    for (const analysis of analyses) {
      if (analysis.type !== 'analysis') continue;
      const finished = events.findIndex(
        (event) => event.type === 'test-finished' && event.result.test.id === analysis.testId,
      );
      expect(finished).toBeGreaterThanOrEqual(0);
      expect(events.indexOf(analysis)).toBeGreaterThan(finished);
      expect(analysis.agent).toBe('default');
    }
    expect(events.at(-1)?.type).toBe('run-finished');
  });

  it('files the analysis as a namespaced report extension that validates', () => {
    assertValidReport(outcome.report);
    const reported = outcome.report.run.results.find((result) => result.titlePath.at(-1) === 'counter shows the wrong total');
    expect(reported?.extensions?.['e2edev.analysis']).toMatchObject({ status: 'analyzed', classification: 'test-bug' });
    const passed = outcome.report.run.results.find((result) => result.titlePath.at(-1) === 'counter increments once');
    expect(passed?.extensions).toBeUndefined();
  });
});

describe('failure analysis with a custom analyzer', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let outcome: RunOutcome;
  const seen: string[] = [];

  const analyzer: FailureAnalyzer = {
    name: 'throwing-then-verdict',
    async analyze(context) {
      seen.push(context.test.titlePath.join(' › '));
      if (context.test.titlePath.at(-1) === 'a link that does not exist') throw new Error('analyzer exploded');
      expect(context.observation).toMatch(/status "Counter"/);
      expect(context.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      return {
        classification: 'app-bug',
        confidence: 'medium',
        summary: 'Verdict from a host analyzer.',
        evidence: [`steps: ${context.attempts[0]!.steps.length} recorded`],
        // Not on the screen: dropped by the runner's validation, never printed.
        suggestedLocator: { role: 'link', name: 'Pricing' },
      };
    },
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/analysis.e2e.ts': SUITE });
    outcome = await runExisting(project, {
      appUrl: app.url,
      config: { ...RUN_CONFIG, analysis: { analyzer } },
    });
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('hands every analyzable failure to the analyzer and keeps its verdict', () => {
    expect(seen.toSorted()).toEqual(['a link that does not exist', 'counter shows the wrong total']);
    const analysis = resultByTitle(outcome, 'counter shows the wrong total').analysis;
    expect(analysis).toMatchObject({
      status: 'analyzed',
      analyzer: 'throwing-then-verdict',
      classification: 'app-bug',
      evidence: ['steps: 3 recorded'],
      sources: [],
    });
    expect(analysis).not.toHaveProperty('model');
    expect(analysis).not.toHaveProperty('suggestedLocator');
  });

  it('records a throwing analyzer as unavailable without failing the run', () => {
    expect(outcome.exitCode).toBe(1);
    expect(resultByTitle(outcome, 'a link that does not exist').analysis).toMatchObject({
      status: 'unavailable',
      reason: 'failed',
      message: 'analyzer exploded',
    });
    assertValidReport(outcome.report);
  });
});

describe('failure analysis of a flaky test', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let outcome: RunOutcome;
  const marker = `/tmp/e2e-analysis-flaky-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Attempts run in fresh module realms, so first-attempt state lives on disk.
  const FLAKY = `import { existsSync, writeFileSync } from 'node:fs';
import { test, expect } from 'e2e';

test('passes on the second attempt', { retries: 1 }, async ({ app, screen }) => {
  await app.open();
  const marker = process.env.E2E_ANALYSIS_MARKER!;
  if (!existsSync(marker)) {
    writeFileSync(marker, 'attempted');
    await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('99');
  }
});
`;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/flaky.e2e.ts': FLAKY });
    process.env['E2E_ANALYSIS_MARKER'] = marker;
    const model = installFakeModel(() => ({
      classification: 'flaky',
      confidence: 'medium',
      summary: 'The first attempt expected 99 and the retry passed.',
      evidence: ['previous-attempts: attempt 2 passed'],
    }));
    outcome = await runExisting(project, { appUrl: app.url, config: { ...RUN_CONFIG, analysis: { model } } });
  }, 120_000);

  afterAll(async () => {
    delete process.env['E2E_ANALYSIS_MARKER'];
    rmSync(marker, { force: true });
    project?.cleanup();
    await app?.close();
  });

  it('analyzes the failed attempt of a flaky result and leaves the run passing', () => {
    expect(outcome.exitCode).toBe(0);
    const result = resultByTitle(outcome, 'passes on the second attempt');
    expect(result.status).toBe('flaky');
    expect(result.attempts[0]?.failure).toBeDefined();
    expect(result.attempts[1]?.failure).toBeUndefined();
    expect(result.analysis).toMatchObject({ status: 'analyzed', classification: 'flaky' });
    expect(fakeCalls).toHaveLength(1);
    expect(fakeCalls[0]!.prompt).toContain('status: flaky (a later attempt passed)');
    expect(fakeCalls[0]!.prompt).toContain('<previous-attempts>\nattempt 2: passed');
  });
});

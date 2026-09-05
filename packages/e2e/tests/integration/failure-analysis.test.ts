/**
 * Post-failure analysis end to end: a real browser run whose failures leave
 * failure-time evidence on the attempt, get analyzed by the configured model
 * after their last attempt, and carry the verdict on the event stream and in
 * the report — without the analysis ever touching a test's status.
 */

import { existsSync, readFileSync } from 'node:fs';
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
import type { FailureAnalyzer } from '../../src/types.ts';

const SUITE = `import { test, expect } from '@e2edev/e2e';

test('counter shows the wrong total', async ({ app, screen }) => {
  await app.open();
  await screen.getByRole('button', { name: 'Increment' }).tap();
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('2');
});

test('a link that does not exist', async ({ app, screen }) => {
  await app.open();
  await screen.getByRole('link', { name: 'Pricing' }).tap();
});

test('counter increments once', async ({ app, screen }) => {
  await app.open();
  await screen.getByRole('button', { name: 'Increment' }).tap();
  await expect(screen.getByRole('status', { name: 'Counter' })).toHaveText('1');
});
`;

describe('failure analysis with the built-in analyzer', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let outcome: RunOutcome;
  const events: RunEvent[] = [];

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
      };
    });
    outcome = await runExisting(project, {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        reporters: ['json'] as const,
        assertionTimeout: 500,
        actionTimeout: 1_500,
        cache: 'off' as const,
        analysis: { model, maxFailures: 1 },
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
    expect(attempt.evidence).toBeDefined();
    expect(attempt.evidence?.pixelsTainted).toBe(false);
    const screenshot = attempt.artifacts.find((artifact) => artifact.id === attempt.evidence?.screenshot);
    const observation = attempt.artifacts.find((artifact) => artifact.id === attempt.evidence?.observation);
    expect(screenshot).toMatchObject({ kind: 'screenshot', mediaType: 'image/png', redaction: 'complete' });
    expect(observation).toMatchObject({ kind: 'log', mediaType: 'text/plain' });
    const artifactsRoot = path.join(project.dir, '.e2e', 'artifacts');
    expect(existsSync(path.join(artifactsRoot, screenshot!.path!))).toBe(true);
    const snapshot = readFileSync(path.join(artifactsRoot, observation!.path!), 'utf8');
    expect(snapshot).toContain('# e2e failure observation');
    expect(snapshot).toContain(`url: ${app.url}/`);
    expect(snapshot).toMatch(/status "Counter"/);
    // Both attach to the step that failed, so the report files them where the failure is.
    const failedStep = attempt.steps.find((step) => step.status === 'failed');
    expect(failedStep?.artifacts).toEqual(expect.arrayContaining([screenshot!.id, observation!.id]));
  });

  it('captures nothing for a passing attempt', () => {
    expect(resultByTitle(outcome, 'counter increments once').attempts[0]?.evidence).toBeUndefined();
  });

  it('analyzes the first failure with the model and files the verdict on the result', () => {
    const result = resultByTitle(outcome, 'counter shows the wrong total');
    expect(result.analysis).toMatchObject({
      status: 'analyzed',
      analyzer: 'e2e-failure-analyst',
      classification: 'test-bug',
      confidence: 'high',
      summary: 'The counter shows 1 after one tap; the test expects 2.',
      model: { provider: 'fake', model: 'scripted', inputTokens: 100, outputTokens: 20 },
    });
    if (result.analysis?.status !== 'analyzed') throw new Error('expected an analyzed record');
    expect(result.analysis.artifacts).toEqual({
      screenshot: result.attempts[0]!.evidence!.screenshot,
      observation: result.attempts[0]!.evidence!.observation,
    });
  });

  it('gives the model the error, the timeline, the failing source line, and the screen', () => {
    expect(fakeCalls).toHaveLength(1);
    const call = fakeCalls[0]!;
    expect(call.prompt).toContain('<error>\ncategory: test\ncode: ');
    expect(call.prompt).toContain('expect.toHaveText');
    // In-process fixture runs load test files without source maps, so the
    // failing frame cannot be located and no source is sent rather than a
    // wrong line; the worker path (see the testbed suite) maps it.
    expect(call.prompt).not.toContain('<source>');
    expect(call.prompt).toContain('<screen>\nurl: ');
    expect(call.prompt).not.toContain('# e2e failure observation');
    expect(call.prompt).toMatch(/status "Counter"/);
    // Vision is off by default: no image part.
    expect(call.images).toHaveLength(0);
  });

  it('records later failures as unanalyzed once maxFailures is reached', () => {
    const result = resultByTitle(outcome, 'a link that does not exist');
    expect(result.analysis).toMatchObject({ status: 'unavailable', reason: 'limit-reached' });
  });

  it('streams each verdict as an analysis event after that pair finished', () => {
    const analyses = events.filter((event) => event.type === 'analysis');
    expect(analyses).toHaveLength(2);
    for (const analysis of analyses) {
      if (analysis.type !== 'analysis') continue;
      const finished = events.findIndex(
        (event) => event.type === 'test-finished' && event.result.test.id === analysis.testId,
      );
      expect(finished).toBeGreaterThanOrEqual(0);
      expect(events.indexOf(analysis)).toBeGreaterThan(finished);
      expect(analysis.title).toBe(decodeURIComponent(analysis.testId.split('::').at(-1) ?? ''));
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
      };
    },
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/analysis.e2e.ts': SUITE });
    outcome = await runExisting(project, {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        reporters: ['json'] as const,
        assertionTimeout: 500,
        actionTimeout: 1_500,
        cache: 'off' as const,
        analysis: { analyzer },
      },
    });
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('hands every analyzable failure to the analyzer and keeps its verdict', () => {
    expect(seen.toSorted()).toEqual(['a link that does not exist', 'counter shows the wrong total']);
    expect(resultByTitle(outcome, 'counter shows the wrong total').analysis).toMatchObject({
      status: 'analyzed',
      analyzer: 'throwing-then-verdict',
      classification: 'app-bug',
      evidence: ['steps: 3 recorded'],
    });
    expect(resultByTitle(outcome, 'counter shows the wrong total').analysis).not.toHaveProperty('model');
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

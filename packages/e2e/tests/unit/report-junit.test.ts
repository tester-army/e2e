import { describe, expect, it } from 'vitest';
import type {
  Report1Document,
  ReportAttempt,
  ReportError,
  ReportResult,
  ReportSerialGroup,
} from '../../src/report/build.ts';
import { renderJunitReport } from '../../src/report/junit.ts';

const AT = '2026-01-01T00:00:00.000Z';

function error(overrides: Partial<ReportError> = {}): ReportError {
  return {
    category: 'test',
    code: 'ASSERTION_FAILED',
    message: 'expected "Sign in" to be visible',
    retryable: false,
    ...overrides,
  };
}

function attempt(overrides: Partial<ReportAttempt> = {}): ReportAttempt {
  return {
    id: 'attempt-1',
    index: 0,
    status: 'passed',
    startedAt: AT,
    durationMs: 1234,
    artifacts: [],
    secondaryErrors: [],
    cleanup: 'complete',
    steps: [],
    ...overrides,
  };
}

function result(overrides: Partial<ReportResult> = {}): ReportResult {
  return {
    id: 'result-1',
    testId: 'test-1',
    kind: 'test',
    declarationIndex: 0,
    titlePath: ['auth', 'signs in'],
    file: 'tests/auth.e2e.ts',
    source: { file: 'tests/auth.e2e.ts', line: 3, column: 1 },
    targetId: 'web',
    platform: 'web',
    status: 'passed',
    attempts: [attempt()],
    ...overrides,
  };
}

function report(
  overrides: {
    results?: ReportResult[];
    errors?: ReportError[];
    serialGroups?: ReportSerialGroup[];
  } = {},
): Report1Document {
  return {
    schemaVersion: 'report-1',
    run: {
      id: 'run-1',
      specVersion: '0.1',
      runner: { name: 'e2e', version: '0.0.0' },
      status: 'passed',
      exitCode: 0,
      startedAt: AT,
      finishedAt: AT,
      project: { id: 'project', configDigest: '0'.repeat(64) },
      environment: { ci: false, trustNoticeShown: false, os: 'test', arch: 'x64', runtime: 'node' },
      targets: [],
      serialGroups: overrides.serialGroups ?? [],
      results: overrides.results ?? [],
      errors: overrides.errors ?? [],
      summary: { discovered: 0, selected: 0, executed: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 },
      limits: {} as Report1Document['run']['limits'],
      usage: {
        discoveredResults: 0,
        maxAgentContextBytes: 0,
        maxLedgerBytes: 0,
        maxObservationBytes: 0,
        artifactBytes: 0,
        downloads: 0,
        events: 0,
        modelTokens: 0,
        maxModelCallsInStep: 0,
        maxActionStepsInStep: 0,
      },
    },
  };
}

function rootAttributes(xml: string): Record<string, string> {
  const match = /<testsuites ([^>]*)>/.exec(xml);
  if (match === null) throw new Error(`no <testsuites> root in:\n${xml}`);
  return Object.fromEntries([...match[1]!.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
}

describe('renderJunitReport', () => {
  it('starts with the XML declaration and ends with a newline', () => {
    const xml = renderJunitReport(report());
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites ')).toBe(true);
    expect(xml.endsWith('</testsuites>\n')).toBe(true);
  });

  it('renders an empty run as a root with zero counts and no suites', () => {
    const xml = renderJunitReport(report());
    expect(rootAttributes(xml)).toEqual({
      name: 'e2e',
      tests: '0',
      failures: '0',
      errors: '0',
      skipped: '0',
      time: '0.000',
    });
    expect(xml).not.toContain('<testsuite ');
  });

  it('renders a passed result as a bare testcase named by title path and target', () => {
    const xml = renderJunitReport(report({ results: [result()] }));
    expect(xml).toContain(
      '<testcase name="auth &gt; signs in [web]" classname="tests/auth.e2e.ts" time="1.234"/>',
    );
    expect(xml).toContain(
      '<testsuite name="tests/auth.e2e.ts" tests="1" failures="0" errors="0" skipped="0" time="1.234">',
    );
    expect(rootAttributes(xml)).toMatchObject({ tests: '1', failures: '0', errors: '0', skipped: '0' });
  });

  it('uses the final attempt for time and notes flaky passes in system-out', () => {
    const xml = renderJunitReport(
      report({
        results: [
          result({
            status: 'flaky',
            attempts: [
              attempt({ index: 0, status: 'failed', durationMs: 5000, error: error() }),
              attempt({ id: 'attempt-2', index: 1, durationMs: 800 }),
            ],
          }),
        ],
      }),
    );
    expect(xml).toContain('time="0.800">');
    expect(xml).toContain('<system-out>flaky: 1 failed attempt before passing</system-out>');
    expect(xml).not.toContain('<failure');
    expect(rootAttributes(xml)).toMatchObject({ tests: '1', failures: '0', errors: '0' });
  });

  it('renders a test-category error as <failure> with code, message, and body', () => {
    const xml = renderJunitReport(
      report({
        results: [result({ status: 'failed', attempts: [attempt({ status: 'failed', error: error() })] })],
      }),
    );
    expect(xml).toContain(
      '<failure message="expected &quot;Sign in&quot; to be visible" type="ASSERTION_FAILED">' +
        'ASSERTION_FAILED: expected &quot;Sign in&quot; to be visible</failure>',
    );
    expect(rootAttributes(xml)).toMatchObject({ failures: '1', errors: '0' });
  });

  it('renders infrastructure and configuration errors as <error>', () => {
    const infrastructure = error({
      category: 'infrastructure',
      code: 'DRIVER_CRASHED',
      message: 'gone',
      phase: 'launch',
    });
    const configuration = error({ category: 'configuration', code: 'MODEL_UNAVAILABLE', message: 'no model' });
    const xml = renderJunitReport(
      report({
        results: [
          result({ status: 'failed', attempts: [attempt({ status: 'failed', error: infrastructure })] }),
          result({
            id: 'result-2',
            testId: 'test-2',
            declarationIndex: 1,
            titlePath: ['agent', 'plans'],
            status: 'failed',
            attempts: [attempt({ status: 'failed', error: configuration })],
          }),
        ],
      }),
    );
    expect(xml).toContain('<error message="gone" type="DRIVER_CRASHED">DRIVER_CRASHED (launch): gone</error>');
    expect(xml).toContain(
      '<error message="no model" type="MODEL_UNAVAILABLE">MODEL_UNAVAILABLE: no model</error>',
    );
    expect(xml).not.toContain('<failure');
    expect(rootAttributes(xml)).toMatchObject({ tests: '2', failures: '0', errors: '2' });
  });

  it('falls back to the result status when a failed result carries no error', () => {
    const xml = renderJunitReport(
      report({
        results: [
          result({ status: 'timed-out', attempts: [attempt({ status: 'timed-out' })] }),
          result({
            id: 'result-2',
            testId: 'test-2',
            declarationIndex: 1,
            status: 'interrupted',
            attempts: [attempt({ status: 'interrupted' })],
          }),
        ],
      }),
    );
    expect(xml).toContain('<failure message="timed-out" type="timed-out">timed-out</failure>');
    expect(xml).toContain('<error message="interrupted" type="interrupted">interrupted</error>');
  });

  it('renders skipped results with their reason and no attempt time', () => {
    const xml = renderJunitReport(
      report({
        results: [
          result({
            status: 'skipped',
            attempts: [],
            skip: { cause: 'filtered', reason: 'tag filter excluded it' },
          }),
        ],
      }),
    );
    expect(xml).toContain('time="0.000">');
    expect(xml).toContain('<skipped message="tag filter excluded it"/>');
    expect(rootAttributes(xml)).toMatchObject({ tests: '1', skipped: '1' });
  });

  it('groups results into one suite per file, in report order', () => {
    const xml = renderJunitReport(
      report({
        results: [
          result({ file: 'tests/a.e2e.ts' }),
          result({ id: 'result-2', testId: 'test-2', file: 'tests/b.e2e.ts' }),
          result({ id: 'result-3', testId: 'test-3', file: 'tests/a.e2e.ts', targetId: 'webkit' }),
        ],
      }),
    );
    const suites = [...xml.matchAll(/<testsuite name="([^"]*)" tests="(\d+)"/g)].map((m) => [m[1], m[2]]);
    expect(suites).toEqual([
      ['tests/a.e2e.ts', '2'],
      ['tests/b.e2e.ts', '1'],
    ]);
    expect(xml).toContain('[webkit]');
  });

  it('escapes markup in attributes and text and strips control characters', () => {
    const xml = renderJunitReport(
      report({
        results: [
          result({
            titlePath: ['<b>bold</b> & "quoted"'],
            status: 'failed',
            attempts: [
              attempt({
                status: 'failed',
                error: error({ message: 'line one\nline <two> & done' }),
              }),
            ],
          }),
        ],
      }),
    );
    expect(xml).toContain('name="&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot; [web]"');
    expect(xml).toContain('message="line one&#10;line &lt;two&gt;� &amp; done"');
    expect(xml).toContain('>ASSERTION_FAILED: line one\nline &lt;two&gt;� &amp; done</failure>');
    expect(xml).not.toContain('');
  });

  it('adds a run suite with one <error> case per run-level error', () => {
    const xml = renderJunitReport(
      report({
        errors: [
          error({
            category: 'infrastructure',
            code: 'APP_UNREACHABLE',
            message: 'http://127.0.0.1:3000 did not answer',
            phase: 'launch',
          }),
        ],
      }),
    );
    expect(xml).toContain(
      '<testsuite name="run" tests="1" failures="0" errors="1" skipped="0" time="0.000">',
    );
    expect(xml).toContain('<testcase name="APP_UNREACHABLE (launch)" classname="run" time="0.000">');
    expect(xml).toContain(
      '<error message="http://127.0.0.1:3000 did not answer" type="APP_UNREACHABLE">' +
        'infrastructure error APP_UNREACHABLE (launch): http://127.0.0.1:3000 did not answer</error>',
    );
    expect(rootAttributes(xml)).toMatchObject({ tests: '1', errors: '1' });
  });

  it('reads a serial member from its group attempt', () => {
    const group: ReportSerialGroup = {
      id: 'group-1',
      serialId: 'checkout',
      declarationIndex: 0,
      file: 'tests/checkout.e2e.ts',
      source: { file: 'tests/checkout.e2e.ts', line: 1, column: 1 },
      titlePath: ['checkout'],
      targetId: 'web',
      platform: 'web',
      memberTestIds: ['test-1', 'test-2'],
      status: 'failed',
      attempts: [
        {
          ...attempt({ status: 'failed', durationMs: 3000 }),
          members: [
            {
              id: 'member-1',
              index: 0,
              testId: 'test-1',
              status: 'passed',
              startedAt: AT,
              durationMs: 1000,
              steps: [],
              secondaryErrors: [],
            },
            {
              id: 'member-2',
              index: 1,
              testId: 'test-2',
              status: 'failed',
              startedAt: AT,
              durationMs: 2000,
              steps: [],
              error: error({ message: 'cart is empty' }),
              secondaryErrors: [],
            },
          ],
        },
      ],
    };
    const xml = renderJunitReport(
      report({
        serialGroups: [group],
        results: [
          result({
            file: 'tests/checkout.e2e.ts',
            titlePath: ['checkout', 'adds'],
            serialGroupId: 'group-1',
            attempts: [],
          }),
          result({
            id: 'result-2',
            testId: 'test-2',
            declarationIndex: 1,
            file: 'tests/checkout.e2e.ts',
            titlePath: ['checkout', 'pays'],
            serialGroupId: 'group-1',
            status: 'failed',
            attempts: [],
          }),
        ],
      }),
    );
    expect(xml).toContain(
      '<testcase name="checkout &gt; adds [web]" classname="tests/checkout.e2e.ts" time="1.000"/>',
    );
    expect(xml).toContain(
      '<testcase name="checkout &gt; pays [web]" classname="tests/checkout.e2e.ts" time="2.000">',
    );
    expect(xml).toContain('<failure message="cart is empty" type="ASSERTION_FAILED">');
  });
});

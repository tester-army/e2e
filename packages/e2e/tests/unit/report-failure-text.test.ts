/**
 * The facts a failure block and a failure page share, and the page itself:
 * an error's structured details as lines, whether the attempts failed alike,
 * the line to look at, the last model turns, the screen at failure, and the
 * evidence of the attempt that failed.
 */

import { describe, expect, it } from 'vitest';
import type { ReportAttempt, ReportResult, ReportStep } from '../../src/report/build.ts';
import type { ReportSerialGroup } from '../../src/report/build.ts';
import { attemptsLine, detailLines, evidenceOf, failureSource, lastTurnsLine, renderFailurePage, screenLine, toldAttempt } from '../../src/report/failure-text.ts';
import { outcome } from '../../src/report/outcome.ts';
import { reportAttempt, reportDocument, reportError, reportResult, reportStep, reportTarget } from '../helpers/report.ts';

const UNKNOWN = { file: 'unknown', line: 1, column: 1 };
const NO_GROUPS = new Map<string, ReportSerialGroup>();

function step(overrides: Partial<ReportStep> & Pick<ReportStep, 'index'>): ReportStep {
  return reportStep({ id: `s${overrides.index}`, label: `step ${overrides.index}`, source: UNKNOWN, ...overrides });
}

function failed(overrides: Partial<ReportAttempt> = {}): ReportAttempt {
  return reportAttempt({ status: 'failed', error: reportError(), steps: [step({ index: 0 }), step({ index: 1, status: 'failed' })], ...overrides });
}

function result(overrides: Partial<ReportResult> = {}): ReportResult {
  return reportResult({ status: 'failed', attempts: [failed()], ...overrides });
}

describe('detailLines', () => {
  it("lays an assertion's expected and observed on one line with the match count, and says what a locator asked for and how long it waited", () => {
    expect(detailLines(reportError({ details: { locator: 'getByRole("status")', expected: 'text "2 remaining"', observed: 'text "1 remaining"', matches: 1 } }))).toEqual([
      'Expected: text "2 remaining" · Observed: text "1 remaining" (1 match)',
    ]);
    expect(detailLines(reportError({ details: { locator: 'x', role: 'button', name: 'Add todo item', waitedMs: 3000 } }))).toEqual(['Asked for: button "Add todo item" · waited 3.0s']);
    expect(detailLines(reportError({ details: { testId: 'todo' } }))).toEqual(['Asked for: test id "todo"']);
  });

  it('states a bare match count, escapes what a test wrote, and says nothing for an error without details', () => {
    expect(detailLines(reportError({ details: { matches: 3 } }))).toEqual(['Matched: 3 matches']);
    expect(detailLines(reportError({ details: { expected: 'two <b>labels</b>' } }))).toEqual(['Expected: two &lt;b&gt;labels&lt;/b&gt;']);
    expect(detailLines(reportError())).toEqual([]);
    expect(detailLines(undefined)).toEqual([]);
  });
});

describe('attemptsLine', () => {
  it('says nothing for one attempt, calls out attempts that failed alike, and names the codes when they differ', () => {
    expect(attemptsLine(result(), outcome(result(), NO_GROUPS))).toBeUndefined();
    const alike = result({ attempts: [failed(), failed()] });
    expect(attemptsLine(alike, outcome(alike, NO_GROUPS))).toBe('Failed the same way on both attempts: **ASSERTION_FAILED** at step 2.');
    const three = result({ attempts: [failed(), failed(), failed()] });
    expect(attemptsLine(three, outcome(three, NO_GROUPS))).toBe('Failed the same way on all 3 attempts: **ASSERTION_FAILED** at step 2.');
    const differing = result({
      attempts: [failed({ error: reportError({ code: 'LOCATOR_NOT_FOUND' }), steps: [step({ index: 0, status: 'failed' })] }), failed()],
    });
    expect(attemptsLine(differing, outcome(differing, NO_GROUPS))).toBe('Failed differently on both attempts: **LOCATOR_NOT_FOUND** at step 1, then **ASSERTION_FAILED** at step 2.');
  });

  it('tells a flaky test its failures agreed, and ignores an attempt that never reached the test', () => {
    const flaky = result({ status: 'flaky', attempts: [failed(), failed(), reportAttempt({ status: 'passed' })] });
    expect(attemptsLine(flaky, outcome(flaky, NO_GROUPS))).toBe('Failed the same way on 2 attempts: **ASSERTION_FAILED** at step 2. The retry that passed is the exception.');
    const launchFailed = result({ attempts: [reportAttempt({ status: 'failed' }), failed()] });
    expect(attemptsLine(launchFailed, outcome(launchFailed, NO_GROUPS))).toBeUndefined();
  });
});

describe('failureSource', () => {
  it("prefers the line the error unwound through, then the failing step's own call, then the test's declaration", () => {
    const fromError = result({ attempts: [failed({ error: reportError({ source: { file: 'tests/a.e2e.ts', line: 14, column: 3 } }) })] });
    expect(failureSource(fromError, toldAttempt(fromError, outcome(fromError, NO_GROUPS)))).toEqual({ file: 'tests/a.e2e.ts', line: 14, column: 3 });
    const fromStep = result({ attempts: [failed({ steps: [step({ index: 0 }), step({ index: 1, status: 'failed', source: { file: 'tests/a.e2e.ts', line: 9, column: 5 } })] })] });
    expect(failureSource(fromStep, toldAttempt(fromStep, outcome(fromStep, NO_GROUPS)))).toEqual({ file: 'tests/a.e2e.ts', line: 9, column: 5 });
    const declared = result();
    expect(failureSource(declared, toldAttempt(declared, outcome(declared, NO_GROUPS)))).toEqual(declared.source);
  });
});

describe('lastTurnsLine and screenLine', () => {
  it('shows the last turns without the verdict turn, counting the earlier ones, and reads a turn as its calls and the first line back', () => {
    const turns = [1, 2, 3, 4, 5].map((index) => ({ index, calls: [`tap({"target":"n${index}"})`], outcome: `Tapped #n${index}.\n\nScreen changes: 1 changed.` }));
    turns.push({ index: 6, calls: ['complete_step({"status":"failed"})'], outcome: 'Step concluded.' });
    const line = lastTurnsLine(step({ index: 1, kind: 'agent', api: 'agent.act', status: 'failed', turns }));
    expect(line).toBe('Last turns: … 2 earlier · 3. `tap({"target":"n3"})` → Tapped #n3. · 4. `tap({"target":"n4"})` → Tapped #n4. · 5. `tap({"target":"n5"})` → Tapped #n5.');
    expect(lastTurnsLine(step({ index: 1, kind: 'agent', api: 'agent.act', status: 'failed', turns: [{ index: 1, calls: [], outcome: 'nothing' }] }))).toBe('Last turns: 1. no tool call → nothing');
    expect(lastTurnsLine(step({ index: 1 }))).toBeUndefined();
  });

  it('names the location and the nodes closest to a failed locator, capped, and nothing without evidence', () => {
    const told = toldAttempt(result(), outcome(result({ attempts: [failed({ failure: { url: 'http://app.test/todos', candidates: ['#n1 button "Add"', '#n2 button "Add all"', '#n3 link "Todos"', '#n4 text="Add"'] } })] }), NO_GROUPS));
    expect(screenLine(told)).toBe('Screen: http://app.test/todos · closest to the locator: `#n1 button "Add"`, `#n2 button "Add all"`, `#n3 link "Todos"`, and 1 more');
    expect(screenLine(toldAttempt(result(), outcome(result(), NO_GROUPS)))).toBeUndefined();
  });
});

describe('evidenceOf', () => {
  it("puts the failure's own screenshot and screen text first, then one artifact per kind, and never a log the failure did not capture", () => {
    const artifacts: ReportAttempt['artifacts'] = [
      { id: 'a:0', kind: 'trace', mediaType: 'application/zip', path: 't/trace.zip', redaction: 'not-required', producer: { kind: 'attempt' } },
      { id: 'a:1', kind: 'log', mediaType: 'text/plain', path: 't/transcript.txt', redaction: 'complete', producer: { kind: 'attempt' } },
      { id: 'a:2', kind: 'screenshot', mediaType: 'image/png', path: 't/001-assert.png', redaction: 'complete', producer: { kind: 'attempt' } },
      { id: 'a:3', kind: 'screenshot', mediaType: 'image/png', path: 't/002-failure.png', redaction: 'complete', producer: { kind: 'attempt' } },
      { id: 'a:4', kind: 'log', mediaType: 'text/plain', path: 't/failure/screen.txt', redaction: 'complete', producer: { kind: 'attempt' } },
    ];
    const told = toldAttempt(result(), outcome(result({ attempts: [failed({ artifacts, failure: { screenshot: 'a:3', screen: 'a:4' } })] }), NO_GROUPS));
    expect(evidenceOf(told).map((artifact) => artifact.id)).toEqual(['a:3', 'a:4', 'a:0', 'a:2']);
  });
});

describe('renderFailurePage', () => {
  const page = (attempts: ReportAttempt[], readArtifact?: (reportPath: string) => string | undefined) => {
    const failing = reportResult({
      id: 'r1',
      titlePath: ['todos', 'archives a todo'],
      file: 'tests/todos.e2e.ts',
      status: 'failed',
      attempts,
    });
    const document = reportDocument({ status: 'failed', exitCode: 1, targets: [reportTarget()], results: [failing] });
    return renderFailurePage(document, failing, outcome(failing, NO_GROUPS), { artifactsDir: '.e2e/artifacts', readArtifact });
  };

  it('tells the whole story: the error in full, its facts, the line, every step, the turns, the screen inline, and the evidence', () => {
    const screen = { id: 'a:0', kind: 'log' as const, mediaType: 'text/plain', path: 't/failure/screen.txt', redaction: 'complete' as const, producer: { kind: 'attempt' as const } };
    const shot = { id: 'a:1', kind: 'screenshot' as const, mediaType: 'image/png', path: 't/001-failure.png', redaction: 'complete' as const, producer: { kind: 'attempt' as const } };
    const body = page(
      [
        failed({
          error: reportError({
            code: 'ASSERTION_FAILED',
            message: 'agent.act failed: no Archive button',
            source: { file: 'tests/todos.e2e.ts', line: 8, column: 3 },
          }),
          steps: [
            step({ index: 0, kind: 'app', api: 'app.open', label: '/todos', durationMs: 40, source: { file: 'tests/todos.e2e.ts', line: 4, column: 9 } }),
            step({
              index: 1,
              kind: 'agent',
              api: 'agent.act',
              label: 'Archive the todo',
              status: 'failed',
              durationMs: 16_100,
              metrics: { modelCalls: 6, actionSteps: 4, observationBytes: 1, contextBytes: 1, ledgerBytes: 1 },
              explanation: 'no Archive button',
              turns: [
                { index: 1, calls: ['tap({"target":"n19"})'], outcome: 'Tapped #n19.\n\nScreen changes: 4 added.' },
                { index: 2, calls: ['complete_step({"status":"failed"})'], outcome: 'Step concluded.' },
              ],
              error: reportError({ code: 'ASSERTION_FAILED', message: 'no Archive button' }),
            }),
          ],
          artifacts: [screen, shot],
          failure: { url: 'http://app.test/todos', screen: 'a:0', screenshot: 'a:1' },
        }),
      ],
      (reportPath) => (reportPath === 't/failure/screen.txt' ? '# Screen at failure\n\n#n1 document "Todos"\n #n19 button "Add"\n' : undefined),
    );
    expect(body).toBe(
      [
        '# ✗ todos › archives a todo',
        '',
        '`tests/todos.e2e.ts` · failed · 1.2s',
        '',
        '**ASSERTION_FAILED**',
        '',
        '```text',
        'agent.act failed: no Archive button',
        '```',
        '',
        'Look at: `tests/todos.e2e.ts:8`  ',
        '',
        '## Steps',
        '',
        '1. ✓ `app.open` "/todos" (40ms) — `tests/todos.e2e.ts:4`',
        '2. ✗ `agent.act` "Archive the todo" (16.1s, 6 model calls) — **ASSERTION_FAILED**',
        '   > no Archive button',
        '',
        '## Agent turns of step 2',
        '',
        'The last 2 turns the model took, oldest first: what it called and what came back.',
        '',
        '**Turn 1** `tap({"target":"n19"})`  ',
        '> Tapped #n19.',
        '> ',
        '> Screen changes: 4 added.',
        '',
        '**Turn 2** `complete_step({"status":"failed"})`  ',
        '> Step concluded.',
        '',
        '## Screen at failure',
        '',
        'URL: `http://app.test/todos`  ',
        '',
        'The screen as the agent reads it, one node per line: `#id role "name" text="…" [states]`.',
        '',
        '```text',
        '# Screen at failure',
        '',
        '#n1 document "Todos"',
        ' #n19 button "Add"',
        '```',
        '',
        '## Evidence',
        '',
        '- screenshot `.e2e/artifacts/t/001-failure.png`',
        '- log `.e2e/artifacts/t/failure/screen.txt`',
        '',
        '<sub>e2e 0.0.0 · run `run-1` · the whole run is in `report.json`</sub>',
        '',
      ].join('\n'),
    );
  });

  it('points at the screen text when it cannot read it, lists the candidates, and cuts a screen past the cap', () => {
    const screen = { id: 'a:0', kind: 'log' as const, mediaType: 'text/plain', path: 't/failure/screen.txt', redaction: 'complete' as const, producer: { kind: 'attempt' as const } };
    const unread = page([failed({ artifacts: [screen], failure: { screen: 'a:0', candidates: ['#n2 button "Add"'] } })]);
    expect(unread).toContain('Closest to what the locator asked for:  \n- `#n2 button "Add"`\nScreen text: log `.e2e/artifacts/t/failure/screen.txt`  ');
    const huge = page([failed({ artifacts: [screen], failure: { screen: 'a:0' } })], () => 'x'.repeat(30_000));
    expect(huge).toContain('…[cut at 24000 characters; the file has the rest]');
  });

  it('says when no error was recorded, names a hook phase, and keeps a fence in a message from closing the block', () => {
    expect(page([reportAttempt({ status: 'failed' })])).toContain('_failed: no error was recorded._');
    const hook = page([failed({ error: reportError({ phase: 'afterEach', message: 'cleanup ```broke```' }) })]);
    expect(hook).toContain('**ASSERTION_FAILED** in afterEach');
    expect(hook).toContain("cleanup '''broke'''");
  });
});

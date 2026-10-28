/**
 * The markdown page: counts and spend in the head, one block per test that
 * failed with the step it went wrong at, the flaky tests folded, every test
 * folded as one table with a row per file above its tests, an exploration rendered as its
 * findings, untrusted text escaped, and a body that never outgrows a pull
 * request comment. The `markdown` reporter writes it beside the report and
 * links each failure to the page the runner wrote for it.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Report1Document, ReportAttempt, ReportExplore, ReportExploreFinding, ReportFilter, ReportResult, ReportSerialGroup, ReportStep } from '../../src/report/build.ts';
import { markdownReporter, renderMarkdownReport } from '../../src/report/markdown.ts';
import type { FinishedRun } from '../../src/types.ts';
import { REPORT_AT, reportAttempt, reportDocument, reportError, reportResult, reportStep, reportTarget } from '../helpers/report.ts';

const FINISHED_AT = '2026-01-01T00:00:08.400Z';

/** A document the page has something to say about: a version, a duration, one target. */
function page(overrides: Partial<Report1Document['run']> = {}): Report1Document {
  const status = overrides.status ?? 'passed';
  return reportDocument({
    runner: { name: 'e2e', version: '0.9.0' },
    exitCode: status === 'passed' ? 0 : 1,
    finishedAt: FINISHED_AT,
    targets: [reportTarget()],
    ...overrides,
    status,
  });
}

/** A result named by its title path and file, so the page's names read as a user's would. */
function named(input: {
  readonly title: string | readonly string[];
  readonly file?: string;
  readonly line?: number;
  readonly target?: string;
  readonly status: ReportResult['status'];
  readonly attempts?: readonly ReportAttempt[];
  readonly skip?: ReportResult['skip'];
  readonly serialGroupId?: string;
}): ReportResult {
  const titlePath = typeof input.title === 'string' ? [input.title] : [...input.title];
  const file = input.file ?? 'tests/example.e2e.ts';
  return reportResult({
    testId: `${file}::${titlePath.join('::')}`,
    titlePath,
    file,
    source: { file, line: input.line ?? 3, column: 1 },
    targetId: input.target ?? 'web',
    status: input.status,
    attempts: input.attempts ?? [],
    ...(input.skip === undefined ? {} : { skip: input.skip }),
    ...(input.serialGroupId === undefined ? {} : { serialGroupId: input.serialGroupId }),
  });
}

function attempt(
  input: {
    readonly status?: ReportAttempt['status'];
    readonly durationMs?: number;
    readonly error?: { code: string; message: string; details?: NonNullable<ReportAttempt['error']>['details'] };
    readonly artifacts?: readonly ReportAttempt['artifacts'][number]['kind'][];
    readonly steps?: readonly ReportStep[];
  } = {},
): ReportAttempt {
  return reportAttempt({
    status: input.status ?? 'passed',
    durationMs: input.durationMs ?? 1200,
    steps: input.steps ?? [],
    artifacts: (input.artifacts ?? []).map((kind, index) => ({
      id: `attempt-1:artifact:${index}`,
      kind,
      mediaType: 'application/octet-stream',
      path: `t/attempt-0/${kind}-${index}.bin`,
      redaction: 'complete',
      producer: { kind: 'attempt' },
    })),
    ...(input.error === undefined ? {} : { error: { category: 'test', retryable: false, ...input.error } }),
  });
}

/** A step as most fixtures need it; its source is unknown unless a test says otherwise, so the block's location stays the test's own. */
function step(overrides: Partial<ReportStep> & Pick<ReportStep, 'index' | 'label'>): ReportStep {
  return reportStep({ id: `s${overrides.index}`, kind: 'screen', api: 'screen.tap', durationMs: 900, source: UNKNOWN_SOURCE, ...overrides });
}
const UNKNOWN_SOURCE = { file: 'unknown', line: 1, column: 1 };

const metrics = (modelCalls: number) => ({ modelCalls, actionSteps: 3, observationBytes: 1, contextBytes: 1, ledgerBytes: 1 });

const failing = named({
  title: ['members', 'an email invitation is accepted by the invited account only'],
  file: 'tests/members.e2e.ts',
  line: 41,
  status: 'failed',
  attempts: [
    attempt({
      status: 'failed',
      error: { code: 'ASSERTION_FAILED', message: 'expected heading "Welcome, Ada" to be visible' },
      artifacts: ['screenshot', 'video'],
      steps: [
        step({ index: 0, kind: 'app', api: 'app.open', label: 'open /' }),
        step({ index: 1, kind: 'agent', api: 'agent.act', label: 'Sign in as the owner', metrics: metrics(4), cache: { mode: 'self-finalized', replayedActions: 3, totalActions: 3 } }),
        step({ index: 2, label: 'tap Send invitation' }),
        step({
          index: 3,
          kind: 'agent',
          api: 'agent.act',
          label: 'Accept the invitation from the email',
          status: 'failed',
          durationMs: 38_000,
          metrics: metrics(12),
          explanation: 'The Accept button opened a page that still shows Sign in.',
          error: reportError({ message: 'expected heading "Welcome, Ada" to be visible' }),
        }),
        step({ index: 4, label: 'tap Accept', status: 'cancelled' }),
        step({ index: 5, kind: 'assertion', api: 'expect', label: 'heading visible', status: 'cancelled' }),
      ],
    }),
  ],
});
const flaky = named({
  title: 'todos survive a filter round-trip',
  file: 'tests/todos.e2e.ts',
  status: 'flaky',
  attempts: [
    attempt({
      status: 'failed',
      error: { code: 'STEP_TIMEOUT', message: 'slow' },
      artifacts: ['screenshot'],
      steps: [step({ index: 0, label: 'open /todos' }), step({ index: 1, kind: 'agent', api: 'agent.waitFor', label: 'the filtered list', status: 'timed-out', durationMs: 30_000, error: reportError({ code: 'STEP_TIMEOUT', message: 'slow' }) })],
    }),
    attempt({ status: 'passed', durationMs: 6_400, steps: [step({ index: 0, label: 'open /todos' }), step({ index: 1, kind: 'agent', api: 'agent.waitFor', label: 'the filtered list' })] }),
  ],
});
const skipped = named({ title: 'not ready yet', file: 'tests/todos.e2e.ts', status: 'skipped', skip: { cause: 'explicit', reason: 'waiting on the API' } });
const passing = named({ title: 'opens the app', file: 'tests/smoke.e2e.ts', status: 'passed', attempts: [attempt({ durationMs: 850 })] });
const judged = named({
  title: ['dashboard', 'opens directly'],
  file: 'tests/smoke.e2e.ts',
  status: 'passed',
  attempts: [attempt({ durationMs: 2_100, steps: [step({ index: 0, kind: 'agent', api: 'agent.assert', label: 'the dashboard is shown', metrics: metrics(1) })] })],
});
const links = {
  artifactsUrl: 'https://github.com/o/r/actions/runs/9',
  sourceUrl: (file: string, line: number) => `https://github.com/o/r/blob/abc/${file}#L${line}`,
};

/** A run that used the agent, with the usage the runner sums. */
function spent(document: Report1Document): Report1Document {
  document.run.usage = { ...document.run.usage, modelTokens: 128_400, modelCachedTokens: 79_600, estimatedCostUsd: 0.31 };
  return document;
}

describe('renderMarkdownReport', () => {
  it("leads with the counts and the spend, blocks each failure with its step and the agent's word, folds the flaky tests, and folds every test by file", () => {
    const body = renderMarkdownReport(spent(page({ status: 'failed', results: [passing, failing, flaky, skipped, judged] })), links);
    expect(body).toBe(
      [
        '### 🔴 e2e: 1 failed, 1 flaky, 2 passed, 1 skipped',
        '4 agent steps · 1 replayed from cache · 17 model calls · 128.4k tokens (62% cached) · $0.31',
        '',
        [
          // Paragraphs: the title with the line to look at under it; the error and the step in one lead; what the error and the agent said, quoted; the evidence.
          // The file is named once, in the source link; a sentence the author wrote is quoted. Each kind of evidence links to the run's artifacts, no paths.
          '**🔴 members › an email invitation is accepted by the invited account only**  \n[tests/members.e2e.ts:41](https://github.com/o/r/blob/abc/tests/members.e2e.ts#L41)',
          '**ASSERTION_FAILED** at step 4 of 6: `agent.act` "Accept the invitation from the email", after 38.0s and 12 model calls',
          '> expected heading "Welcome, Ada" to be visible\n> The Accept button opened a page that still shows Sign in.',
          'Evidence: [screenshot](https://github.com/o/r/actions/runs/9), [video](https://github.com/o/r/actions/runs/9)',
        ].join('\n\n'),
        '',
        // A flaky test is folded: the run is green, and its story is the attempt that failed, not the retry that passed.
        [
          '<details>',
          '<summary>⚠️ 1 flaky test passed on a retry</summary>',
          '',
          [
            '**⚠️ todos survive a filter round-trip**  \n[tests/todos.e2e.ts:3](https://github.com/o/r/blob/abc/tests/todos.e2e.ts#L3)',
            '**STEP_TIMEOUT** at step 2 of 2: `agent.waitFor` "the filtered list", after 30.0s',
            '> slow',
            'Evidence: [screenshot](https://github.com/o/r/actions/runs/9)',
          ].join('\n\n'),
          '</details>',
        ].join('\n'),
        '',
        // One table: a row per file, worst first, with its counts, agent work, and time, then a row per test; the agent column since the run used the agent.
        [
          '<details>',
          '<summary>All 5 tests in 3 files</summary>',
          '',
          '|  | Test | Agent | Time |',
          '| --- | --- | --- | --- |',
          '| 🔴 | **tests/members.e2e.ts** · 1 failed | 2 steps · 16 calls | 1.2s |',
          '| 🔴 | members › an email invitation is accepted by the invited account only | 2 steps · 16 calls | 1.2s |',
          '| ⚠️ | **tests/todos.e2e.ts** · 1 flaky, 1 skipped | 1 step | 6.4s |',
          '| ⚠️ | todos survive a filter round-trip (1 failed attempt first) | 1 step | 6.4s |',
          '| ⏭️ | not ready yet (skipped: waiting on the API) |  |  |',
          '| 🟢 | **tests/smoke.e2e.ts** · 2 passed | 1 step · 1 call | 3.0s |',
          '| 🟢 | opens the app |  | 850ms |',
          '| 🟢 | dashboard › opens directly | 1 step · 1 call | 2.1s |',
          '</details>',
        ].join('\n'),
        '',
        '<sub>e2e 0.9.0 · 8.4s · web · [run artifacts](https://github.com/o/r/actions/runs/9)</sub>',
        '',
      ].join('\n'),
    );
  });

  it('is a passing headline, the folded table without an agent column, and the footer when everything passed, with no spend line for a deterministic run', () => {
    expect(renderMarkdownReport(page({ results: [passing] }))).toBe(
      [
        '### 🟢 e2e: 1 passed',
        '',
        '<details>\n<summary>All 1 test in 1 file</summary>\n\n|  | Test | Time |\n| --- | --- | --- |\n| 🟢 | **tests/smoke.e2e.ts** · 1 passed | 850ms |\n| 🟢 | opens the app | 850ms |\n</details>',
        '',
        '<sub>e2e 0.9.0 · 8.4s · web</sub>',
        '',
      ].join('\n'),
    );
  });

  it('leaves a result the selection did not choose out of the counts and the list, and reads one without the flag as selected', () => {
    const unselected = { ...named({ title: 'agent journey', file: 'tests/agent/tests.e2e.ts', status: 'skipped', skip: { cause: 'filtered', reason: 'file not selected by a positional argument' } }), selected: false };
    const body = renderMarkdownReport(page({ results: [passing, unselected] }));
    expect(body).toContain('### 🟢 e2e: 1 passed\n');
    expect(body).toContain('All 1 test in 1 file');
    expect(body).not.toContain('tests/agent/tests.e2e.ts');
    expect(body).not.toContain('positional argument');
    const legacy = { ...passing, selected: undefined as unknown as boolean };
    expect(renderMarkdownReport(page({ results: [legacy] }))).toContain('### 🟢 e2e: 1 passed');
  });

  it('names the page after its title, so two comments on one pull request read apart', () => {
    expect(renderMarkdownReport(page({ results: [passing] }), { title: 'regression' })).toContain('### 🟢 e2e regression: 1 passed\n');
    expect(renderMarkdownReport(page({ results: [passing] }), { title: '  ' })).toContain('### 🟢 e2e: 1 passed\n');
    expect(renderMarkdownReport(explored(), { title: 'nightly' })).toContain('### 🔴 e2e nightly explore: 1 issue\n');
  });

  it('names the failed step whatever its status, and never retells the steps before it', () => {
    const many = Array.from({ length: 9 }, (_, index) => step({ index, kind: 'agent', api: 'agent.act', label: `step ${index}` }));
    const at = (status: Exclude<ReportStep['status'], 'passed'>) =>
      renderMarkdownReport(
        page({
          status: 'failed',
          results: [
            named({
              title: 'long flow',
              status: 'failed',
              attempts: [
                attempt({
                  status: 'failed',
                  error: { code: 'E', message: 'm' },
                  steps: [...many, step({ index: 9, kind: 'agent', api: 'agent.waitFor', label: 'the order confirmation', status, durationMs: 30_000, error: reportError({ code: 'E', message: 'm' }) }), step({ index: 10, label: 'after', status: 'cancelled' })],
                }),
              ],
            }),
          ],
        }),
      );
    for (const status of ['timed-out', 'blocked', 'cancelled'] as const) {
      expect(at(status)).toContain('**🔴 long flow**  \n`tests/example.e2e.ts:3`\n\n**E** at step 10 of 11: `agent.waitFor` "the order confirmation", after 30.0s\n\n> m\n');
      expect(at(status)).not.toContain('step 8');
    }
    // A step that is not the agent's reads as the one call it was.
    const single = named({ title: 'one', status: 'failed', attempts: [attempt({ status: 'failed', error: { code: 'E', message: 'm' }, steps: [step({ index: 0, label: 'only', status: 'failed', error: reportError({ code: 'E', message: 'm' }) })] })] });
    expect(renderMarkdownReport(page({ status: 'failed', results: [single] }))).toContain('**E** at step 1 of 1: `screen.tap only`, after 900ms');
  });

  it('names the step whose error ended the test, not an earlier failure the test caught and went on from', () => {
    const at = (line: number) => ({ file: 'tests/example.e2e.ts', line, column: 5 });
    const caught = named({
      title: 'caught waitFor, then a failing assertion',
      status: 'failed',
      attempts: [
        attempt({
          status: 'failed',
          error: { code: 'ASSERTION_FAILED', message: 'expect.toHaveCount failed\nexpected: count 5\nobserved: count 1' },
          steps: [
            step({ index: 0, kind: 'app', api: 'app.open', label: '/todos', source: at(4) }),
            step({ index: 1, kind: 'locator', api: 'locator.waitFor', label: 'getByText("Nothing here") → visible', status: 'failed', durationMs: 303, source: at(8), error: reportError({ code: 'LOCATOR_NOT_FOUND', message: 'locator did not become visible' }) }),
            step({ index: 2, label: 'tap Add', source: at(12) }),
            step({ index: 3, kind: 'assertion', api: 'expect.toHaveCount', label: 'getByTestId("todo")', status: 'failed', durationMs: 502, source: at(15), error: reportError({ message: 'expect.toHaveCount failed' }) }),
          ],
        }),
      ],
    });
    const body = renderMarkdownReport(page({ status: 'failed', results: [caught] }));
    // The line and the lead are the assertion's; the caught step is not the failure.
    expect(body).toContain('**🔴 caught waitFor, then a failing assertion**  \n`tests/example.e2e.ts:15`\n\n**ASSERTION_FAILED** at step 4 of 4: `expect.toHaveCount getByTestId("todo")`, after 502ms');
    expect(body).not.toContain('locator.waitFor');
  });

  it('quotes nothing when the message only says the api failed, lists the facts, and shows a loopback screen as its path', () => {
    const locators = [
      step({ index: 0, kind: 'locator', api: 'getByRole', label: 'getByRole("button", name: "Save Changes")' }),
      step({ index: 1, kind: 'assertion', api: 'expect.toBeHidden', label: 'getByRole("button", name: "Save Changes")', status: 'failed', durationMs: 15_100, error: reportError({ message: 'expect.toBeHidden failed' }) }),
    ];
    const error = {
      code: 'ASSERTION_FAILED',
      message: 'expect.toBeHidden failed\nlocator: getByRole("button", name: "Save Changes")\nexpected: hidden or absent\nobserved: default states (match count 1)',
      details: { locator: 'getByRole("button", name: "Save Changes")', expected: 'hidden or absent', observed: 'default states', matches: 1 },
    };
    const failedAttempt = attempt({ status: 'failed', error, steps: locators });
    failedAttempt.failure = { url: 'http://127.0.0.1:3100/dashboard/p1/settings?tab=env', candidates: ['#n41 button "Save Changes" [disabled]'] };
    const body = renderMarkdownReport(page({ status: 'failed', results: [named({ title: 'settings', status: 'failed', attempts: [failedAttempt] })] }));
    // The message's first line only says the api failed, which the lead says; nothing is quoted. Nobody can open a loopback URL, so its path is enough.
    expect(body).toContain(
      [
        '**🔴 settings**  \n`tests/example.e2e.ts:3`',
        '**ASSERTION_FAILED** at step 2 of 2: `expect.toBeHidden getByRole("button", name: "Save Changes")`, after 15.1s',
        '- Expected: hidden or absent\n- Observed: default states (1 match)\n- Screen: `/dashboard/p1/settings?tab=env`\n- Closest to the locator: `#n41 button "Save Changes" [disabled]`',
      ].join('\n\n'),
    );
    // A message that says more than the api is quoted, first line only: the facts carry the rest.
    const worded = renderMarkdownReport(page({ status: 'failed', results: [named({ title: 'settings', status: 'failed', attempts: [attempt({ status: 'failed', error: { ...error, message: 'the Save button stayed\nexpected: hidden' }, steps: locators })] })] }));
    expect(worded).toContain(', after 15.1s\n\n> the Save button stayed\n\n- Expected:');
  });

  it('puts run-level errors before the failures and says no tests ran', () => {
    const body = renderMarkdownReport(
      page({
        status: 'error',
        errors: [{ category: 'infrastructure', code: 'APP_UNREACHABLE', message: 'http://127.0.0.1:3000 did not answer', retryable: true, phase: 'launch' }],
      }),
    );
    expect(body).toContain('### 🔴 e2e: no tests ran\n\n> **APP_UNREACHABLE** (launch) `http://127.0.0.1:3000` did not answer\n');
    expect(body).not.toContain('<details>');
  });

  it('says no tests selected when nothing ran and nothing failed', () => {
    expect(renderMarkdownReport(page())).toBe('### 🟢 e2e: no tests selected\n\n<sub>e2e 0.9.0 · 8.4s · web</sub>\n');
  });

  it('escapes what a test wrote, keeps it on one line, and keeps a link destination closed', () => {
    const hostile = named({
      title: 'a | b <img src=x onerror=alert(1)> *c*',
      file: 'tests/we|rd.e2e.ts',
      status: 'failed',
      attempts: [
        attempt({
          status: 'failed',
          error: { code: 'ASSERTION_FAILED', message: 'line one\nline two [31mred[0m `tick`' },
          steps: [step({ index: 0, api: 'screen.`tap`', label: 'tap `x` | y', status: 'failed', explanation: 'saw <b>bold</b>\nand more', error: reportError() }), step({ index: 1, label: 'z' })],
        }),
      ],
    });
    const body = renderMarkdownReport(page({ status: 'failed', results: [hostile] }), {
      artifactsUrl: 'https://x.test/run (1)',
      sourceUrl: () => 'https://x.test/blob)<script>',
    });
    expect(body).toContain('a \\| b &lt;img src=x onerror=alert(1)&gt; \\*c\\*');
    // The canonical sanitizer drops color sequences and marks a control character, as the terminal does.
    expect(body).toContain('line one line two red �\\`tick\\`');
    // A backtick in a label lengthens the code span's delimiter instead of vanishing.
    expect(body).toContain('at step 1 of 2: `` screen.`tap` tap `x` \\| y ``, after 900ms\n\n> line one line two red �\\`tick\\`\n> saw &lt;b&gt;bold&lt;/b&gt; and more');
    expect(body).toContain('| 🔴 | **tests/we\\|rd.e2e.ts** · 1 failed | 1.2s |');
    expect(body).toContain('[tests/we\\|rd.e2e.ts:3](https://x.test/blob%29%3Cscript%3E)');
    expect(body).toContain('[run artifacts](https://x.test/run%20%281%29)');
    expect(body).not.toContain('');
    expect(body).not.toContain('');
  });

  it('shows a token GitHub would link as code, and keeps a quoted line from opening a block', () => {
    // GitHub's mention and issue filters run on the rendered text, so an entity or a backslash before `@` or `#` changes nothing; a code span is skipped.
    const hostile = named({
      title: 'ping @octocat @org/team, see #123 GH-7, open https://evil.example/p (www.evil.example) <https://e.example/`x`|y>',
      status: 'failed',
      attempts: [
        attempt({
          status: 'failed',
          error: { code: 'ASSERTION_FAILED', message: '# Heading\n- item' },
          steps: [step({ index: 0, api: 'agent.act', label: 'pay', status: 'failed', explanation: '1. numbered\nmail a@b.example, color:#123456, x#1', error: reportError() })],
        }),
      ],
    });
    const body = renderMarkdownReport(page({ status: 'failed', results: [hostile] }));
    expect(body).toContain('ping `@octocat` `@org/team,` see `#123` `GH-7,` open `https://evil.example/p` `(www.evil.example)` `` <https://e.example/`x`\\|y> ``');
    expect(body).toContain('\n\n> \\# Heading - item\n> 1\\. numbered mail `a@b.example,` `color:#123456,` `x#1`\n');
    expect(body).not.toMatch(/[^`]@octocat/);
    expect(body).not.toMatch(/[^`]https:\/\/evil/);
  });

  it('escapes every other block opener at the start of a quoted line: a plus or underscore item and a parenthesised list marker', () => {
    const opener = named({
      title: 'openers',
      status: 'failed',
      attempts: [
        attempt({
          status: 'failed',
          error: { code: 'ASSERTION_FAILED', message: '+ item\n_ under' },
          steps: [step({ index: 0, api: 'agent.act', label: 'pay', status: 'failed', explanation: '1) list', error: reportError() })],
        }),
      ],
    });
    const body = renderMarkdownReport(page({ status: 'failed', results: [opener] }));
    // The message collapses to one line, so only its first character opens a block; the explanation is its own quoted line.
    expect(body).toContain('\n\n> \\+ item _ under\n> 1\\) list\n');
  });

  it('clips long text by code point, never through an emoji', () => {
    // 121 and 241 code points: the cut lands on the emoji, which must survive whole.
    const long = named({
      title: `${'x'.repeat(118)}💥yz`,
      status: 'failed',
      attempts: [attempt({ status: 'failed', error: { code: 'E', message: `${'m'.repeat(238)}💥zz` } })],
    });
    const body = renderMarkdownReport(page({ status: 'failed', results: [long] }));
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(body).not.toMatch(loneSurrogate);
    expect(body).toContain(`${'x'.repeat(118)}💥…`);
    // A quoted message gets the room prose gets: 600 code points.
    expect(body).toContain(`> ${'m'.repeat(238)}💥zz`);
    const prose = named({ title: 'p', status: 'failed', attempts: [attempt({ status: 'failed', error: { code: 'E', message: `${'m'.repeat(598)}💥zz` } })] });
    expect(renderMarkdownReport(page({ status: 'failed', results: [prose] }))).toContain(`> ${'m'.repeat(598)}💥…`);
  });

  it('rounds a duration to whole seconds before splitting off the minutes, and formats tokens and cost as the terminal does', () => {
    const at = (finishedAt: string) => renderMarkdownReport(page({ results: [passing], finishedAt }));
    expect(at('2026-01-01T00:01:59.500Z')).toContain('· 2m 0s ·');
    expect(at('2026-01-01T00:01:29.400Z')).toContain('· 1m 29s ·');
    expect(at('2026-01-01T00:00:59.940Z')).toContain('· 59.9s ·');
    const usage = (modelTokens: number, estimatedCostUsd: number) => {
      const document = page({ results: [judged] });
      document.run.usage = { ...document.run.usage, modelTokens, estimatedCostUsd };
      return renderMarkdownReport(document);
    };
    expect(usage(950, 0.004)).toContain('1 agent step · 1 model call · 950 tokens · $0.0040\n');
    expect(usage(9_400, 1.5)).toContain('· 9.4k tokens · $1.50\n');
    expect(usage(2_400_000, 12)).toContain('· 2.4M tokens · $12.00\n');
  });

  it('names the target only when the results ran on several: under a block title, on the file rows, and in the footer, capped there', () => {
    const twoTargets = [reportTarget(), reportTarget({ id: 'mobile', index: 1 })];
    const body = renderMarkdownReport(page({ status: 'failed', results: [failing, { ...passing, targetId: 'mobile' }], targets: twoTargets }));
    expect(body).toContain('**🔴 members › an email invitation is accepted by the invited account only**  \n`tests/members.e2e.ts:41` · web\n');
    // The file row names the target; the test rows under it need not.
    expect(body).toContain('| 🟢 | **tests/smoke.e2e.ts (mobile)** · 1 passed |  | 850ms |\n| 🟢 | opens the app |  | 850ms |');
    // Two configured, one selected (`--target web`): the page is about that one.
    const one = renderMarkdownReport(page({ status: 'failed', results: [failing, passing], targets: twoTargets }));
    expect(one).not.toContain('(web)');
    expect(one).toContain('`tests/members.e2e.ts:41`\n\n');
    expect(one).toContain('<sub>e2e 0.9.0 · 8.4s · web</sub>');
    // One file on two targets is two groups and one file.
    const twice = renderMarkdownReport(page({ results: [passing, { ...passing, targetId: 'mobile' }], targets: [reportTarget(), reportTarget({ id: 'mobile', index: 1 })] }));
    expect(twice).toContain('<summary>All 2 tests in 1 file</summary>');
    expect(body).toContain('2 targets (web, mobile)');
    const many = renderMarkdownReport(page({ results: [passing], targets: Array.from({ length: 12 }, (_, index) => reportTarget({ id: `t${index}`, index })) }));
    expect(many).toContain('12 targets (t0, t1, t2, t3, t4, t5, t6, t7, and 4 more)</sub>');
  });

  it('lists files worst first in the fold, each row with the counts of its tests', () => {
    const skippedOnly = named({ title: 'later', file: 'tests/a.e2e.ts', status: 'skipped', skip: { cause: 'explicit', reason: 'later' } });
    const body = renderMarkdownReport(page({ status: 'failed', results: [passing, skippedOnly, flaky, failing] }));
    const rows = body.split('\n').filter((line) => line.includes('| **tests/'));
    expect(rows).toEqual([
      '| 🔴 | **tests/members.e2e.ts** · 1 failed | 2 steps · 16 calls | 1.2s |',
      '| ⚠️ | **tests/todos.e2e.ts** · 1 flaky | 1 step | 6.4s |',
      '| ⏭️ | **tests/a.e2e.ts** · 1 skipped |  | 0ms |',
      '| 🟢 | **tests/smoke.e2e.ts** · 1 passed |  | 850ms |',
    ]);
  });

  it('caps the folded list, saying how many more there are', () => {
    const results = Array.from({ length: 450 }, (_, index) => named({ title: `t${index}`, file: `tests/f${String(index).padStart(3, '0')}.e2e.ts`, status: 'passed', attempts: [attempt()] }));
    const body = renderMarkdownReport(page({ results }));
    expect(body).toContain('<summary>All 450 tests in 450 files</summary>');
    expect(body).toContain('|  | and 50 more |  |\n</details>');
    expect(body).not.toContain('**tests/f449.e2e.ts**');
  });

  it('folds every flaky test under one summary and caps them', () => {
    const flakes = Array.from({ length: 35 }, (_, index) => named({ title: `flake ${index}`, status: 'flaky', attempts: [attempt({ status: 'failed', error: { code: 'E', message: 'm' } }), attempt()] }));
    const body = renderMarkdownReport(page({ results: flakes }));
    expect(body).toContain('<summary>⚠️ 35 flaky tests passed on a retry</summary>');
    expect(body).toContain('**⚠️ flake 29**');
    expect(body).not.toContain('**⚠️ flake 30**');
    expect(body).toContain('and 5 more\n</details>');
  });

  it('reads a serial member from its group: error, steps, failure evidence, and the artifacts of the attempt that failed', () => {
    const member = named({ title: 'step two', status: 'failed', serialGroupId: 'g1' });
    const group: ReportSerialGroup = {
      id: 'g1',
      serialId: 'g1',
      declarationIndex: 0,
      file: member.file,
      source: member.source,
      titlePath: ['group'],
      targetId: 'web',
      platform: 'web',
      agent: 'default',
      repeat: 0,
      memberTestIds: [member.testId],
      status: 'failed',
      attempts: [
        { ...attempt({ status: 'failed', artifacts: ['video'] }), members: [] },
        {
          ...attempt({ status: 'failed', artifacts: ['screenshot'] }),
          members: [
            {
              id: 'm',
              index: 0,
              testId: member.testId,
              status: 'failed',
              startedAt: REPORT_AT,
              durationMs: 40,
              steps: [step({ index: 0, label: 'tap Next', status: 'failed', error: reportError({ message: 'nope' }) })],
              error: { category: 'test', code: 'ASSERTION_FAILED', message: 'nope', retryable: false },
              failure: { url: 'http://app.test/wizard', candidates: ['#n3 button "Next step"'] },
              secondaryErrors: [],
            },
          ],
        },
      ],
    };
    const body = renderMarkdownReport(page({ status: 'failed', results: [member], serialGroups: [group] }));
    // The evidence is the failing group attempt's own, not an earlier attempt's video.
    expect(body).toContain(
      '**ASSERTION_FAILED** at step 1 of 1: `screen.tap tap Next`, after 900ms\n\n> nope\n\n- Screen: `http://app.test/wizard`\n- Closest to the locator: `#n3 button "Next step"`\n\nEvidence: screenshot',
    );
    // A member whose group is missing renders what it has rather than an inspection of nothing.
    expect(renderMarkdownReport(page({ status: 'failed', results: [member] }))).toContain('**🔴 step two**  \n`tests/example.e2e.ts:3`\n\n**failed**\n');
  });

  it('tells a serial member from the attempt that failed it when the interrupted retry skipped it', () => {
    const member = named({ title: 'step two', status: 'failed', serialGroupId: 'g1' });
    const memberRecord = (status: 'failed' | 'skipped') => ({
      id: `m-${status}`,
      index: 0,
      testId: member.testId,
      status,
      startedAt: REPORT_AT,
      durationMs: 40,
      steps: status === 'failed' ? [step({ index: 0, label: 'tap Next', status: 'failed', error: reportError({ message: 'nope' }) })] : [],
      ...(status === 'failed'
        ? { error: { category: 'test' as const, code: 'ASSERTION_FAILED', message: 'nope', retryable: false } }
        : { skip: { cause: 'serial-predecessor-failed' as const, reason: 'group attempt did not reach this member' } }),
      secondaryErrors: [],
    });
    const group: ReportSerialGroup = {
      id: 'g1',
      serialId: 'g1',
      declarationIndex: 0,
      file: member.file,
      source: member.source,
      titlePath: ['group'],
      targetId: 'web',
      platform: 'web',
      agent: 'default',
      repeat: 0,
      memberTestIds: [member.testId],
      status: 'failed',
      attempts: [
        { ...attempt({ status: 'failed' }), members: [memberRecord('failed')] },
        { ...attempt({ status: 'interrupted', error: { code: 'INTERRUPTED', message: 'run interrupted in phase body' } }), members: [memberRecord('skipped')] },
      ],
    };
    const body = renderMarkdownReport(page({ status: 'interrupted', results: [member], serialGroups: [group] }));
    expect(body).toContain('**ASSERTION_FAILED** at step 1 of 1: `screen.tap tap Next`');
    expect(body).not.toContain('INTERRUPTED');
  });

  it('tolerates a document written before results carried repeat, or one giving a flaky test a single attempt', () => {
    const legacy = { ...named({ title: 'checkout', status: 'failed' }), repeat: undefined as unknown as number };
    const legacyBody = renderMarkdownReport(page({ status: 'failed', results: [legacy] }));
    expect(legacyBody).toContain('checkout');
    expect(legacyBody).not.toContain('repeat #');
    const oneAttempt = named({ title: 'odd', status: 'flaky', attempts: [attempt({ status: 'passed' })] });
    const foreignBody = renderMarkdownReport(page({ results: [oneAttempt] }));
    expect(foreignBody).toContain('| ⚠️ | odd (0 failed attempts first) | 1.2s |');
    expect(foreignBody).not.toContain('-1');
  });

  it('caps the failure blocks and drops what follows before the body outgrows a comment', () => {
    const failures = Array.from({ length: 80 }, (_, index) =>
      named({ title: `failure ${index}`, status: 'failed', attempts: [attempt({ status: 'failed', error: { code: 'E', message: 'x'.repeat(2_000) } })] }),
    );
    const passes = Array.from({ length: 600 }, (_, index) =>
      named({ title: [`suite ${index} `.repeat(15), 'b'.repeat(120), 'c'.repeat(120)], file: `tests/file-${index % 40}.e2e.ts`, status: 'passed', attempts: [attempt()] }),
    );
    const body = renderMarkdownReport(page({ status: 'failed', results: [...failures, ...passes] }));
    // Thirty blocks, then how many were left out; the folded list does not fit, and the note says so.
    expect(body).toContain('and 50 more failed');
    expect(body).not.toContain('<details>');
    expect(body).toContain("_Truncated to fit a pull request comment; the full report is in `report.json`._");
    expect(body.length).toBeLessThan(65_536);
  });

  it('never returns a body GitHub would reject, whatever the report holds', () => {
    // Sixty failures whose titles alone are longer than the whole budget allows.
    const wide = Array.from({ length: 60 }, (_, index) =>
      named({
        title: Array.from({ length: 30 }, (__, part) => `segment ${index}-${part} `.repeat(8)),
        status: 'failed',
        attempts: [attempt({ status: 'failed', error: { code: 'E', message: 'm'.repeat(240) } })],
      }),
    );
    const errors = Array.from({ length: 40 }, (_, index) => ({ category: 'infrastructure' as const, code: `RUN_ERROR_${index}`, message: 'e'.repeat(240), retryable: false }));
    const body = renderMarkdownReport(page({ status: 'error', results: wide, errors }));
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body.startsWith('### 🔴 e2e: 60 failed\n')).toBe(true);
    expect(body).toContain('> and 20 more');
    expect(body).toContain("_Truncated to fit a pull request comment; the full report is in `report.json`._");
    expect(body.trimEnd().endsWith('</sub>')).toBe(true);
    // A run with hundreds of targets does not escape the cap either.
    const targets = Array.from({ length: 300 }, (_, index) => reportTarget({ id: `target-${index}-${'t'.repeat(60)}`, index }));
    expect(renderMarkdownReport(page({ results: [passing], targets })).length).toBeLessThanOrEqual(60_000);
  });
});

const AT = '2026-01-01T00:00:03.000Z';

function finding(overrides: Partial<ReportExploreFinding> & Pick<ReportExploreFinding, 'index' | 'title'>): ReportExploreFinding {
  return {
    id: `finding-${overrides.index}`,
    step: 1,
    kind: 'issue',
    severity: 4,
    expected: 'The total reflects the cart',
    actual: 'Total: $0.00',
    reproduction: ['Add two items', 'Open the cart'],
    path: '/cart',
    reportedAt: AT,
    ...overrides,
  };
}

/** An exploration whose one test failed with the verdict its findings express. */
function explored(explore: Partial<ReportExplore> = {}, status: Report1Document['run']['status'] = 'failed'): Report1Document {
  const findings = explore.findings ?? [finding({ index: 0, title: 'Cart total ignores quantity', artifactId: 'a:artifact:0' })];
  const issues = findings.some((entry) => entry.kind === 'issue');
  const evidence = { ...attempt({ status: issues ? 'failed' : 'passed', artifacts: ['screenshot'] }), id: 'a' };
  evidence.artifacts = [{ ...evidence.artifacts[0]!, id: 'a:artifact:0', path: 'web/explore-checkout-d287e8aead677d36/default/attempt-0/finding-0.png' }];
  if (issues) evidence.error = { category: 'test', code: 'ASSERTION_FAILED', message: '1 issue found', retryable: false };
  const document = page({ status, results: [named({ title: 'Explore checkout', file: 'explore', status: issues ? 'failed' : 'passed', attempts: [evidence] })] });
  document.run.explore = {
    goal: 'Explore checkout',
    budgets: { maxSteps: 8, timeoutMs: 600_000 },
    ended: 'finished',
    summary: 'The cart is the weak spot.',
    steps: [{ index: 1, title: 'Cart', instruction: 'Add items and change quantities', status: 'passed', startedAt: AT, durationMs: 20_000 }],
    ...explore,
    findings,
  };
  return document;
}

describe('renderMarkdownReport for an exploration', () => {
  it('renders the goal, the steps, every finding with its evidence, and the assessment in place of the test list', () => {
    const body = renderMarkdownReport(
      explored({
        findings: [
          finding({ index: 0, title: 'Newsletter label misspells Receive', kind: 'warning', severity: 1, path: '/checkout', step: 2, reproduction: [] }),
          finding({ index: 1, title: 'Cart total ignores quantity', artifactId: 'a:artifact:0' }),
        ],
        steps: [
          { index: 1, title: 'Cart', instruction: 'x', status: 'passed', startedAt: AT, durationMs: 1 },
          { index: 2, title: 'Checkout', instruction: 'y', status: 'failed', summary: 'the pay button did nothing', startedAt: AT, durationMs: 1 },
        ],
        ended: 'step-limit',
      }),
      { artifactsDir: '.e2e/artifacts' },
    );
    expect(body).toBe(
      [
        '### 🔴 e2e explore: 1 issue, 1 warning',
        '',
        '**Goal:** Explore checkout  ',
        '**Steps:** 2 of 8 steps · 1 passed · 1 failed · the step limit was reached',
        '',
        '**Findings**',
        '',
        [
          '1. **high issue** Cart total ignores quantity · `/cart` · step 1',
          '   Expected: The total reflects the cart',
          '   Actual: Total: $0.00',
          '   Steps: 1. Add two items 2. Open the cart',
          '   Evidence: screenshot `.e2e/artifacts/web/explore-checkout-d287e8aead677d36/default/attempt-0/finding-0.png`',
        ].join('  \n'),
        ['2. **trivial warning** Newsletter label misspells Receive · `/checkout` · step 2', '   Expected: The total reflects the cart', '   Actual: Total: $0.00'].join('  \n'),
        '',
        '**Assessment**',
        '',
        'The cart is the weak spot.',
        '',
        '<sub>e2e 0.9.0 · 8.4s · web</sub>',
        '',
      ].join('\n'),
    );
    // The exploration's own failure is the verdict the findings express, so it gets no block and no table.
    expect(body).not.toContain('**🔴 explore');
    expect(body).not.toContain('<details>');
  });

  it('keeps a backtick inside a linkable token by lengthening the code span delimiter, as GFM reads it', () => {
    const body = renderMarkdownReport(
      explored({ summary: 'open https://example.test/`code` then https://x.example/``q`` and https://y.example/z` or plain https://ok.example' }),
    );
    expect(body).toContain('open `` https://example.test/`code` `` then ``` https://x.example/``q`` ``` and `` https://y.example/z` `` or plain `https://ok.example`\n');
  });

  it('keeps an assessment that starts like a heading, a list, a rule, or another block opener as prose', () => {
    const cases = [
      ['# Verdict\n- the cart is the weak spot', '\\# Verdict - the cart is the weak spot'],
      ['1. the cart is the weak spot', '1\\. the cart is the weak spot'],
      ['---', '\\---'],
      ['1.5 stars, see @octocat', '1.5 stars, see `@octocat`'],
      ['+ item', '\\+ item'],
      ['= title', '\\= title'],
      ['_ under', '\\_ under'],
      ['1) list', '1\\) list'],
      ['a+b = c_d (1) e', 'a+b = c_d (1) e'],
    ] as const;
    for (const [summary, prose] of cases) {
      expect(renderMarkdownReport(explored({ summary })), summary).toContain(`**Assessment**\n\n${prose}\n`);
    }
  });

  it('links the evidence to the run page when there is one, and names the kind when the reader has neither', () => {
    expect(renderMarkdownReport(explored(), { artifactsUrl: 'https://ci.test/run/1' })).toContain('   Evidence: [screenshot](https://ci.test/run/1)');
    expect(renderMarkdownReport(explored())).toContain('   Evidence: screenshot\n');
  });

  it('says what an exploration without findings amounts to, and keeps a failure that is not the verdict', () => {
    expect(renderMarkdownReport(explored({ findings: [] }, 'passed'))).toContain('### 🟢 e2e explore: no findings\n');
    expect(renderMarkdownReport(explored({ findings: [], steps: [], ended: 'stuck' }, 'blocked'))).toContain('### 🔴 e2e explore: explored nothing\n');
    const provider = explored({ findings: [] }, 'error');
    provider.run.results[0]!.status = 'failed';
    provider.run.results[0]!.attempts[0]!.status = 'failed';
    provider.run.results[0]!.attempts[0]!.error = { category: 'infrastructure', code: 'MODEL_PROVIDER_FAILED', message: 'gateway 502', retryable: true };
    const body = renderMarkdownReport(provider);
    expect(body).toContain('### 🔴 e2e explore: did not finish\n');
    expect(body).toContain('**🔴 Explore checkout**  \n`explore:3`\n\n**MODEL_PROVIDER_FAILED**\n\n> gateway 502\n\nEvidence: screenshot');
  });

  it('caps the findings and escapes what the agent wrote', () => {
    const many = Array.from({ length: 40 }, (_, index) => finding({ index, title: `finding ${index} <b>*x*</b>`, severity: ((index % 5) + 1) as 1 | 2 | 3 | 4 | 5 }));
    const body = renderMarkdownReport(explored({ findings: many }));
    expect(body).toContain('31. and 10 more');
    expect(body).toContain('**critical issue** finding 4 &lt;b&gt;\\*x\\*&lt;/b&gt;');
  });
});

describe('renderMarkdownReport evidence paths', () => {
  it('lists one artifact path per kind under artifactsDir when there is no run page, in kind order, and names kinds when no path was kept', () => {
    const evidence = attempt({ status: 'failed', error: { code: 'E', message: 'm' }, artifacts: ['download', 'screenshot', 'video', 'log'] });
    const body = renderMarkdownReport(page({ status: 'failed', results: [named({ title: 't', status: 'failed', attempts: [evidence] })] }), { artifactsDir: '.e2e/artifacts' });
    // One artifact per kind of the attempt the block tells, named by kind; a log is not evidence unless the failure captured it.
    expect(body).toContain(
      '\n\nEvidence: screenshot `.e2e/artifacts/t/attempt-0/screenshot-1.bin`, video `.e2e/artifacts/t/attempt-0/video-2.bin`, download `.e2e/artifacts/t/attempt-0/download-0.bin`\n',
    );
    const withheld = attempt({ status: 'failed', error: { code: 'E', message: 'm' }, artifacts: ['screenshot'] });
    withheld.artifacts = withheld.artifacts.map(({ path: _path, ...artifact }) => artifact);
    const named2 = renderMarkdownReport(page({ status: 'failed', results: [named({ title: 't', status: 'failed', attempts: [withheld] })] }), { artifactsDir: '.e2e/artifacts' });
    expect(named2).toContain('\n\nEvidence: screenshot\n');
  });

  it('links a video a hosted service keeps to its own URL', () => {
    const base = attempt({ status: 'failed', error: { code: 'E', message: 'm' }, artifacts: ['screenshot'] });
    const evidence = { ...base, artifacts: [...base.artifacts, {
      id: 'attempt-1:artifact:1',
      kind: 'video' as const,
      mediaType: 'video/mp4',
      url: 'https://recordings.example/r1.mp4',
      startedAt: '2026-01-01T00:00:00.000Z',
      redaction: 'incomplete' as const,
      producer: { kind: 'attempt' as const },
    }] };
    const document = page({ status: 'failed', results: [named({ title: 't', status: 'failed', attempts: [evidence] })] });
    expect(renderMarkdownReport(document, { artifactsDir: '.e2e/artifacts' })).toContain(
      '\n\nEvidence: screenshot `.e2e/artifacts/t/attempt-0/screenshot-0.bin`, [video](https://recordings.example/r1.mp4)\n',
    );
    expect(renderMarkdownReport(document, { artifactsUrl: 'https://ci.test/run/1' })).toContain(
      '\n\nEvidence: [screenshot](https://ci.test/run/1), [video](https://recordings.example/r1.mp4)\n',
    );
  });
});

describe('an interrupted run', () => {
  const cut = named({
    title: 'cut short',
    status: 'interrupted',
    attempts: [attempt({ status: 'interrupted', error: { code: 'INTERRUPTED', message: 'run interrupted in phase body' } })],
  });

  it('counts an interrupted test apart from failures and gives it no failure block', () => {
    const body = renderMarkdownReport(page({ status: 'interrupted', results: [passing, cut] }));
    expect(body.startsWith('### ⏹️ e2e: 1 interrupted, 1 passed\n')).toBe(true);
    expect(body).not.toContain('INTERRUPTED');
    expect(body).toContain('| ⏹️ | cut short |');
  });

  it('tells the failure an interrupted retry was cut short after', () => {
    const retried = named({
      title: 'fails then gets cut',
      status: 'failed',
      attempts: [
        attempt({ status: 'failed', error: { code: 'ASSERTION_FAILED', message: 'no cart' } }),
        attempt({ status: 'interrupted', error: { code: 'INTERRUPTED', message: 'run interrupted in phase body' } }),
      ],
    });
    const body = renderMarkdownReport(page({ status: 'interrupted', results: [retried] }));
    expect(body.startsWith('### 🔴 e2e: 1 failed\n')).toBe(true);
    expect(body).toContain('**ASSERTION_FAILED**');
    expect(body).not.toContain('**INTERRUPTED**');
  });

  it('stays red when the run failed before it was stopped', () => {
    const body = renderMarkdownReport(page({ status: 'interrupted', results: [failing, cut] }));
    expect(body.startsWith('### 🔴 e2e: 1 failed, 1 interrupted\n')).toBe(true);
  });
});

describe('a run test filters narrowed', () => {
  /** A result `filter` left out on `target`, unselected as the runner writes it. */
  function leftOut(title: string, filter: string, reason: string, target = 'web'): ReportResult {
    return { ...named({ title, file: 'tests/billing.e2e.ts', target, status: 'skipped', skip: { cause: 'filtered', reason, filter } }), selected: false };
  }
  /** A filter's report record, `areas` keeping 1 of 3 tests unless `overrides` says otherwise. */
  const record = (overrides: Partial<ReportFilter> = {}): ReportFilter => ({ name: 'areas', candidates: 3, excluded: 2, ...overrides });

  it('counts what the filters left out in the headline, names each filter, and folds what they left out with their reasons', () => {
    const results = [passing, leftOut('pays', 'areas', 'the diff misses billing'), leftOut('refunds', 'jev', 'Jev: 4% likely affected')];
    const filters = [record({ excluded: 1, note: 'src/auth changed' }), record({ name: 'jev', candidates: 2, excluded: 1 })];
    const body = renderMarkdownReport(page({ results, filters }));
    expect(body).toBe(
      [
        '### 🟢 e2e: 1 passed, 2 left out by filters',
        '',
        '**Filter** `areas` kept 2 of 3 tests, left out 1 (src/auth changed)  \n**Filter** `jev` kept 1 of 2 tests, left out 1',
        '',
        [
          '<details>',
          '<summary>2 tests left out by filters</summary>',
          '',
          '| Test | Filter | Reason |',
          '| --- | --- | --- |',
          '| tests/billing.e2e.ts › pays | `areas` | the diff misses billing |',
          '| tests/billing.e2e.ts › refunds | `jev` | Jev: 4% likely affected |',
          '</details>',
        ].join('\n'),
        '',
        '<details>\n<summary>All 1 test in 1 file</summary>\n\n|  | Test | Time |\n| --- | --- | --- |\n| 🟢 | **tests/smoke.e2e.ts** · 1 passed | 850ms |\n| 🟢 | opens the app | 850ms |\n</details>',
        '',
        '<sub>e2e 0.9.0 · 8.4s · web</sub>',
        '',
      ].join('\n'),
    );
  });

  it('counts the tests left out once on a run of several targets or repeats, as the filter line does, with a row per result naming its target', () => {
    /** A test titled `title` that passed on `target`. */
    const ran = (title: string, target: string): ReportResult => named({ title, file: 'tests/billing.e2e.ts', target, status: 'passed' });
    const results = ['web', 'web-2'].flatMap((target) => [ran('alpha', target), leftOut('beta', 'areas', 'unaffected', target), leftOut('gamma', 'areas', 'unaffected', target)]);
    const body = renderMarkdownReport(page({ results, targets: [reportTarget(), reportTarget({ id: 'web-2', index: 1 })], filters: [record({ candidates: 3, excluded: 2 })] }));
    expect(body.startsWith('### 🟢 e2e: 2 passed, 2 left out by filters\n')).toBe(true);
    expect(body).toContain('**Filter** `areas` kept 1 of 3 tests, left out 2\n');
    expect(body).toContain('<summary>2 tests left out by filters</summary>');
    expect(body).toContain('| tests/billing.e2e.ts (web) › beta | `areas` | unaffected |\n| tests/billing.e2e.ts (web) › gamma |');
    expect(body).toContain('| tests/billing.e2e.ts (web-2) › gamma | `areas` | unaffected |');

    const repeated = renderMarkdownReport(page({ results: [0, 1].map((repeat) => ({ ...leftOut('beta', 'areas', 'unaffected'), repeat })), filters: [record({ candidates: 1, excluded: 1 })] }));
    expect(repeated).toContain('### 🟢 e2e: no tests selected, 1 left out by filters\n');
    expect(repeated).toContain('<summary>1 test left out by filters</summary>');
    expect(repeated).toContain('| tests/billing.e2e.ts › beta | `areas` | unaffected |\n| tests/billing.e2e.ts › beta (repeat #1) | `areas` | unaffected |');
  });

  it('reads a filter that kept every test or left every test out, and one that failed and so left nothing out, by its note', () => {
    const failed = record({ name: 'owners', candidates: 1, excluded: 0, note: 'failed, so it leaves nothing out: CODEOWNERS not found', outcome: 'failed' });
    const kept = renderMarkdownReport(page({ results: [passing], filters: [record({ candidates: 1, excluded: 0, note: 'every test reaches src/app.ts' }), failed] }));
    expect(kept).toContain('### 🟢 e2e: 1 passed\n');
    expect(kept).toContain('**Filter** `areas` kept all 1 test (every test reaches src/app.ts)  \n**Filter** `owners` kept all 1 test (failed, so it leaves nothing out: CODEOWNERS not found)\n');
    expect(kept).not.toContain('left out by filters');
    expect(renderMarkdownReport(page({ results: [leftOut('pays', 'areas', 'unaffected')], filters: [record({ candidates: 1, excluded: 1 })] }))).toContain('**Filter** `areas` left out all 1 test\n');
  });

  it('counts what a filter left out from the results, so a test its record counts that ran anyway reads as kept', () => {
    const body = renderMarkdownReport(page({ results: [passing], filters: [record({ candidates: 2, excluded: 1 })] }));
    expect(body).toContain('**Filter** `areas` kept all 2 tests\n');
    expect(body).not.toContain('left out by filters');
  });

  it('escapes what a filter wrote, so a reason or a note cannot break the table or open a block', () => {
    const body = renderMarkdownReport(
      page({ results: [leftOut('pays', 'areas', 'a | b\n# heading <img src=x>')], filters: [record({ candidates: 1, excluded: 1, note: 'note | with pipe' })] }),
    );
    const table = body.split('\n').filter((line) => line.startsWith('| tests/billing.e2e.ts'));
    expect(table).toHaveLength(1);
    expect(table[0]!.split(/(?<!\\)\|/u)).toHaveLength(5);
    expect(body).not.toContain('<img');
    expect(body).not.toMatch(/^# heading/mu);
    expect(body).toContain('note \\| with pipe');
  });

  it('names the change the filters judged above their lines', () => {
    const base = '0123456789abcdef0123456789abcdef01234567';
    const body = renderMarkdownReport(
      page({ results: [passing, leftOut('pays', 'areas', 'unaffected')], changes: { base, files: 12 }, filters: [record({ candidates: 2, excluded: 1 })] }),
    );
    expect(body).toContain('\n**Change** 12 files changed since `0123456`  \n**Filter** `areas` kept 1 of 2 tests, left out 1\n');
    expect(renderMarkdownReport(page({ results: [passing], changes: { base, files: 1 }, filters: [record({ candidates: 1, excluded: 0 })] }))).toContain('\n**Change** 1 file changed since `0123456`  \n');
  });

  it('says why no filter ran, whatever the reason', () => {
    const base = '0123456789abcdef0123456789abcdef01234567';
    for (const changes of [{ skipped: 'no tests to judge' }, { base, files: 0, skipped: 'no files changed since 0123456' }]) {
      expect(renderMarkdownReport(page({ results: [passing], changes })), changes.skipped).toContain(`\n**Filters** none ran: ${changes.skipped}\n`);
    }
  });

  it('caps the left-out table at 50 rows, pointing at report.json for the rest', () => {
    const results = Array.from({ length: 55 }, (_, index) => leftOut(`t${String(index).padStart(2, '0')}`, 'areas', 'unaffected'));
    const body = renderMarkdownReport(page({ results, filters: [record({ candidates: 55, excluded: 55 })] }));
    expect(body).toContain('### 🟢 e2e: no tests selected, 55 left out by filters\n');
    expect(body).toContain('<summary>55 tests left out by filters</summary>');
    expect(body).toContain('| tests/billing.e2e.ts › t49 |');
    expect(body).not.toContain('› t50');
    expect(body).toContain('| and 5 more in report.json |  |  |\n</details>');
  });
});

describe('markdownReporter', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function finished(document: Report1Document, root: string, artifactsRoot = path.join(root, '.e2e', 'artifacts')): FinishedRun {
    return {
      report: document,
      status: document.run.status,
      exitCode: document.run.exitCode,
      projectRoot: root,
      reportPath: path.join(root, '.e2e', 'report.json'),
      artifactsRoot,
      aiTracePath: undefined,
      traces: new Map(),
    };
  }

  it('writes summary.md beside the report with paths from the project root, and returns its row', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-markdown-'));
    dirs.push(root);
    const rows = await markdownReporter.onRunFinished!(finished(explored(), root), new AbortController().signal);
    expect(rows).toEqual([{ label: 'Markdown', text: path.join('.e2e', 'summary.md') }]);
    const text = readFileSync(path.join(root, '.e2e', 'summary.md'), 'utf8');
    expect(text.startsWith('### 🔴 e2e explore: 1 issue\n')).toBe(true);
    expect(text).toContain('   Evidence: screenshot `.e2e/artifacts/web/explore-checkout-d287e8aead677d36/default/attempt-0/finding-0.png`');
    // Artifacts at the project root itself list from `.`.
    await markdownReporter.onRunFinished!(finished(explored(), root, root), new AbortController().signal);
    expect(readFileSync(path.join(root, '.e2e', 'summary.md'), 'utf8')).toContain('   Evidence: screenshot `web/explore-checkout-d287e8aead677d36/default/attempt-0/finding-0.png`');
  });

  it('links each failure block to the page the runner wrote for it', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-markdown-'));
    dirs.push(root);
    const document = page({ status: 'failed', results: [passing, failing] });
    const pages = new Map([[failing.id, '.e2e/traces/members-an-email-invitation-1a2b3c4d.md']]);
    const rows = await markdownReporter.onRunFinished!({ ...finished(document, root), traces: pages }, new AbortController().signal);
    expect(rows).toEqual([{ label: 'Markdown', text: path.join('.e2e', 'summary.md') }]);
    const summary = readFileSync(path.join(root, '.e2e', 'summary.md'), 'utf8');
    expect(summary).toContain('Trace: `.e2e/traces/members-an-email-invitation-1a2b3c4d.md`');
    expect(readdirSync(path.join(root, '.e2e'))).toEqual(['summary.md']);
  });

  it('writes nothing when the report itself was not written', async () => {
    expect(await markdownReporter.onRunFinished!({ ...finished(page(), '/nowhere'), reportPath: undefined }, new AbortController().signal)).toBeUndefined();
  });
});

/**
 * The comment body: counts in the headline, run errors first, one table row
 * per test that did not simply pass, passed tests folded away, untrusted text
 * escaped, and a body that never outgrows what GitHub accepts.
 */

import { describe, expect, it } from 'vitest';
import { renderComment } from '../../src/comment.ts';
import { attempt, report, result } from './fixtures.ts';

const failing = result({
  title: ['billing', 'upgrades to Pro'],
  file: 'tests/billing.e2e.ts',
  line: 12,
  status: 'failed',
  attempts: [
    attempt({
      status: 'failed',
      error: { code: 'ASSERTION_FAILED', message: 'expected heading "Your cart" to be visible' },
      artifacts: ['trace', 'screenshot', 'video'],
    }),
  ],
});
const flaky = result({
  title: 'todos survive a filter round-trip',
  status: 'flaky',
  attempts: [
    attempt({ status: 'failed', error: { code: 'STEP_TIMEOUT', message: 'slow' }, artifacts: ['screenshot'] }),
    attempt({ status: 'passed' }),
  ],
});
const skipped = result({
  title: 'not ready yet',
  status: 'skipped',
  skip: { cause: 'explicit', reason: 'waiting on the API' },
});
const passing = result({ title: 'opens the app', status: 'passed', attempts: [attempt({ durationMs: 850 })] });
const links = {
  artifactsUrl: 'https://github.com/o/r/actions/runs/9',
  sourceUrl: (file: string, line: number) => `https://github.com/o/r/blob/abc/${file}#L${line}`,
};

describe('renderComment', () => {
  it('leads with the counts, tables what did not pass, folds the passed tests, and links the evidence', () => {
    const body = renderComment(report({ status: 'failed', results: [passing, failing, flaky, skipped] }), {
      marker: '<!-- e2e-github project=x -->',
      ...links,
    });
    expect(body).toBe(
      [
        '<!-- e2e-github project=x -->',
        '### 🔴 e2e: 1 failed, 1 flaky, 1 passed, 1 skipped',
        '',
        '| | Test | Outcome | Evidence |',
        '| --- | --- | --- | --- |',
        '| 🔴 | [tests/billing.e2e.ts:12](https://github.com/o/r/blob/abc/tests/billing.e2e.ts#L12) › billing › upgrades to Pro | **ASSERTION_FAILED** expected heading "Your cart" to be visible | [screenshot, video, trace](https://github.com/o/r/actions/runs/9) |',
        // The failed attempt's evidence counts: the passing retry recorded none.
        '| ⚠️ | [tests/example.e2e.ts:3](https://github.com/o/r/blob/abc/tests/example.e2e.ts#L3) › todos survive a filter round-trip | flaky: passed after 1 failed attempt | [screenshot](https://github.com/o/r/actions/runs/9) |',
        '| ⏭️ | [tests/example.e2e.ts:3](https://github.com/o/r/blob/abc/tests/example.e2e.ts#L3) › not ready yet | skipped: waiting on the API |  |',
        '',
        '<details>',
        '<summary>1 passed test</summary>',
        '',
        '- tests/example.e2e.ts › opens the app (850ms)',
        '</details>',
        '',
        'Screenshots, traces, and recordings: [run artifacts](https://github.com/o/r/actions/runs/9).',
        '<sub>e2e 0.9.0 · 8.4s · 1 target (web)</sub>',
        '',
      ].join('\n'),
    );
  });

  it('is a passing headline with no table when everything passed', () => {
    const body = renderComment(report({ results: [passing] }));
    expect(body).toContain('### 🟢 e2e: 1 passed\n');
    expect(body).not.toContain('| Test |');
    expect(body).toContain('- tests/example.e2e.ts › opens the app (850ms)');
    expect(body).not.toContain('run artifacts');
  });

  it('puts run-level errors before the table and says no tests ran', () => {
    const body = renderComment(
      report({
        status: 'error',
        errors: [
          {
            category: 'infrastructure',
            code: 'APP_UNREACHABLE',
            message: 'http://127.0.0.1:3000 did not answer',
            retryable: true,
            phase: 'launch',
          },
        ],
      }),
    );
    expect(body).toContain('### 🔴 e2e: no tests ran\n\n> **APP_UNREACHABLE** (launch) http://127.0.0.1:3000 did not answer\n');
  });

  it('says no tests selected when nothing ran and nothing failed', () => {
    expect(renderComment(report())).toContain('### 🟢 e2e: no tests selected\n');
  });

  it('escapes what a test wrote and keeps it on one line', () => {
    const hostile = result({
      title: 'a | b <img src=x onerror=alert(1)> *c*',
      status: 'failed',
      attempts: [
        attempt({
          status: 'failed',
          error: { code: 'ASSERTION_FAILED', message: 'line one\nline two \u001b[31mred\u001b[0m \u0007`tick`' },
        }),
      ],
    });
    const body = renderComment(report({ status: 'failed', results: [hostile] }));
    expect(body).toContain('a \\| b &lt;img src=x onerror=alert(1)&gt; \\*c\\*');
    expect(body).toContain('line one line two red \\`tick\\`');
    expect(body).not.toContain('\u001b');
    expect(body).not.toContain('\u0007');
  });

  it('clips long text by code point, never through an emoji', () => {
    // 121 and 241 code points: the cut lands on the emoji, which must survive whole.
    const long = result({
      title: `${'x'.repeat(118)}💥yz`,
      status: 'failed',
      attempts: [attempt({ status: 'failed', error: { code: 'E', message: `${'m'.repeat(238)}💥zz` } })],
    });
    const body = renderComment(report({ status: 'failed', results: [long] }));
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(body).not.toMatch(loneSurrogate);
    expect(body).toContain(`${'x'.repeat(118)}💥…`);
    expect(body).toContain(`${'m'.repeat(238)}💥…`);
  });

  it('rounds a duration to whole seconds before splitting off the minutes', () => {
    const at = (finishedAt: string) => renderComment(report({ results: [passing], finishedAt }));
    expect(at('2026-07-24T12:01:59.500Z')).toContain('· 2m 0s ·');
    expect(at('2026-07-24T12:01:29.400Z')).toContain('· 1m 29s ·');
    expect(at('2026-07-24T12:00:59.940Z')).toContain('· 59.9s ·');
  });

  it('names the target only when the run has several, and caps the footer list', () => {
    const body = renderComment(report({ status: 'failed', results: [failing, passing], targets: ['web', 'mobile'] }));
    expect(body).toContain('upgrades to Pro (web) |');
    expect(body).toContain('opens the app (web) (850ms)');
    expect(body).toContain('2 targets (web, mobile)');
    const many = renderComment(report({ results: [passing], targets: Array.from({ length: 12 }, (_, i) => `t${i}`) }));
    expect(many).toContain('12 targets (t0, t1, t2, t3, t4, t5, t6, t7, and 4 more)</sub>');
  });

  it('reads a serial member from its group, evidence from every group attempt', () => {
    const member = result({ title: 'step two', status: 'failed', serialGroupId: 'g1' });
    const group = {
      id: 'g1',
      serialId: 'g1',
      declarationIndex: 0,
      file: member.file,
      source: member.source,
      titlePath: ['group'],
      targetId: 'web',
      platform: 'web',
      agent: 'default',
      memberTestIds: [member.testId],
      status: 'failed' as const,
      attempts: [
        { ...attempt({ status: 'failed', artifacts: ['trace'] }), members: [] },
        {
          ...attempt({ status: 'failed', artifacts: ['screenshot'] }),
          members: [
            {
              id: 'm',
              index: 0,
              testId: member.testId,
              status: 'failed' as const,
              startedAt: '2026-07-24T12:00:00.000Z',
              durationMs: 40,
              steps: [],
              error: { category: 'test' as const, code: 'ASSERTION_FAILED', message: 'nope', retryable: false },
              secondaryErrors: [],
            },
          ],
        },
      ],
    };
    const body = renderComment(report({ status: 'failed', results: [member], serialGroups: [group] }));
    expect(body).toContain('| **ASSERTION_FAILED** nope | screenshot, trace |');
    // A member whose group is missing renders its status rather than an inspection of nothing.
    const orphan = renderComment(report({ status: 'failed', results: [member] }));
    expect(orphan).toContain('| failed |  |');
  });

  it('never says a flaky test passed after no failures, whatever a foreign document holds', () => {
    const oneAttempt = result({ title: 'odd', status: 'flaky', attempts: [attempt({ status: 'passed' })] });
    const body = renderComment(report({ results: [oneAttempt] }));
    expect(body).toContain('| ⚠️ | `tests/example.e2e.ts:3` › odd | flaky |  |');
    expect(body).not.toContain('-1');
  });

  it('caps the table and drops the passed list before the body outgrows a comment', () => {
    const failures = Array.from({ length: 80 }, (_, index) =>
      result({
        title: `failure ${index}`,
        status: 'failed',
        attempts: [attempt({ status: 'failed', error: { code: 'E', message: 'x'.repeat(2_000) } })],
      }),
    );
    const passes = Array.from({ length: 600 }, (_, index) =>
      result({ title: [`suite ${index} `.repeat(15), 'b'.repeat(120), 'c'.repeat(120)], status: 'passed', attempts: [attempt()] }),
    );
    const body = renderComment(report({ status: 'failed', results: [...failures, ...passes] }));
    expect(body).toContain('| | and 30 more | | |');
    // The passed list is one block that no longer fits, so it goes whole and the note says so.
    expect(body).not.toContain('<details>');
    expect(body).toContain('600 passed');
    expect(body).toContain("_Comment truncated to fit GitHub's size limit; the full report is in the run artifacts._");
    expect(body.length).toBeLessThan(65_536);
    const withPassed = renderComment(report({ results: passes.slice(0, 250).map((pass) => ({ ...pass, titlePath: ['short'] })) }));
    expect(withPassed).toContain('<summary>250 passed tests</summary>');
    expect(withPassed).toContain('- and 50 more');
  });

  it('never returns a body GitHub would reject, whatever the report holds', () => {
    // Sixty rows whose titles alone are longer than the whole budget allows.
    const wide = Array.from({ length: 60 }, (_, index) =>
      result({
        title: Array.from({ length: 30 }, (__, part) => `segment ${index}-${part} `.repeat(8)),
        status: 'failed',
        attempts: [attempt({ status: 'failed', error: { code: 'E', message: 'm'.repeat(240) } })],
      }),
    );
    const errors = Array.from({ length: 40 }, (_, index) => ({
      category: 'infrastructure' as const,
      code: `RUN_ERROR_${index}`,
      message: 'e'.repeat(240),
      retryable: false,
    }));
    const body = renderComment(report({ status: 'error', results: wide, errors }), { marker: '<!-- m -->' });
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body.startsWith('<!-- m -->\n### 🔴 e2e: 60 failed\n')).toBe(true);
    expect(body).toContain('> and 20 more');
    expect(body).toContain("_Comment truncated to fit GitHub's size limit; the full report is in the run artifacts._");
    expect(body.trimEnd().endsWith('</sub>')).toBe(true);
    // A run with hundreds of targets does not escape the cap either.
    const targets = Array.from({ length: 300 }, (_, index) => `target-${index}-${'t'.repeat(60)}`);
    expect(renderComment(report({ results: [passing], targets }), { marker: '<!-- m -->' }).length).toBeLessThanOrEqual(60_000);
  });

  it('refuses a marker it could not keep whole, since a rerun finds the comment by it', () => {
    expect(() => renderComment(report(), { marker: `<!-- ${'m'.repeat(1_024)} -->` })).toThrow(
      'marker must be at most 1024 characters, got 1033',
    );
    expect(renderComment(report(), { marker: `<!-- ${'m'.repeat(1_000)} -->` })).toContain('<!-- mmm');
    expect(() => renderComment(report(), { artifactsUrl: `https://x.test/${'a'.repeat(2_048)}` })).toThrow(
      'artifactsUrl must be at most 2048 characters, got 2063',
    );
  });
});

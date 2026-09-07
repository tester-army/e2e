import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ListReporter } from '../../src/report/list.ts';
import { userFrame } from '../../src/report/code-frame.ts';
import type { RunEventFact, RunEventResult } from '../../src/run/events.ts';
import type { ResultStatus, AttemptRecord } from '../../src/run/records.ts';

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;?]*[a-zA-Z]/g;

function capture() {
  const lines: string[] = [];
  return {
    lines,
    output: { write: (line: string) => lines.push(line.replace(ANSI_PATTERN, '')) },
  };
}

function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-1',
    index: 0,
    status: 'passed',
    startedAt: new Date(0).toISOString(),
    durationMs: 120,
    steps: [],
    artifacts: [],
    secondaryErrors: [],
    cleanup: 'complete',
    ...overrides,
  };
}

function result(overrides: {
  status: ResultStatus;
  title?: string[];
  id?: string;
  file?: string;
  target?: string;
  selected?: boolean;
  attempts?: AttemptRecord[];
  skipReason?: string;
}): RunEventResult {
  return {
    test: {
      titlePath: overrides.title ?? ['suite', 'case'],
      id: overrides.id ?? 'test-1',
      file: overrides.file ?? 'tests/case.e2e.ts',
    },
    target: { name: overrides.target ?? 'chromium', platform: 'web' },
    status: overrides.status,
    selected: overrides.selected ?? true,
    skip:
      overrides.skipReason === undefined
        ? undefined
        : { reason: overrides.skipReason },
    attempts: overrides.attempts ?? [attempt()],
  } as unknown as RunEventResult;
}

function runStarted(overrides: { ci?: boolean; targets?: string[]; projectRoot?: string } = {}): RunEventFact {
  return {
    type: 'run-started',
    runId: 'run-1',
    projectId: 'project',
    projectRoot: overrides.projectRoot ?? '/project',
    ci: overrides.ci ?? false,
    targets: overrides.targets ?? ['chromium'],
  };
}

function plan(files: { file: string; target?: string; tests: number }[]): RunEventFact {
  const planned = files.map((entry) => ({
    file: entry.file,
    target: entry.target ?? 'chromium',
    tests: entry.tests,
  }));
  return {
    type: 'plan',
    total: planned.reduce((sum, entry) => sum + entry.tests, 0),
    files: planned,
  };
}

function finished(record: RunEventResult): RunEventFact {
  return { type: 'test-finished', result: record };
}

function runFinished(
  overrides: {
    status?: 'passed' | 'failed' | 'error';
    exitCode?: 0 | 1 | 2;
    reportPath?: string;
    junitPath?: string;
    aiTracePath?: string;
  } = {},
): RunEventFact {
  return {
    type: 'run-finished',
    status: overrides.status ?? 'passed',
    exitCode: overrides.exitCode ?? 0,
    ...(overrides.reportPath === undefined ? {} : { reportPath: overrides.reportPath }),
    ...(overrides.junitPath === undefined ? {} : { junitPath: overrides.junitPath }),
    ...(overrides.aiTracePath === undefined ? {} : { aiTracePath: overrides.aiTracePath }),
  };
}

function testStarted(testId: string, title: string, target: string, file = 'tests/case.e2e.ts'): RunEventFact {
  return { type: 'test-started', testId, title, file, target };
}

function failedAttempt(message: string, stack?: string): AttemptRecord {
  return attempt({
    status: 'failed',
    error: {
      category: 'test',
      code: 'ASSERTION_FAILED',
      message,
      retryable: false,
      ...(stack === undefined ? {} : { stack }),
    },
  });
}

/** Reporter with colors off, so assertions read the plain text. */
function plainReporter(output: { write(line: string): void; raw?(text: string): void }, live = false) {
  return new ListReporter(output, { live, colors: false });
}

describe('ListReporter', () => {
  it('prints a RUN banner with the version, root, run id, targets, and CI marker', () => {
    const { lines, output } = capture();
    plainReporter(output).handle(runStarted({ targets: ['chromium', 'firefox'], ci: true }));
    expect(lines[1]).toMatch(/^ RUN {2}e2e v\d+\.\d+\.\d+ \/project$/);
    expect(lines[2]).toContain('run run-1');
    expect(lines[2]).toContain('targets: chromium, firefox');
    expect(lines[2]).toContain('CI');
    expect(lines).toEqual(['', lines[1], lines[2], '']);
  });

  it('omits the CI marker outside CI', () => {
    const { lines, output } = capture();
    plainReporter(output).handle(runStarted({ ci: false }));
    expect(lines[2]).not.toContain('CI');
  });

  it('acknowledges each interrupt the moment it lands', () => {
    const { lines, output } = capture();
    const reporter = plainReporter(output);
    reporter.handle({ type: 'run-interrupted', mode: 'graceful' });
    reporter.handle({ type: 'run-interrupted', mode: 'forced' });
    expect(lines).toEqual([
      'interrupted: stopping the running test and tearing down (interrupt again to force)',
      'interrupted again: tearing every worker down now',
    ]);
  });

  describe('file blocks', () => {
    it('prints one line per file with its badge, counts, and total duration once the file completes', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(runStarted());
      reporter.handle(plan([{ file: 'tests/auth.e2e.ts', tests: 2 }]));
      lines.length = 0;
      reporter.handle(finished(
        result({ status: 'passed', id: 'a', file: 'tests/auth.e2e.ts', title: ['auth', 'signs in'], attempts: [attempt({ durationMs: 80 })] }),
      ));
      expect(lines).toEqual([]);
      reporter.handle(finished(
        result({ status: 'passed', id: 'b', file: 'tests/auth.e2e.ts', title: ['auth', 'signs out'], attempts: [attempt({ durationMs: 70 })] }),
      ));
      expect(lines[0]).toBe(' ✓ |chromium| tests/auth.e2e.ts (2 tests) 150ms');
    });

    it('lists every test under the run\u2019s only file', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(plan([{ file: 'tests/auth.e2e.ts', tests: 1 }]));
      reporter.handle(finished(
        result({ status: 'passed', file: 'tests/auth.e2e.ts', title: ['auth', 'signs in'], attempts: [attempt({ durationMs: 80 })] }),
      ));
      expect(lines).toEqual([
        ' ✓ |chromium| tests/auth.e2e.ts (1 test) 80ms',
        '   ✓ auth > signs in 80ms',
      ]);
    });

    it('keeps passing files to one line when the run has several', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(plan([
        { file: 'tests/a.e2e.ts', tests: 1 },
        { file: 'tests/b.e2e.ts', tests: 1 },
      ]));
      reporter.handle(finished(result({ status: 'passed', id: 'a', file: 'tests/a.e2e.ts' })));
      reporter.handle(finished(result({ status: 'passed', id: 'b', file: 'tests/b.e2e.ts' })));
      expect(lines).toEqual([
        ' ✓ |chromium| tests/a.e2e.ts (1 test) 120ms',
        ' ✓ |chromium| tests/b.e2e.ts (1 test) 120ms',
      ]);
    });

    it('marks a failed file with a pointer, lists its tests, and shows the first error line', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(plan([
        { file: 'tests/a.e2e.ts', tests: 2 },
        { file: 'tests/b.e2e.ts', tests: 1 },
      ]));
      reporter.handle(finished(result({ status: 'passed', id: 'a1', file: 'tests/a.e2e.ts', title: ['first'] })));
      reporter.handle(finished(result({
        status: 'failed',
        id: 'a2',
        file: 'tests/a.e2e.ts',
        title: ['suite', 'second'],
        attempts: [failedAttempt('expected visible\nactual hidden')],
      })));
      expect(lines).toEqual([
        ' ❯ |chromium| tests/a.e2e.ts (2 tests | 1 failed) 240ms',
        '   ✓ first 120ms',
        '   × suite > second 120ms',
        '     → expected visible',
      ]);
    });

    it('sums durations across attempts and marks flaky results', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(plan([{ file: 'tests/a.e2e.ts', tests: 1 }, { file: 'tests/b.e2e.ts', tests: 1 }]));
      reporter.handle(finished(
        result({
          status: 'flaky',
          file: 'tests/a.e2e.ts',
          attempts: [attempt({ durationMs: 100, status: 'failed' }), attempt({ durationMs: 50 })],
        }),
      ));
      expect(lines).toEqual([
        ' ✓ |chromium| tests/a.e2e.ts (1 test | 1 flaky) 150ms',
        '   ✓ suite > case (flaky) 150ms',
      ]);
    });

    it('renders skipped results with the skip reason and a skipped file with a down arrow', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(plan([{ file: 'tests/a.e2e.ts', tests: 1 }]));
      reporter.handle(finished(result({ status: 'skipped', file: 'tests/a.e2e.ts', skipReason: 'wip feature' })));
      expect(lines).toEqual([
        ' ↓ |chromium| tests/a.e2e.ts (1 test | 1 skipped) 120ms',
        '   ↓ suite > case [wip feature]',
      ]);
    });

    it('labels timed-out and interrupted tests with their status', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(plan([{ file: 'tests/a.e2e.ts', tests: 2 }]));
      reporter.handle(finished(result({ status: 'timed-out', id: 'a', file: 'tests/a.e2e.ts', title: ['slow'] })));
      reporter.handle(finished(result({ status: 'interrupted', id: 'b', file: 'tests/a.e2e.ts', title: ['cut'] })));
      expect(lines).toContain('   × slow (timed-out) 120ms');
      expect(lines).toContain('   × cut (interrupted) 120ms');
    });

    it('suppresses deselected skipped results entirely', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(finished(result({ status: 'skipped', selected: false })));
      reporter.handle(runFinished({ reportPath: 'r.json' }));
      expect(lines.join('\n')).not.toContain('tests/case.e2e.ts');
      expect(lines.join('\n')).toContain('no tests executed');
    });

    it('prints unfinished files at the end of an interrupted run', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(plan([{ file: 'tests/a.e2e.ts', tests: 3 }]));
      reporter.handle(finished(result({ status: 'passed', id: 'a', file: 'tests/a.e2e.ts', title: ['first'] })));
      expect(lines).toEqual([]);
      reporter.handle(runFinished({ status: 'failed', exitCode: 1 }));
      expect(lines[0]).toBe(' ✓ |chromium| tests/a.e2e.ts (1 test) 120ms');
    });

    it('groups the same file per target, colored by target order', () => {
      const chunks: string[] = [];
      const reporter = new ListReporter({ write: (line) => chunks.push(line) }, { live: false, colors: true });
      reporter.handle(runStarted({ targets: ['chromium', 'firefox'] }));
      reporter.handle(plan([
        { file: 'tests/a.e2e.ts', target: 'chromium', tests: 1 },
        { file: 'tests/a.e2e.ts', target: 'firefox', tests: 1 },
      ]));
      reporter.handle(finished(result({ status: 'passed', target: 'firefox', file: 'tests/a.e2e.ts' })));
      reporter.handle(finished(result({ status: 'passed', target: 'chromium', file: 'tests/a.e2e.ts' })));
      const blocks = chunks.filter((line) => line.includes('tests/a.e2e.ts'));
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toContain(' firefox ');
      expect(blocks[1]).toContain(' chromium ');
      // First target yellow, second cyan: vitest's badge palette in declaration order.
      expect(blocks[1]).toContain('\u001b[43m');
      expect(blocks[0]).toContain('\u001b[46m');
    });
  });

  describe('failed tests section', () => {
    it('prints a banner, one FAIL entry per failure with the error, and numbered dividers', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(runStarted());
      reporter.handle(plan([{ file: 'tests/a.e2e.ts', tests: 2 }]));
      reporter.handle(finished(result({
        status: 'failed',
        id: 'a',
        file: 'tests/a.e2e.ts',
        title: ['suite', 'first'],
        attempts: [failedAttempt('expected visible\nactual hidden')],
      })));
      reporter.handle(finished(result({
        status: 'failed',
        id: 'b',
        file: 'tests/a.e2e.ts',
        title: ['second'],
        attempts: [failedAttempt('boom')],
      })));
      reporter.handle(runFinished({ status: 'failed', exitCode: 1, reportPath: '/project/.e2e/report.json' }));
      const text = lines.join('\n');
      expect(text).toContain(' Failed Tests 2 ');
      expect(lines).toContain(' FAIL  |chromium| tests/a.e2e.ts > suite > first');
      expect(lines).toContain('ASSERTION_FAILED: expected visible');
      expect(lines).toContain('actual hidden');
      expect(lines).toContain(' FAIL  |chromium| tests/a.e2e.ts > second');
      expect(lines).toContain('ASSERTION_FAILED: boom');
      expect(lines.some((line) => line.endsWith('[1/2]⎯'))).toBe(true);
      expect(lines.some((line) => line.endsWith('[2/2]⎯'))).toBe(true);
      // Failures come after the file blocks and before the summary.
      expect(text.indexOf(' Failed Tests 2 ')).toBeGreaterThan(text.indexOf(' ❯ |chromium| tests/a.e2e.ts'));
      expect(text.indexOf(' Failed Tests 2 ')).toBeLessThan(text.indexOf('Test Files'));
    });

    it('names the status when a failure recorded no error', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(finished(result({ status: 'interrupted', attempts: [attempt({ status: 'interrupted' })] })));
      reporter.handle(runFinished({ status: 'failed', exitCode: 1 }));
      expect(lines).toContain('interrupted: no error was recorded');
    });
  });

  describe('failure locations', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-list-'));

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('extracts the first project frame, skipping runner and node_modules frames', () => {
      const stack = [
        'TestError: expect.toContainText failed',
        '    at Object.onTimeout (/elsewhere/runner/src/expect/async.ts:110:11)',
        `    at async poll (${root}/node_modules/lib/poll.js:5:1)`,
        `    at async Object.fn (${root}/tests/login.e2e.ts:28:9)`,
        `    at async mainWork (file:///elsewhere/runner/dist/run/execute.js:316:17)`,
      ].join('\n');
      expect(userFrame(stack, root)).toEqual({
        file: `${root}/tests/login.e2e.ts`,
        line: 28,
        column: 9,
      });
    });

    it('resolves file URLs and strips module-cache query strings', () => {
      const stack = `    at async Object.fn (file://${root}/tests/login.e2e.ts?worker-collect-1:7:3)`;
      expect(userFrame(stack, root)).toEqual({
        file: `${root}/tests/login.e2e.ts`,
        line: 7,
        column: 3,
      });
    });

    it('returns undefined without a stack, root, or matching frame', () => {
      expect(userFrame(undefined, root)).toBeUndefined();
      expect(userFrame('    at async fn (/other/place.ts:1:1)', root)).toBeUndefined();
      expect(userFrame(`    at async fn (${root}/tests/login.e2e.ts:1:1)`, undefined)).toBeUndefined();
    });

    it('prints the failing line and a gutter-numbered code frame under the error', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'e2e-frame-'));
      const file = path.join(dir, 'login.e2e.ts');
      writeFileSync(
        file,
        [
          "import { test } from '@e2edev/playwright';",
          '',
          'await app.open();',
          'await expect(status).toContainText("Welcome");',
          'await done();',
          '',
          'export {};',
        ].join('\n'),
      );
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(runStarted({ targets: ['web'], projectRoot: dir }));
      reporter.handle(finished(
        result({
          status: 'failed',
          attempts: [
            failedAttempt(
              'expect.toContainText failed',
              `TestError: expect.toContainText failed\n    at async Object.fn (${file}:4:22)`,
            ),
          ],
        }),
      ));
      reporter.handle(runFinished({ status: 'failed', exitCode: 1 }));
      expect(lines).toContain(' ❯ login.e2e.ts:4:22');
      expect(lines).toContain('      2|');
      expect(lines).toContain('      3| await app.open();');
      expect(lines).toContain('      4| await expect(status).toContainText("Welcome");');
      expect(lines).toContain('      5| await done();');
      expect(lines).toContain('      6|');
      const frameIndex = lines.indexOf('      4| await expect(status).toContainText("Welcome");');
      const caret = lines[frameIndex + 1]!;
      expect(caret.trimEnd().endsWith('^')).toBe(true);
      // The caret sits under column 22 of the source line.
      expect(caret.indexOf('^')).toBe('      4| '.length + 21);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('summary', () => {
    it('counts timed-out and interrupted results as failures', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(finished(result({ status: 'timed-out', id: 'a' })));
      reporter.handle(finished(result({ status: 'interrupted', id: 'b' })));
      reporter.handle(runFinished({ status: 'failed', exitCode: 1, reportPath: '.e2e/report.json' }));
      expect(lines).toContain('      Tests  2 failed | 0 passed (2)');
    });

    it('summarizes files, tests, and the report path relative to the project', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(runStarted());
      reporter.handle(plan([{ file: 'tests/a.e2e.ts', tests: 3 }, { file: 'tests/b.e2e.ts', tests: 1 }]));
      reporter.handle(finished(result({ status: 'passed', id: 'a', file: 'tests/a.e2e.ts' })));
      reporter.handle(finished(result({ status: 'flaky', id: 'b', file: 'tests/a.e2e.ts' })));
      reporter.handle(finished(result({ status: 'failed', id: 'c', file: 'tests/a.e2e.ts' })));
      reporter.handle(finished(result({ status: 'skipped', id: 'd', file: 'tests/b.e2e.ts', skipReason: 'x' })));
      reporter.handle(runFinished({
        status: 'failed',
        exitCode: 1,
        reportPath: '/project/.e2e/report.json',
        junitPath: '/project/.e2e/junit.xml',
        aiTracePath: '/project/.e2e/ai-trace.json',
      }));
      expect(lines).toContain(' Test Files  1 failed | 0 passed | 1 skipped (2)');
      expect(lines).toContain('      Tests  1 failed | 1 passed | 1 flaky | 1 skipped (4)');
      expect(lines.some((line) => /^ {3}Start at {2}\d\d:\d\d:\d\d$/.test(line))).toBe(true);
      expect(lines.some((line) => /^ {3}Duration {2}\d+(\.\d+)?m?s$/.test(line))).toBe(true);
      expect(lines).toContain('     Report  .e2e/report.json');
      expect(lines).toContain('      JUnit  .e2e/junit.xml');
      expect(lines).toContain('   AI trace  .e2e/ai-trace.json (open with: npx unbox-ai .e2e/ai-trace.json)');
      expect(lines.at(-1)).toBe('');
    });

    it('reports model usage per file and for the run', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(plan([{ file: 'tests/a.e2e.ts', tests: 1 }]));
      const step = {
        id: 's',
        index: 0,
        kind: 'agent',
        api: 'agent.act',
        label: 'do it',
        status: 'passed',
        startedAt: new Date(0).toISOString(),
        durationMs: 10,
        events: [],
        artifacts: [],
        model: { calls: 3, inputTokens: 12_000, outputTokens: 400, estimatedCostUsd: 0.0123 },
      } as unknown as AttemptRecord['steps'][number];
      reporter.handle(finished(result({ status: 'passed', file: 'tests/a.e2e.ts', attempts: [attempt({ steps: [step] })] })));
      reporter.handle(runFinished({ reportPath: 'r.json' }));
      expect(lines[0]).toBe(' ✓ |chromium| tests/a.e2e.ts (1 test) 120ms ai 12.4k tokens · $0.0123');
      expect(lines[1]).toBe('   ✓ suite > case 120ms ai 12.4k tokens · $0.0123');
      expect(lines).toContain('         AI  ai 12.4k tokens · $0.0123 · 3 model calls');
    });

    it('renders a config failure: run-error then run-finished, no run-started', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle({
        type: 'run-error',
        error: {
          category: 'configuration',
          code: 'INVALID_CONFIG',
          message: 'unknown config key "nope"',
          retryable: false,
          phase: 'config',
        },
      });
      reporter.handle(runFinished({ status: 'error', exitCode: 2 }));
      const text = lines.join('\n');
      expect(text).toContain(' Run Errors 1 ');
      expect(lines).toContain(' ERROR  configuration error INVALID_CONFIG (config)');
      expect(lines).toContain('unknown config key "nope"');
      expect(lines).toContain(' Test Files  no test files');
      expect(lines).toContain('      Tests  no tests executed');
      expect(lines).toContain('     Errors  1 error');
      expect(lines).toContain('     Report  (not written)');
    });

    it('prints "no tests executed" when nothing ran', () => {
      const { lines, output } = capture();
      plainReporter(output).handle(runFinished({ reportPath: 'r.json' }));
      expect(lines.join('\n')).toContain('no tests executed');
    });
  });

  describe('step streaming', () => {
    function agentStep(phase: 'start' | 'end', label: string, status: 'passed' | 'failed' = 'passed') {
      return phase === 'start'
        ? { phase: 'start' as const, kind: 'agent' as const, api: 'agent.act', label }
        : {
            phase: 'end' as const,
            kind: 'agent' as const,
            api: 'agent.act',
            label,
            status,
            durationMs: 4_200,
            modelCalls: 3,
          };
    }

    it('streams a header and finished agent steps permanently when one test runs alone', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(plan([{ file: 'tests/flow.e2e.ts', tests: 1 }]));
      reporter.handle(testStarted('t1', 'checkout', 'chromium', 'tests/flow.e2e.ts'));
      reporter.handle({ type: 'step', testId: 't1', target: 'chromium', progress: agentStep('start', 'add to cart') });
      reporter.handle({ type: 'step', testId: 't1', target: 'chromium', progress: agentStep('end', 'add to cart') });
      reporter.handle({ type: 'step', testId: 't1', target: 'chromium', progress: agentStep('start', 'pay') });
      reporter.handle({ type: 'step', testId: 't1', target: 'chromium', progress: agentStep('end', 'pay', 'failed') });
      reporter.handle(finished(result({
        status: 'failed',
        id: 't1',
        file: 'tests/flow.e2e.ts',
        title: ['checkout'],
        attempts: [failedAttempt('pay step failed')],
      })));
      expect(lines).toEqual([
        ' ❯ |chromium| tests/flow.e2e.ts > checkout',
        '   ✓ agent.act "add to cart" 4.20s · 3 model calls',
        '   × agent.act "pay" 4.20s · 3 model calls failed',
        ' ❯ |chromium| tests/flow.e2e.ts (1 test | 1 failed) 120ms',
        '   × checkout 120ms',
        '     → pay step failed',
      ]);
    });

    it('prefixes finished agent steps with their test when tests run in parallel', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(plan([{ file: 'tests/flow.e2e.ts', tests: 2 }]));
      reporter.handle(testStarted('t1', 'checkout', 'chromium', 'tests/flow.e2e.ts'));
      reporter.handle(testStarted('t2', 'refund', 'chromium', 'tests/flow.e2e.ts'));
      reporter.handle({ type: 'step', testId: 't1', target: 'chromium', progress: agentStep('start', 'add to cart') });
      reporter.handle({ type: 'step', testId: 't1', target: 'chromium', progress: agentStep('end', 'add to cart') });
      expect(lines).toEqual(['   ✓ checkout > agent.act "add to cart" 4.20s · 3 model calls']);
    });

    it('keeps deterministic steps out of the permanent log', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(testStarted('t1', 'checkout', 'chromium'));
      reporter.handle({
        type: 'step',
        testId: 't1',
        target: 'chromium',
        progress: { phase: 'start', kind: 'locator', api: 'locator.tap', label: 'button' },
      });
      reporter.handle({
        type: 'step',
        testId: 't1',
        target: 'chromium',
        progress: { phase: 'end', kind: 'locator', api: 'locator.tap', label: 'button', status: 'passed', durationMs: 5, modelCalls: 0 },
      });
      expect(lines).toEqual([]);
    });
  });

  describe('live window', () => {
    function liveCapture() {
      const chunks: string[] = [];
      const lines: string[] = [];
      return {
        chunks,
        lines,
        output: {
          write: (line: string) => {
            lines.push(line.replace(ANSI_PATTERN, ''));
            chunks.push(`${line}\n`);
          },
          raw: (text: string) => chunks.push(text),
        },
      };
    }

    it('shows a running file and test on start and erases the window before a result prints', () => {
      const { chunks, output } = liveCapture();
      const reporter = plainReporter(output, true);
      reporter.handle(runStarted());
      reporter.handle(plan([{ file: 'tests/case.e2e.ts', tests: 1 }]));
      reporter.handle(testStarted('t1', 'signs in', 'chromium'));
      const window = chunks.at(-1)!;
      expect(window).toContain(' ❯ |chromium| tests/case.e2e.ts 0/1');
      expect(window).toContain('└── signs in');
      expect(window).toContain('Test Files  0 passed (1)');
      reporter.handle(finished(result({ status: 'passed', title: ['signs in'], id: 't1' })));
      // The window above the result line is erased before the block prints.
      expect(chunks.some((chunk) => chunk.includes('\u001b[0J'))).toBe(true);
      expect(chunks.at(-1)).not.toContain('└──');
    });

    it('shows the current step and its latest calls under the running test', () => {
      const { chunks, output } = liveCapture();
      const reporter = plainReporter(output, true);
      reporter.handle(runStarted());
      reporter.handle(testStarted('t1', 'a', 'chromium'));
      reporter.handle(testStarted('t2', 'b', 'chromium'));
      reporter.handle({
        type: 'step',
        testId: 't1',
        target: 'chromium',
        progress: { phase: 'start', kind: 'agent', api: 'agent.act', label: 'add a todo' },
      });
      reporter.handle({
        type: 'step',
        testId: 't1',
        target: 'chromium',
        progress: {
          phase: 'event',
          api: 'agent.act',
          event: { kind: 'model', durationMs: 1_200, count: 1_100 } as never,
        },
      });
      const window = chunks.at(-1)!;
      expect(window).toContain('├── a');
      expect(window).toContain('↳ agent.act "add a todo"');
      expect(window).toContain('model turn 1.20s · 1.1k tokens');
      expect(window).toContain('└── b');
    });

    it('tracks the counters in the window as results arrive', () => {
      const { chunks, output } = liveCapture();
      const reporter = plainReporter(output, true);
      reporter.handle(runStarted());
      reporter.handle(plan([{ file: 'tests/a.e2e.ts', tests: 3 }, { file: 'tests/b.e2e.ts', tests: 2 }]));
      expect(chunks.at(-1)).toContain('Test Files  0 passed (2)');
      expect(chunks.at(-1)).toContain('Tests  0 passed (5)');
      reporter.handle(finished(result({ status: 'passed', id: 'a', file: 'tests/a.e2e.ts' })));
      reporter.handle(finished(result({ status: 'failed', id: 'b', file: 'tests/b.e2e.ts' })));
      reporter.handle(finished(result({ status: 'passed', id: 'c', file: 'tests/b.e2e.ts' })));
      expect(chunks.at(-1)).toContain('Test Files  1 failed | 0 passed (2)');
      expect(chunks.at(-1)).toContain('Tests  1 failed | 2 passed (5)');
      reporter.handle(runFinished({ reportPath: 'r.json' }));
      expect(chunks.join('')).toContain('Test Files  1 failed | 1 passed (2)');
    });

    it('prints a notice permanently above the live window', () => {
      const { chunks, lines, output } = liveCapture();
      const reporter = plainReporter(output, true);
      reporter.handle(runStarted());
      reporter.handle({
        type: 'notice',
        target: 'web',
        message: 'Downloading missing Playwright browsers (first run): chromium...',
      });
      expect(lines).toContain('ℹ Downloading missing Playwright browsers (first run): chromium...');
      // The window is erased before the notice prints and repainted after it,
      // so a first-run download narrates in scrollback instead of under the block.
      // eslint-disable-next-line no-control-regex
      const eraseIndex = chunks.findIndex((chunk) => /\u001b\[\d+A\u001b\[0J$/.test(chunk));
      const noticeIndex = chunks.findIndex((chunk) => chunk.includes('Downloading'));
      expect(eraseIndex).toBeGreaterThan(-1);
      expect(eraseIndex).toBeLessThan(noticeIndex);
      expect(chunks.at(-1)).toContain('Tests');
    });

    it('never writes control sequences when live rendering is off', () => {
      const { chunks, output } = liveCapture();
      const reporter = plainReporter(output, false);
      reporter.handle(runStarted());
      reporter.handle(testStarted('t1', 'signs in', 'chromium'));
      reporter.handle(finished(result({ status: 'passed' })));
      reporter.handle(runFinished({ reportPath: 'r.json' }));
      expect(chunks.join('')).not.toContain('\u001b[');
    });

    it('stays silent for output sinks without a raw channel', () => {
      const { lines, output } = capture();
      const reporter = new ListReporter(output, { live: true, colors: false });
      reporter.handle(testStarted('t1', 'signs in', 'chromium'));
      expect(lines).toEqual([]);
    });
  });

  it('renders a full lifecycle from events alone', () => {
    const { lines, output } = capture();
    const reporter = plainReporter(output);
    reporter.handle(runStarted({ targets: ['web'] }));
    reporter.handle(plan([{ file: 'tests/a.e2e.ts', target: 'web', tests: 1 }]));
    reporter.handle(testStarted('test-1', 'a test', 'web', 'tests/a.e2e.ts'));
    reporter.handle(finished(result({ status: 'passed', title: ['a test'], target: 'web', file: 'tests/a.e2e.ts' })));
    reporter.handle(runFinished({ reportPath: '/x/.e2e/report.json' }));
    const text = lines.join('\n');
    expect(text).toContain('run run-1');
    expect(text).toContain(' ✓ |web| tests/a.e2e.ts (1 test) 120ms');
    expect(text).toContain('   ✓ a test 120ms');
    expect(text).toContain('Tests  1 passed (1)');
    expect(text).toContain('Report  /x/.e2e/report.json');
  });

  it('sanitizes control characters in titles and bounds long fields', () => {
    const { lines, output } = capture();
    const reporter = plainReporter(output);
    reporter.handle(plan([{ file: 'tests/a.e2e.ts', tests: 1 }]));
    reporter.handle(finished(result({ status: 'passed', file: 'tests/a.e2e.ts', title: ['bad\u0007title\u001b[31m'] })));
    expect(lines.join('\n')).not.toContain('\u0007');
    const { lines: longLines, output: longOutput } = capture();
    const longReporter = plainReporter(longOutput);
    longReporter.handle(plan([{ file: 'tests/a.e2e.ts', tests: 1 }]));
    longReporter.handle(finished(result({ status: 'passed', file: 'tests/a.e2e.ts', title: ['x'.repeat(20_000)] })));
    expect(Buffer.byteLength(longLines[1] ?? '', 'utf8')).toBeLessThan(10_000);
  });
});

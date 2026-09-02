import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ListReporter } from '../../src/report/list.ts';
import { userFrame } from '../../src/report/code-frame.ts';
import type { RunEventFact, RunEventResult } from '../../src/run/events.ts';
import type { ResultStatus, AttemptRecord } from '../../src/run/records.ts';

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

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
  selected?: boolean;
  attempts?: AttemptRecord[];
  skipReason?: string;
}): RunEventResult {
  return {
    test: { titlePath: overrides.title ?? ['suite', 'case'], id: overrides.id ?? 'test-1' },
    target: { name: 'chromium', platform: 'web' },
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

function finished(record: RunEventResult): RunEventFact {
  return { type: 'test-finished', result: record };
}

function runFinished(overrides: { status?: 'passed' | 'failed' | 'error'; exitCode?: 0 | 1 | 2; reportPath?: string } = {}): RunEventFact {
  return {
    type: 'run-finished',
    status: overrides.status ?? 'passed',
    exitCode: overrides.exitCode ?? 0,
    ...(overrides.reportPath === undefined ? {} : { reportPath: overrides.reportPath }),
  };
}

function testStarted(testId: string, title: string, target: string): RunEventFact {
  return { type: 'test-started', testId, title, target };
}

describe('ListReporter', () => {
  it('prints the run header with targets and CI marker', () => {
    const { lines, output } = capture();
    new ListReporter(output).handle(runStarted({ targets: ['chromium', 'firefox'], ci: true }));
    expect(lines[0]).toContain('e2e run run-1');
    expect(lines[0]).toContain('chromium, firefox');
    expect(lines[0]).toContain('[CI]');
    expect(lines).toHaveLength(1);
  });

  it('omits the CI marker outside CI', () => {
    const { lines, output } = capture();
    new ListReporter(output).handle(runStarted({ ci: false }));
    expect(lines[0]).not.toContain('[CI]');
  });

  it('renders a passed result with title path, target, and total duration', () => {
    const { lines, output } = capture();
    new ListReporter(output).handle(finished(
      result({ status: 'passed', title: ['auth', 'signs in'], attempts: [attempt({ durationMs: 80 })] }),
    ));
    expect(lines[0]).toContain('\u2713 auth \u203a signs in');
    expect(lines[0]).toContain('[chromium] 80ms');
  });

  it('sums durations across attempts and marks flaky results', () => {
    const { lines, output } = capture();
    new ListReporter(output).handle(finished(
      result({
        status: 'flaky',
        attempts: [attempt({ durationMs: 100, status: 'failed' }), attempt({ durationMs: 50 })],
      }),
    ));
    expect(lines[0]).toContain('(flaky)');
    expect(lines[0]).toContain('150ms');
  });

  it('renders skipped results with the skip reason', () => {
    const { lines, output } = capture();
    new ListReporter(output).handle(finished(result({ status: 'skipped', skipReason: 'wip feature' })));
    expect(lines[0]).toContain('- suite \u203a case');
    expect(lines[0]).toContain('skipped: wip feature');
  });

  it('suppresses deselected skipped results entirely', () => {
    const { lines, output } = capture();
    new ListReporter(output).handle(finished(result({ status: 'skipped', selected: false })));
    expect(lines).toEqual([]);
  });

  it('renders failures with the last attempt error message indented', () => {
    const { lines, output } = capture();
    new ListReporter(output).handle(finished(
      result({
        status: 'failed',
        attempts: [
          attempt({
            status: 'failed',
            error: {
              category: 'test',
              code: 'ASSERTION_FAILED',
              message: 'expected visible\nactual hidden',
              retryable: false,
            },
          }),
        ],
      }),
    ));
    expect(lines[0]).toContain('\u2717 suite \u203a case');
    expect(lines[0]).toContain('failed');
    expect(lines[1]).toBe('    expected visible');
    expect(lines[2]).toBe('    actual hidden');
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

    it('prints the failing line and a code frame under the error message', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'e2e-frame-'));
      const file = path.join(dir, 'login.e2e.ts');
      writeFileSync(
        file,
        ['await app.open();', 'await expect(status).toContainText("Welcome");', 'await done();'].join(
          '\n',
        ),
      );
      const { lines, output } = capture();
      const reporter = new ListReporter(output);
      reporter.handle(runStarted({ targets: ['web'], projectRoot: dir }));
      reporter.handle(finished(
        result({
          status: 'failed',
          attempts: [
            attempt({
              status: 'failed',
              error: {
                category: 'test',
                code: 'ASSERTION_FAILED',
                message: 'expect.toContainText failed',
                retryable: false,
                stack: `TestError: expect.toContainText failed\n    at async Object.fn (${file}:2:22)`,
              },
            }),
          ],
        }),
      ));
      const text = lines.join('\n');
      expect(text).toContain('at login.e2e.ts:2:22');
      expect(text).toContain('> 2 | await expect(status).toContainText("Welcome");');
      expect(text).toContain('1 | await app.open();');
      expect(text).toContain('3 | await done();');
      const caret = lines.find((line) => line.trimEnd().endsWith('^'))!;
      expect(caret.indexOf('^')).toBeGreaterThan(0);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  it('counts timed-out and interrupted results as failures in the summary', () => {
    const { lines, output } = capture();
    const reporter = new ListReporter(output);
    reporter.handle(finished(result({ status: 'timed-out' })));
    reporter.handle(finished(result({ status: 'interrupted' })));
    reporter.handle(runFinished({ status: 'failed', exitCode: 1, reportPath: '.e2e/report.json' }));
    expect(lines.join('\n')).toContain('2 failed');
  });

  it('summarizes mixed outcomes and the report path', () => {
    const { lines, output } = capture();
    const reporter = new ListReporter(output);
    reporter.handle(finished(result({ status: 'passed' })));
    reporter.handle(finished(result({ status: 'flaky' })));
    reporter.handle(finished(result({ status: 'failed' })));
    reporter.handle(finished(result({ status: 'skipped', skipReason: 'x' })));
    reporter.handle(runFinished({ status: 'failed', exitCode: 1, reportPath: '.e2e/report.json' }));
    const summary = lines[lines.length - 2];
    expect(summary).toContain('1 passed');
    expect(summary).toContain('1 failed');
    expect(summary).toContain('1 flaky');
    expect(summary).toContain('1 skipped');
    expect(lines[lines.length - 1]).toContain('report: .e2e/report.json');
  });

  describe('live status block', () => {
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

    it('shows a running test on start and removes it on result', () => {
      const { chunks, output } = liveCapture();
      const reporter = new ListReporter(output, { live: true });
      reporter.handle(testStarted('t1', 'signs in', 'web'));
      const status = chunks.join('');
      expect(status).toContain('signs in');
      // The running marker is the first spinner frame until the timer advances.
      expect(status).toContain('\u280B');
      reporter.handle(finished(result({ status: 'passed', title: ['signs in'], attempts: [attempt()] })));
      // The block above the result line is erased before the result prints.
      expect(chunks.some((chunk) => chunk.includes('\u001b[1A\u001b[0J'))).toBe(true);
    });

    it('tracks waiting, running, and completed counts in the progress line', () => {
      const { chunks, output } = liveCapture();
      const reporter = new ListReporter(output, { live: true });
      reporter.handle({ type: 'plan', total: 5 });
      expect(chunks.at(-1)).toContain('0/5 done \u00b7 0 running \u00b7 5 waiting');
      reporter.handle(testStarted('t1', 'first', 'chromium'));
      reporter.handle(testStarted('t2', 'second', 'chromium'));
      expect(chunks.at(-1)).toContain('0/5 done \u00b7 2 running \u00b7 3 waiting');
      reporter.handle(finished(result({ status: 'passed', title: ['first'], id: 't1' })));
      expect(chunks.at(-1)).toContain('1/5 done \u00b7 1 running \u00b7 3 waiting');
      reporter.handle(runFinished({ reportPath: 'r.json' }));
      const text = chunks.join('');
      expect(text).toContain('1 passed');
    });

    it('never writes control sequences when live rendering is off', () => {
      const { chunks, output } = liveCapture();
      const reporter = new ListReporter(output, { live: false });
      reporter.handle(testStarted('t1', 'signs in', 'web'));
      reporter.handle(finished(result({ status: 'passed' })));
      reporter.handle(runFinished({ reportPath: 'r.json' }));
      expect(chunks.join('')).not.toContain('\u001b[');
    });

    it('stays silent for output sinks without a raw channel', () => {
      const { lines, output } = capture();
      const reporter = new ListReporter(output, { live: true });
      reporter.handle(testStarted('t1', 'signs in', 'web'));
      expect(lines).toEqual([]);
    });
  });

  it('renders a full lifecycle from events alone', () => {
    const { lines, output } = capture();
    const reporter = new ListReporter(output);
    reporter.handle(runStarted({ targets: ['web'] }));
    reporter.handle({ type: 'plan', total: 1 });
    reporter.handle(testStarted('test-1', 'a test', 'web'));
    reporter.handle(finished(result({ status: 'passed', title: ['a test'] })));
    reporter.handle(runFinished({ reportPath: '/x/.e2e/report.json' }));
    const text = lines.join('\n');
    expect(text).toContain('e2e run run-1');
    expect(text).toContain('a test');
    expect(text).toContain('1 passed');
    expect(text).toContain('report: /x/.e2e/report.json');
  });

  it('renders a config failure: run-error then run-finished, no run-started', () => {
    const { lines, output } = capture();
    const reporter = new ListReporter(output);
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
    expect(text).toContain('configuration error');
    expect(text).toContain('unknown config key "nope"');
    expect(text).toContain('no tests executed');
    expect(text).toContain('report: (not written)');
  });

  it('prints "no tests executed" when nothing ran', () => {
    const { lines, output } = capture();
    new ListReporter(output).handle(runFinished({ reportPath: 'r.json' }));
    expect(lines.join('\n')).toContain('no tests executed');
  });

  it('sanitizes control characters in titles and bounds long fields', () => {
    const { lines, output } = capture();
    new ListReporter(output).handle(finished(
      result({ status: 'passed', title: ['bad\u0007title\u001b[31m'] }),
    ));
    expect(lines[0]).not.toContain('\u0007');
    const { lines: longLines, output: longOutput } = capture();
    new ListReporter(longOutput).handle(finished(
      result({ status: 'passed', title: ['x'.repeat(20_000)] }),
    ));
    expect(Buffer.byteLength(longLines[0] ?? '', 'utf8')).toBeLessThan(10_000);
  });
});

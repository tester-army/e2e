import { describe, expect, it } from 'vitest';
import { ListReporter } from '../../src/report/list.ts';
import type { ResultRecord, ResultStatus, AttemptRecord } from '../../src/run/records.ts';

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
  selected?: boolean;
  attempts?: AttemptRecord[];
  skipReason?: string;
}): ResultRecord {
  return {
    test: { titlePath: overrides.title ?? ['suite', 'case'] },
    target: { name: 'chromium' },
    status: overrides.status,
    selected: overrides.selected ?? true,
    skip:
      overrides.skipReason === undefined
        ? undefined
        : { reason: overrides.skipReason },
    attempts: overrides.attempts ?? [attempt()],
  } as unknown as ResultRecord;
}

describe('ListReporter', () => {
  it('prints the run header with targets and CI marker', () => {
    const { lines, output } = capture();
    new ListReporter(output).onRunStart({ runId: 'run-1', targets: ['chromium', 'firefox'], ci: true });
    expect(lines[0]).toContain('e2e run run-1');
    expect(lines[0]).toContain('chromium, firefox');
    expect(lines[0]).toContain('[CI]');
    expect(lines[1]).toContain('trusted code');
  });

  it('omits the CI marker outside CI', () => {
    const { lines, output } = capture();
    new ListReporter(output).onRunStart({ runId: 'run-1', targets: ['chromium'], ci: false });
    expect(lines[0]).not.toContain('[CI]');
  });

  it('renders a passed result with title path, target, and total duration', () => {
    const { lines, output } = capture();
    new ListReporter(output).onResult(
      result({ status: 'passed', title: ['auth', 'signs in'], attempts: [attempt({ durationMs: 80 })] }),
    );
    expect(lines[0]).toContain('\u2713 auth \u203a signs in');
    expect(lines[0]).toContain('[chromium] 80ms');
  });

  it('sums durations across attempts and marks flaky results', () => {
    const { lines, output } = capture();
    new ListReporter(output).onResult(
      result({
        status: 'flaky',
        attempts: [attempt({ durationMs: 100, status: 'failed' }), attempt({ durationMs: 50 })],
      }),
    );
    expect(lines[0]).toContain('(flaky)');
    expect(lines[0]).toContain('150ms');
  });

  it('renders skipped results with the skip reason', () => {
    const { lines, output } = capture();
    new ListReporter(output).onResult(result({ status: 'skipped', skipReason: 'wip feature' }));
    expect(lines[0]).toContain('- suite \u203a case');
    expect(lines[0]).toContain('skipped: wip feature');
  });

  it('suppresses deselected skipped results entirely', () => {
    const { lines, output } = capture();
    new ListReporter(output).onResult(result({ status: 'skipped', selected: false }));
    expect(lines).toEqual([]);
  });

  it('renders failures with the last attempt error message indented', () => {
    const { lines, output } = capture();
    new ListReporter(output).onResult(
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
    );
    expect(lines[0]).toContain('\u2717 suite \u203a case');
    expect(lines[0]).toContain('failed');
    expect(lines[1]).toBe('    expected visible');
    expect(lines[2]).toBe('    actual hidden');
  });

  it('counts timed-out and interrupted results as failures in the summary', () => {
    const { lines, output } = capture();
    const reporter = new ListReporter(output);
    reporter.onResult(result({ status: 'timed-out' }));
    reporter.onResult(result({ status: 'interrupted' }));
    reporter.onRunEnd({ status: 'failed', exitCode: 1, reportPath: '.e2e/report.json' });
    expect(lines.join('\n')).toContain('2 failed');
  });

  it('summarizes mixed outcomes and the report path', () => {
    const { lines, output } = capture();
    const reporter = new ListReporter(output);
    reporter.onResult(result({ status: 'passed' }));
    reporter.onResult(result({ status: 'flaky' }));
    reporter.onResult(result({ status: 'failed' }));
    reporter.onResult(result({ status: 'skipped', skipReason: 'x' }));
    reporter.onRunEnd({ status: 'failed', exitCode: 1, reportPath: '.e2e/report.json' });
    const summary = lines[lines.length - 2];
    expect(summary).toContain('1 passed');
    expect(summary).toContain('1 failed');
    expect(summary).toContain('1 flaky');
    expect(summary).toContain('1 skipped');
    expect(lines[lines.length - 1]).toContain('report: .e2e/report.json');
  });

  it('prints "no tests executed" when nothing ran', () => {
    const { lines, output } = capture();
    new ListReporter(output).onRunEnd({ status: 'passed', exitCode: 0, reportPath: 'r.json' });
    expect(lines.join('\n')).toContain('no tests executed');
  });

  it('sanitizes control characters in titles and bounds long fields', () => {
    const { lines, output } = capture();
    new ListReporter(output).onResult(
      result({ status: 'passed', title: ['bad\u0007title\u001b[31m'] }),
    );
    expect(lines[0]).not.toContain('\u0007');
    const { lines: longLines, output: longOutput } = capture();
    new ListReporter(longOutput).onResult(
      result({ status: 'passed', title: ['x'.repeat(20_000)] }),
    );
    expect(Buffer.byteLength(longLines[0] ?? '', 'utf8')).toBeLessThan(10_000);
  });
});

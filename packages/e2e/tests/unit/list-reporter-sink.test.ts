/**
 * The list reporter as an event sink: the CLI's only dispatch path. Feeds
 * synthetic event sequences through `listReporterSink` and asserts on the
 * rendered lines, including the config-error shape where `run-error` and
 * `run-finished` arrive without any `run-started`.
 */

import { describe, expect, it } from 'vitest';
import { ListReporter, listReporterSink } from '../../src/report/list.ts';
import type { RunEvent, RunEventResult } from '../../src/run/events.ts';

function capture(): { lines: string[]; sink: (event: RunEvent) => unknown } {
  const lines: string[] = [];
  const reporter = new ListReporter({ write: (line) => lines.push(line) }, { live: false });
  return { lines, sink: listReporterSink(reporter) };
}

const AT = '2026-09-02T00:00:00.000Z';

function passedResult(): RunEventResult {
  return {
    test: {
      id: 't-1',
      title: 'a test',
      titlePath: ['a test'],
      file: 'tests/a.e2e.ts',
    } as unknown as RunEventResult['test'],
    target: { name: 'web', platform: 'web' },
    status: 'passed',
    selected: true,
    attempts: [
      {
        id: 'att-1',
        index: 0,
        status: 'passed',
        startedAt: AT,
        durationMs: 12,
        steps: [],
        artifacts: [],
        secondaryErrors: [],
        cleanup: 'complete',
      },
    ],
  };
}

describe('listReporterSink', () => {
  it('renders a full lifecycle from events alone', () => {
    const { lines, sink } = capture();
    sink({ seq: 1, at: AT, type: 'run-started', runId: 'r-1', projectId: 'p', projectRoot: '/x', ci: false, targets: ['web'] });
    sink({ seq: 2, at: AT, type: 'plan', total: 1 });
    sink({ seq: 3, at: AT, type: 'test-started', testId: 't-1', title: 'a test', target: 'web' });
    sink({ seq: 4, at: AT, type: 'test-finished', result: passedResult() });
    sink({ seq: 5, at: AT, type: 'run-finished', status: 'passed', exitCode: 0, reportPath: '/x/.e2e/report.json' });
    const text = lines.join('\n');
    expect(text).toContain('e2e run r-1');
    expect(text).toContain('a test');
    expect(text).toContain('1 passed');
    expect(text).toContain('report: /x/.e2e/report.json');
  });

  it('renders a config failure: run-error then run-finished, no run-started', () => {
    const { lines, sink } = capture();
    sink({
      seq: 1,
      at: AT,
      type: 'run-error',
      error: {
        category: 'configuration',
        code: 'INVALID_CONFIG',
        message: 'unknown config key "nope"',
        retryable: false,
        phase: 'config',
      },
    });
    sink({ seq: 2, at: AT, type: 'run-finished', status: 'error', exitCode: 2 });
    const text = lines.join('\n');
    expect(text).toContain('configuration error');
    expect(text).toContain('unknown config key "nope"');
    expect(text).toContain('no tests executed');
    expect(text).toContain('report: (not written)');
  });
});

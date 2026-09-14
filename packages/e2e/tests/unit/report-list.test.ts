import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ListReporter } from '../../src/report/list.ts';
import { userFrame } from '../../src/report/code-frame.ts';
import type { RunEventFact, RunEventOf, RunEventResult } from '../../src/run/events.ts';
import type { ResultStatus, AttemptRecord, SerialGroupRecord, SerialMemberRecord } from '../../src/run/records.ts';

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
  declarationIndex?: number;
  target?: string;
  selected?: boolean;
  attempts?: AttemptRecord[];
  skipReason?: string;
  /** Marks a serial member: the group id its details live under. */
  serialGroupId?: string;
  /** The agent the test ran as; `default` unless the case is about personas. */
  agent?: string;
}): RunEventResult {
  return {
    test: {
      titlePath: overrides.title ?? ['suite', 'case'],
      id: overrides.id ?? 'test-1',
      file: overrides.file ?? 'tests/case.e2e.ts',
      declarationIndex: overrides.declarationIndex ?? 0,
    },
    target: { name: overrides.target ?? 'chromium', platform: 'web' },
    agent: overrides.agent ?? 'default',
    status: overrides.status,
    selected: overrides.selected ?? true,
    skip:
      overrides.skipReason === undefined
        ? undefined
        : { reason: overrides.skipReason },
    attempts: overrides.serialGroupId === undefined ? (overrides.attempts ?? [attempt()]) : [],
    ...(overrides.serialGroupId === undefined ? {} : { serialGroupId: overrides.serialGroupId }),
  } as unknown as RunEventResult;
}

function serialMember(testId: string, overrides: Partial<SerialMemberRecord> = {}): SerialMemberRecord {
  return {
    id: `member-${testId}`,
    index: 0,
    testId,
    status: 'passed',
    startedAt: new Date(0).toISOString(),
    durationMs: 100,
    steps: [],
    secondaryErrors: [],
    ...overrides,
  };
}

/** A finished serial group with one attempt per entry of `attempts`. */
function serialGroup(
  id: string,
  attempts: { members: SerialMemberRecord[]; error?: SerialMemberRecord['error'] }[],
  overrides: Partial<SerialGroupRecord> = {},
): RunEventFact {
  const group: SerialGroupRecord = {
    id,
    serialId: 'wizard',
    declarationIndex: 0,
    file: 'tests/case.e2e.ts',
    titlePath: ['wizard'],
    targetId: 'chromium',
    platform: 'web',
    agent: 'default',
    memberTestIds: [...new Set(attempts.flatMap((entry) => entry.members.map((member) => member.testId)))],
    status: 'passed',
    attempts: attempts.map((entry, index) => ({
      id: `group-attempt-${index}`,
      index,
      status: entry.error === undefined ? 'passed' : 'failed',
      startedAt: new Date(0).toISOString(),
      durationMs: entry.members.reduce((total, member) => total + member.durationMs, 0),
      members: entry.members,
      artifacts: [],
      ...(entry.error === undefined ? {} : { error: entry.error }),
      secondaryErrors: [],
      cleanup: 'complete',
    })),
    ...overrides,
  };
  return { type: 'serial-group', group };
}

function runStarted(
  overrides: { ci?: boolean; targets?: string[]; projectRoot?: string; model?: string } = {},
): RunEventFact {
  const projectRoot = overrides.projectRoot ?? '/project';
  return {
    type: 'run-started',
    runId: 'run-1',
    projectId: 'project',
    projectRoot,
    artifactsRoot: `${projectRoot}/.e2e/artifacts`,
    ci: overrides.ci ?? false,
    targets: overrides.targets ?? ['chromium'],
    ...(overrides.model === undefined ? {} : { model: overrides.model }),
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
    status?: 'passed' | 'failed' | 'error' | 'interrupted';
    exitCode?: 0 | 1 | 2 | 130;
    reportPath?: string;
    aiTracePath?: string;
  } = {},
): RunEventFact {
  return {
    type: 'run-finished',
    status: overrides.status ?? 'passed',
    exitCode: overrides.exitCode ?? 0,
    ...(overrides.reportPath === undefined ? {} : { reportPath: overrides.reportPath }),
    ...(overrides.aiTracePath === undefined ? {} : { aiTracePath: overrides.aiTracePath }),
  };
}

function testStarted(
  testId: string,
  title: string,
  target: string,
  file = 'tests/case.e2e.ts',
  serialId?: string,
): RunEventFact {
  return { type: 'test-started', testId, agent: 'default', title, file, serialId, target };
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

describe('reporter rows', () => {
  it('prints each row in the summary layout, then a blank line', () => {
    const lines: string[] = [];
    const reporter = plainReporter({ write: (line) => lines.push(line) });
    reporter.rows([
      { label: 'JUnit', text: '.e2e/junit.xml' },
      { label: 'Results', text: 'https://example.test/runs/1' },
    ]);
    expect(lines).toEqual([
      '      JUnit  .e2e/junit.xml',
      expect.stringMatching(/^ +Results {2}https:\/\/example\.test\/runs\/1$/),
      '',
    ]);
  });

  it('prints nothing for no rows', () => {
    const lines: string[] = [];
    plainReporter({ write: (line) => lines.push(line) }).rows([]);
    expect(lines).toEqual([]);
  });
});

/** Overrides the reported terminal size for one test; returns the restore function. */
function withTerminalSize(size: { rows?: number; columns?: number }): () => void {
  const saved = { rows: process.stdout.rows, columns: process.stdout.columns };
  const set = (key: 'rows' | 'columns', value: number | undefined) =>
    Object.defineProperty(process.stdout, key, { value, configurable: true, writable: true });
  set('rows', size.rows);
  set('columns', size.columns);
  return () => {
    set('rows', saved.rows);
    set('columns', saved.columns);
  };
}

describe('ListReporter', () => {
  it('prints a RUN banner with the version, root, run id, targets, and CI marker', () => {
    const { lines, output } = capture();
    plainReporter(output).handle(runStarted({ targets: ['chromium', 'firefox'], ci: true }));
    // The version is whatever the package carries: a stable tuple or a canary prerelease.
    expect(lines[1]).toMatch(/^ RUN {2}e2e v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)? \/project$/);
    expect(lines[2]).toContain('run run-1');
    expect(lines[2]).toContain('targets: chromium, firefox');
    expect(lines[2]).toContain('CI');
    expect(lines).toEqual(['', lines[1], lines[2], '']);
  });

  it('names the run agents under the run line when the run names any besides default', () => {
    const { lines, output } = capture();
    const reporter = plainReporter(output);
    reporter.handle({ ...(runStarted() as Extract<RunEventFact, { type: 'run-started' }>), agents: ['buyer', 'admin'] });
    expect(lines.some((line) => line.includes('agents: buyer, admin'))).toBe(true);
    const single = capture();
    plainReporter(single.output).handle({ ...(runStarted() as Extract<RunEventFact, { type: 'run-started' }>), agents: ['ux'] });
    expect(single.lines.some((line) => line.includes('agent: ux'))).toBe(true);
  });

  it('names the configured model under the run line, and stays silent without one', () => {
    const { lines, output } = capture();
    plainReporter(output).handle(runStarted({ model: 'google/gemini-3-flash' }));
    expect(lines[2]).toBe('      run run-1 · targets: chromium');
    expect(lines[3]).toBe('      model google/gemini-3-flash');
    const bare = capture();
    plainReporter(bare.output).handle(runStarted());
    expect(bare.lines.some((line) => line.includes('model'))).toBe(false);
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

    it('tags a test that ran as an agent other than default, so a persona sweep lists once per agent', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(runStarted());
      reporter.handle(plan([{ file: 'tests/checkout.e2e.ts', tests: 3 }]));
      lines.length = 0;
      reporter.handle({ type: 'test-started', testId: 't1', agent: 'default', title: 'checkout > pays', file: 'tests/checkout.e2e.ts', serialId: undefined, target: 'chromium' });
      reporter.handle({ type: 'test-started', testId: 't1', agent: 'buyer', title: 'checkout > pays', file: 'tests/checkout.e2e.ts', serialId: undefined, target: 'chromium' });
      reporter.handle({ type: 'test-started', testId: 't1', agent: 'admin', title: 'checkout > pays', file: 'tests/checkout.e2e.ts', serialId: undefined, target: 'chromium' });
      // Steps route by test id and agent, so the buyer's step stays with the buyer's line.
      reporter.handle({ type: 'step', testId: 't1', agent: 'buyer', target: 'chromium', progress: { phase: 'start', kind: 'agent', api: 'agent.act', label: 'pay' } });
      reporter.handle({ type: 'step', testId: 't1', agent: 'buyer', target: 'chromium', progress: { phase: 'end', kind: 'agent', api: 'agent.act', label: 'pay', status: 'passed', durationMs: 4_200, modelCalls: 3 } });
      for (const agent of ['default', 'buyer', 'admin']) {
        reporter.handle(finished(result({ status: 'passed', id: 't1', agent, file: 'tests/checkout.e2e.ts', title: ['checkout', 'pays'], attempts: [attempt({ durationMs: 80 })] })));
      }
      expect(lines).toEqual([
        '   ✓ checkout > pays [buyer] > agent.act "pay" 4.20s · 3 model calls',
        ' ✓ |chromium| tests/checkout.e2e.ts (3 tests) 240ms',
        '   ✓ checkout > pays 80ms',
        '   ✓ checkout > pays [buyer] 80ms',
        '   ✓ checkout > pays [admin] 80ms',
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
      // First target bright yellow, second bright cyan, in declaration order.
      expect(blocks[1]).toContain('\u001b[103m');
      expect(blocks[0]).toContain('\u001b[106m');
    });
    it('omits the duration of a file whose tests never ran', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(plan([{ file: 'tests/a.e2e.ts', tests: 1 }, { file: 'tests/b.e2e.ts', tests: 1 }]));
      reporter.handle(finished(result({ status: 'skipped', file: 'tests/a.e2e.ts', skipReason: 'wip', attempts: [] })));
      expect(lines[0]).toBe(' ↓ |chromium| tests/a.e2e.ts (1 test | 1 skipped)');
    });

    it('clips the first error line to the terminal width; the failure section keeps it whole', () => {
      const restore = withTerminalSize({ columns: 40 });
      try {
        const { lines, output } = capture();
        const reporter = plainReporter(output);
        reporter.handle(plan([{ file: 'tests/a.e2e.ts', tests: 1 }]));
        reporter.handle(finished(result({
          status: 'failed',
          file: 'tests/a.e2e.ts',
          title: ['long'],
          attempts: [failedAttempt('e'.repeat(200))],
        })));
        const glance = lines.find((line) => line.includes('→'))!;
        expect(glance.length).toBeLessThanOrEqual(40);
        expect(glance.endsWith('…')).toBe(true);
        reporter.handle(runFinished({ status: 'failed', exitCode: 1 }));
        expect(lines).toContain(`ASSERTION_FAILED: ${'e'.repeat(200)}`);
      } finally {
        restore();
      }
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

    it('names the recording a failed attempt kept, relative to the project', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(runStarted());
      reporter.handle(plan([{ file: 'tests/a.e2e.ts', tests: 1 }]));
      const failed = failedAttempt('boom');
      failed.artifacts = [
        {
          id: 'attempt-1:artifact:0',
          kind: 'video',
          mediaType: 'video/webm',
          path: 'chromium/a/attempt-0/video/video.webm',
          startedAt: new Date(0).toISOString(),
          redaction: 'incomplete',
          producer: { kind: 'attempt' },
        },
        {
          id: 'attempt-1:artifact:1',
          kind: 'trace',
          mediaType: 'application/zip',
          path: 'chromium/a/attempt-0/trace/trace.zip',
          redaction: 'complete',
          producer: { kind: 'attempt' },
        },
      ];
      reporter.handle(finished(result({ status: 'failed', id: 'a', file: 'tests/a.e2e.ts', title: ['first'], attempts: [failed] })));
      reporter.handle(runFinished({ status: 'failed', exitCode: 1, reportPath: '/project/.e2e/report.json' }));
      expect(lines).toContain(' ❯ video .e2e/artifacts/chromium/a/attempt-0/video/video.webm');
      expect(lines.some((line) => line.includes('trace.zip'))).toBe(false);
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
        aiTracePath: '/project/.e2e/ai-trace.json',
      }));
      expect(lines).toContain(' Test Files  1 failed | 0 passed | 1 skipped (2)');
      expect(lines).toContain('      Tests  1 failed | 1 passed | 1 flaky | 1 skipped (4)');
      expect(lines.some((line) => /^ {3}Start at {2}\d\d:\d\d:\d\d$/.test(line))).toBe(true);
      expect(lines.some((line) => /^ {3}Duration {2}\d+(\.\d+)?m?s$/.test(line))).toBe(true);
      expect(lines).toContain('     Report  .e2e/report.json');
      expect(lines).toContain('   AI trace  .e2e/ai-trace.json (open with: npx unbox-ai .e2e/ai-trace.json)');
      expect(lines.at(-1)).toBe('');
    });

    it('starts the clock at plan, so a download narrated before it is not on it', () => {
      vi.useFakeTimers({ now: new Date('2026-09-08T10:00:00.000Z') });
      try {
        const { lines, output } = capture();
        const reporter = plainReporter(output);
        reporter.handle(runStarted());
        reporter.handle({
          type: 'notice',
          target: 'web',
          message: 'Downloading missing Playwright browsers (first run): chromium...',
        });
        vi.advanceTimersByTime(15_000);
        const executionStart = new Date();
        reporter.handle(plan([{ file: 'tests/a.e2e.ts', tests: 1 }]));
        vi.advanceTimersByTime(2_000);
        reporter.handle(finished(result({ status: 'passed', file: 'tests/a.e2e.ts' })));
        reporter.handle(runFinished({ reportPath: 'r.json' }));
        expect(lines).toContain(`   Start at  ${executionStart.toTimeString().split(' ')[0]}`);
        expect(lines).toContain('   Duration  2.00s');
      } finally {
        vi.useRealTimers();
      }
    });

    it('counts a run that never reached plan from its launch', () => {
      vi.useFakeTimers({ now: new Date('2026-09-08T10:00:00.000Z') });
      try {
        const { lines, output } = capture();
        const reporter = plainReporter(output);
        const launch = new Date();
        reporter.handle(runStarted());
        vi.advanceTimersByTime(1_500);
        reporter.handle({
          type: 'run-error',
          error: {
            category: 'configuration',
            code: 'NO_TESTS',
            message: 'no test file matched tests/**/*.e2e.ts',
            retryable: false,
            phase: 'collection',
          },
        });
        reporter.handle(runFinished({ status: 'error', exitCode: 2, reportPath: 'r.json' }));
        expect(lines).toContain(`   Start at  ${launch.toTimeString().split(' ')[0]}`);
        expect(lines).toContain('   Duration  1.50s');
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports model usage per file and for the run, naming the configured model', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(runStarted({ model: 'openai/gpt-5.6-luna-fast' }));
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
      expect(lines).toContain(' ✓ |chromium| tests/a.e2e.ts (1 test) 120ms ai 12.4k tokens · $0.0123');
      expect(lines).toContain('   ✓ suite > case 120ms ai 12.4k tokens · $0.0123');
      expect(lines).toContain('         AI  12.4k tokens · $0.0123 · 3 model calls · openai/gpt-5.6-luna-fast');
    });

    it('leaves the model off the AI row when none is configured', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(runStarted());
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
      expect(lines).toContain('         AI  12.4k tokens · $0.0123 · 3 model calls');
    });

    it('tallies the trace cache under the AI row by step, leaving zero counts out', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(runStarted({ model: 'openai/gpt-5.6-luna-fast' }));
      reporter.handle(plan([{ file: 'tests/a.e2e.ts', tests: 1 }]));
      const step = (id: string, cache: object | undefined, calls: number) =>
        ({
          id,
          index: 0,
          kind: 'agent',
          api: 'agent.act',
          label: 'do it',
          status: 'passed',
          startedAt: new Date(0).toISOString(),
          durationMs: 10,
          events: [],
          artifacts: [],
          ...(cache === undefined ? {} : { cache }),
          model: { calls, inputTokens: 1_000, outputTokens: 100 },
        }) as unknown as AttemptRecord['steps'][number];
      const steps = [
        step('replayed-1', { mode: 'self-finalized', replayedActions: 3, totalActions: 3 }, 0),
        step('replayed-2', { mode: 'self-finalized', replayedActions: 2, totalActions: 2 }, 0),
        step('handed-off', { mode: 'agent-concluded', reason: 'end-mismatch', replayedActions: 1, totalActions: 3 }, 2),
        step('uncached', undefined, 3),
      ];
      reporter.handle(finished(result({ status: 'passed', file: 'tests/a.e2e.ts', attempts: [attempt({ steps })] })));
      reporter.handle(runFinished({ reportPath: 'r.json' }));
      const ai = lines.findIndex((line) => line.trimStart().startsWith('AI'));
      expect(lines[ai + 1]).toBe('      Cache  2 replayed · 1 handed off');
    });

    it('shows a cold cache as misses and no Cache row at all when the cache is off', () => {
      const run = (cache: object | undefined) => {
        const { lines, output } = capture();
        const reporter = plainReporter(output);
        reporter.handle(runStarted());
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
          ...(cache === undefined ? {} : { cache }),
          model: { calls: 3, inputTokens: 1_000, outputTokens: 100 },
        } as unknown as AttemptRecord['steps'][number];
        reporter.handle(finished(result({ status: 'passed', file: 'tests/a.e2e.ts', attempts: [attempt({ steps: [step] })] })));
        reporter.handle(runFinished({ reportPath: 'r.json' }));
        return lines;
      };
      expect(run({ mode: 'missed', reason: 'no-entry', replayedActions: 0, totalActions: 0 })).toContain('      Cache  1 missed');
      expect(run(undefined).some((line) => line.trimStart().startsWith('Cache'))).toBe(false);
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

    it('names the interrupt when the run was cut before discovery', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(runStarted());
      reporter.handle({ type: 'run-interrupted', mode: 'graceful' });
      reporter.handle(runFinished({ status: 'interrupted', exitCode: 130, reportPath: 'r.json' }));
      expect(lines).toContain(' Test Files  none started (interrupted)');
      expect(lines).toContain('      Tests  none executed (interrupted)');
      expect(lines.join('\n')).not.toContain('no test files');
    });

    it('names the interrupt from run-finished alone when the host aborted without the event', () => {
      const { lines, output } = capture();
      plainReporter(output).handle(runFinished({ status: 'interrupted', exitCode: 130 }));
      expect(lines).toContain(' Test Files  none started (interrupted)');
      expect(lines).toContain('      Tests  none executed (interrupted)');
    });

    it('keeps the counters of a run interrupted after its plan arrived', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(plan([{ file: 'tests/a.e2e.ts', tests: 3 }]));
      reporter.handle(finished(result({ status: 'passed', id: 'a', file: 'tests/a.e2e.ts', title: ['first'] })));
      reporter.handle({ type: 'run-interrupted', mode: 'graceful' });
      reporter.handle(runFinished({ status: 'interrupted', exitCode: 130 }));
      expect(lines).toContain('      Tests  1 passed (3)');
      expect(lines.join('\n')).not.toContain('(interrupted)');
    });
  });

  describe('setup steps', () => {
    it('prints each process once it is ready and splits startup out of the duration', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(runStarted());
      reporter.handle({ type: 'setup', step: { kind: 'service', label: 'service "compose"' }, state: 'started' });
      reporter.handle({ type: 'setup', step: { kind: 'service', label: 'service "compose"' }, state: 'finished', durationMs: 41_200 });
      reporter.handle({ type: 'setup', step: { kind: 'app', label: 'target "chromium" command' }, state: 'started' });
      reporter.handle({ type: 'setup', step: { kind: 'app', label: 'target "chromium" command' }, state: 'finished', durationMs: 1_800, outcome: 'reused' });
      reporter.handle(runFinished({ reportPath: 'r.json' }));
      expect(lines).toContain(' ✓ service "compose" ready 41.20s');
      expect(lines).toContain(' ✓ target "chromium" command reused 1.80s');
      expect(lines.find((line) => line.includes('Duration'))).toMatch(/^   Duration  \S+ \(startup 43\.00s\)$/);
    });

    it('leaves the duration alone when the run started no process', () => {
      const { lines, output } = capture();
      plainReporter(output).handle(runFinished({ reportPath: 'r.json' }));
      expect(lines.find((line) => line.includes('Duration'))).not.toContain('startup');
    });

    it('prints a provisioning step only when it narrated, and never the collection', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(runStarted());
      reporter.handle({ type: 'setup', step: { kind: 'collect' }, state: 'started' });
      reporter.handle({ type: 'setup', step: { kind: 'collect' }, state: 'finished', durationMs: 310 });
      const prepare = { kind: 'prepare', target: 'web', engine: 'playwright' } as const;
      reporter.handle({ type: 'setup', step: prepare, state: 'started' });
      reporter.handle({ type: 'setup', step: prepare, state: 'finished', durationMs: 2 });
      reporter.handle({ type: 'setup', step: prepare, state: 'started' });
      reporter.handle({ type: 'notice', target: 'web', message: 'Downloading missing Playwright browsers (first run): chromium...' });
      reporter.handle({ type: 'setup', step: prepare, state: 'finished', durationMs: 13_200 });
      reporter.handle(runFinished({ reportPath: 'r.json' }));
      expect(lines.filter((line) => line.includes('collected'))).toEqual([]);
      expect(lines.filter((line) => line.includes('prepared'))).toEqual([
        ' ✓ playwright engine for target "web" prepared 13.20s',
      ]);
      // Provisioning is off the clock: no startup split for it.
      expect(lines.find((line) => line.includes('Duration'))).not.toContain('startup');
    });

    it('names the setup step an interrupt cut short', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(runStarted());
      reporter.handle({ type: 'setup', step: { kind: 'service', label: 'service "postgres"' }, state: 'started' });
      reporter.handle({ type: 'run-interrupted', mode: 'graceful' });
      reporter.handle(runFinished({ status: 'interrupted', exitCode: 130, reportPath: 'r.json' }));
      expect(lines).toContain('interrupted while starting service "postgres": tearing down (interrupt again to force)');
      // No test was running, so the summary keeps the interrupt wording for empty counters.
      expect(lines).toContain(' Test Files  none started (interrupted)');
    });
  });

  describe('serial groups', () => {
    const memberError = {
      category: 'test' as const,
      code: 'ASSERTION_FAILED',
      message: 'plan step failed',
      retryable: false,
    };

    it('reads each member\u2019s duration, usage, and error from the group, which arrives first', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(plan([{ file: 'tests/case.e2e.ts', tests: 2 }]));
      const step = { model: { calls: 1, inputTokens: 600, outputTokens: 400 } } as never;
      reporter.handle(serialGroup('g1', [
        { members: [serialMember('m1', { durationMs: 300, steps: [step] }), serialMember('m2', { status: 'failed', durationMs: 200, error: memberError })], error: memberError },
        { members: [serialMember('m1', { durationMs: 100 }), serialMember('m2', { status: 'failed', durationMs: 50, error: memberError })], error: memberError },
      ], { status: 'failed' }));
      expect(lines).toEqual([]);
      reporter.handle(finished(result({ status: 'passed', id: 'm1', title: ['wizard', 'step 1'], serialGroupId: 'g1' })));
      expect(lines).toEqual([]);
      reporter.handle(finished(result({ status: 'failed', id: 'm2', title: ['wizard', 'step 2'], declarationIndex: 1, serialGroupId: 'g1' })));
      expect(lines).toEqual([
        ' ❯ |chromium| tests/case.e2e.ts (2 tests | 1 failed) 650ms ai 1.0k tokens',
        '   ✓ wizard > step 1 400ms ai 1.0k tokens',
        '   × wizard > step 2 250ms',
        '     → plan step failed',
      ]);
      reporter.handle(runFinished({ status: 'failed', exitCode: 1 }));
      expect(lines).toContain('ASSERTION_FAILED: plan step failed');
      // Usage is counted once, through the member lines, not again from the group.
      expect(lines.find((line) => line.trimStart().startsWith('AI'))).toContain('1.0k tokens · 1 model calls');
    });

    it('falls back to the attempt error for a member the group never reached', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(plan([{ file: 'tests/case.e2e.ts', tests: 1 }]));
      const launchError = { ...memberError, category: 'infrastructure' as const, code: 'LAUNCH_FAILED', message: 'no browser' };
      reporter.handle(serialGroup('g2', [{ members: [serialMember('m1', { status: 'skipped', durationMs: 0 })], error: launchError }], { status: 'failed' }));
      reporter.handle(finished(result({ status: 'failed', id: 'm1', title: ['wizard', 'step 1'], serialGroupId: 'g2' })));
      expect(lines).toContain('     → no browser');
    });

    it('names the group recording under a failed member, since members carry no attempts', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(runStarted());
      reporter.handle(plan([{ file: 'tests/case.e2e.ts', tests: 2 }]));
      const group = serialGroup(
        'g3',
        [{ members: [serialMember('m1'), serialMember('m2', { status: 'failed', error: memberError })], error: memberError }],
        { status: 'failed' },
      );
      if (group.type !== 'serial-group') throw new Error('serial group event expected');
      group.group.attempts[0]!.artifacts.push({
        id: 'group-attempt-0:artifact:0',
        kind: 'video',
        mediaType: 'video/webm',
        path: 'chromium/wizard/attempt-0/video/video.webm',
        startedAt: new Date(0).toISOString(),
        redaction: 'incomplete',
        producer: { kind: 'attempt' },
      });
      reporter.handle(group);
      reporter.handle(finished(result({ status: 'passed', id: 'm1', title: ['wizard', 'step 1'], serialGroupId: 'g3' })));
      reporter.handle(finished(result({ status: 'failed', id: 'm2', title: ['wizard', 'step 2'], declarationIndex: 1, serialGroupId: 'g3' })));
      reporter.handle(runFinished({ status: 'failed', exitCode: 1 }));
      expect(lines).toContain(' ❯ video .e2e/artifacts/chromium/wizard/attempt-0/video/video.webm');
    });

    it('tolerates a group that arrives after its members, printing what it has', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(plan([{ file: 'tests/case.e2e.ts', tests: 1 }]));
      reporter.handle(finished(result({ status: 'passed', id: 'm1', title: ['wizard', 'step 1'], serialGroupId: 'late' })));
      reporter.handle(serialGroup('late', [{ members: [serialMember('m1')] }]));
      reporter.handle(runFinished({ reportPath: 'r.json' }));
      expect(lines[0]).toBe(' ✓ |chromium| tests/case.e2e.ts (1 test)');
      expect(lines.join('\n')).toContain('Tests  1 passed (1)');
    });

    it('keeps a serial member\u2019s steps from earlier group attempts when it starts again', () => {
      const lines: string[] = [];
      const output = { write: (line: string) => lines.push(line.replace(ANSI_PATTERN, '')), raw: () => {} };
      const reporter = plainReporter(output, true);
      reporter.handle(plan([{ file: 'tests/case.e2e.ts', tests: 1 }]));
      const end = (status: 'passed' | 'failed') =>
        reporter.handle({
          type: 'step',
          testId: 'm1',
          agent: 'default',
          target: 'chromium',
          progress: { phase: 'end', kind: 'agent', api: 'agent.act', label: 'fill the form', status, durationMs: 4_200, modelCalls: 3 },
        });
      reporter.handle(testStarted('m1', 'step 1', 'chromium', 'tests/case.e2e.ts', 'wizard'));
      end('failed');
      reporter.handle(testStarted('m1', 'step 1', 'chromium', 'tests/case.e2e.ts', 'wizard'));
      end('passed');
      reporter.handle(serialGroup('g1', [
        { members: [serialMember('m1', { status: 'failed', durationMs: 200 })], error: { code: 'E', category: 'test', message: 'boom' } as never },
        { members: [serialMember('m1', { durationMs: 100 })] },
      ]));
      reporter.handle(finished(result({ status: 'flaky', id: 'm1', title: ['wizard', 'step 1'], serialGroupId: 'g1' })));
      expect(lines).toEqual([
        ' ✓ |chromium| tests/case.e2e.ts (1 test | 1 flaky) 300ms',
        '   ✓ wizard > step 1 (flaky) 300ms',
        '     × agent.act "fill the form" 4.20s · 3 model calls failed',
        '     ✓ agent.act "fill the form" 4.20s · 3 model calls',
      ]);
    });

    it('shows one serial member at a time in the live window and follows each member\u2019s steps', () => {
      const chunks: string[] = [];
      const output = { write: (line: string) => chunks.push(`${line}\n`), raw: (text: string) => chunks.push(text) };
      const reporter = plainReporter(output, true);
      reporter.handle(runStarted());
      reporter.handle(plan([{ file: 'tests/case.e2e.ts', tests: 2 }]));
      reporter.handle(testStarted('m1', 'step 1', 'chromium', 'tests/case.e2e.ts', 'wizard'));
      reporter.handle({ type: 'step', testId: 'm1', agent: 'default', target: 'chromium', progress: { phase: 'start', kind: 'locator', api: 'app.open', label: '/wizard' } });
      expect(chunks.at(-1)).toContain('step 1');
      reporter.handle(testStarted('m2', 'step 2', 'chromium', 'tests/case.e2e.ts', 'wizard'));
      reporter.handle({ type: 'step', testId: 'm2', agent: 'default', target: 'chromium', progress: { phase: 'start', kind: 'locator', api: 'locator.fill', label: 'Plan' } });
      const window = chunks.at(-1)!;
      expect(window).toContain('step 2');
      expect(window).toContain('locator.fill "Plan"');
      expect(window).not.toContain('step 1');
      expect(window).not.toContain('app.open');
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

    it('without a live window, prints finished agent steps at once with their test, then the block', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(plan([{ file: 'tests/flow.e2e.ts', tests: 1 }]));
      reporter.handle(testStarted('t1', 'checkout', 'chromium', 'tests/flow.e2e.ts'));
      reporter.handle({ type: 'step', testId: 't1', agent: 'default', target: 'chromium', progress: agentStep('start', 'add to cart') });
      reporter.handle({ type: 'step', testId: 't1', agent: 'default', target: 'chromium', progress: agentStep('end', 'add to cart') });
      reporter.handle({ type: 'step', testId: 't1', agent: 'default', target: 'chromium', progress: agentStep('start', 'pay') });
      reporter.handle({ type: 'step', testId: 't1', agent: 'default', target: 'chromium', progress: agentStep('end', 'pay', 'failed') });
      reporter.handle(finished(result({
        status: 'failed',
        id: 't1',
        file: 'tests/flow.e2e.ts',
        title: ['checkout'],
        attempts: [failedAttempt('pay step failed')],
      })));
      expect(lines).toEqual([
        '   ✓ checkout > agent.act "add to cart" 4.20s · 3 model calls',
        '   × checkout > agent.act "pay" 4.20s · 3 model calls failed',
        ' ❯ |chromium| tests/flow.e2e.ts (1 test | 1 failed) 120ms',
        '   × checkout 120ms',
        '     → pay step failed',
      ]);
    });

    it('with a live window, holds finished agent steps and nests them under their test in the block', () => {
      const lines: string[] = [];
      const output = { write: (line: string) => lines.push(line.replace(ANSI_PATTERN, '')), raw: () => {} };
      const reporter = plainReporter(output, true);
      reporter.handle(plan([{ file: 'tests/flow.e2e.ts', tests: 2 }]));
      reporter.handle(testStarted('t1', 'checkout', 'chromium', 'tests/flow.e2e.ts'));
      reporter.handle({ type: 'step', testId: 't1', agent: 'default', target: 'chromium', progress: agentStep('start', 'add to cart') });
      reporter.handle({ type: 'step', testId: 't1', agent: 'default', target: 'chromium', progress: agentStep('end', 'add to cart') });
      reporter.handle({ type: 'step', testId: 't1', agent: 'default', target: 'chromium', progress: agentStep('start', 'pay') });
      reporter.handle({ type: 'step', testId: 't1', agent: 'default', target: 'chromium', progress: agentStep('end', 'pay', 'failed') });
      expect(lines).toEqual([]);
      reporter.handle(finished(result({
        status: 'failed',
        id: 't1',
        file: 'tests/flow.e2e.ts',
        title: ['checkout'],
        declarationIndex: 0,
        attempts: [failedAttempt('pay step failed')],
      })));
      reporter.handle(testStarted('t2', 'refund', 'chromium', 'tests/flow.e2e.ts'));
      reporter.handle({ type: 'step', testId: 't2', agent: 'default', target: 'chromium', progress: agentStep('start', 'refund order') });
      reporter.handle({ type: 'step', testId: 't2', agent: 'default', target: 'chromium', progress: agentStep('end', 'refund order') });
      reporter.handle(finished(result({ status: 'passed', id: 't2', file: 'tests/flow.e2e.ts', title: ['refund'], declarationIndex: 1 })));
      expect(lines).toEqual([
        ' ❯ |chromium| tests/flow.e2e.ts (2 tests | 1 failed) 240ms',
        '   × checkout 120ms',
        '     → pay step failed',
        '     ✓ agent.act "add to cart" 4.20s · 3 model calls',
        '     × agent.act "pay" 4.20s · 3 model calls failed',
        '   ✓ refund 120ms',
        '     ✓ agent.act "refund order" 4.20s · 3 model calls',
      ]);
    });

    it('prefixes finished agent steps with their test when tests run in parallel', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(plan([{ file: 'tests/flow.e2e.ts', tests: 2 }]));
      reporter.handle(testStarted('t1', 'checkout', 'chromium', 'tests/flow.e2e.ts'));
      reporter.handle(testStarted('t2', 'refund', 'chromium', 'tests/flow.e2e.ts'));
      reporter.handle({ type: 'step', testId: 't1', agent: 'default', target: 'chromium', progress: agentStep('start', 'add to cart') });
      reporter.handle({ type: 'step', testId: 't1', agent: 'default', target: 'chromium', progress: agentStep('end', 'add to cart') });
      expect(lines).toEqual(['   ✓ checkout > agent.act "add to cart" 4.20s · 3 model calls']);
    });

    it('prints the whole label without a live window, whatever the terminal width', () => {
      const restore = withTerminalSize({ columns: 80 });
      try {
        const { lines, output } = capture();
        const reporter = plainReporter(output);
        reporter.handle(plan([{ file: 'tests/flow.e2e.ts', tests: 1 }]));
        reporter.handle(testStarted('t1', 'checkout', 'chromium', 'tests/flow.e2e.ts'));
        const label = 'add two todos named "Buy milk" and "Walk the dog", then mark the first';
        reporter.handle({ type: 'step', testId: 't1', agent: 'default', target: 'chromium', progress: agentStep('start', label) });
        reporter.handle({ type: 'step', testId: 't1', agent: 'default', target: 'chromium', progress: agentStep('end', label) });
        expect(lines.at(-1)).toBe(`   ✓ checkout > agent.act "${label}" 4.20s · 3 model calls`);
      } finally {
        restore();
      }
    });

    it('keeps deterministic steps out of the permanent log', () => {
      const { lines, output } = capture();
      const reporter = plainReporter(output);
      reporter.handle(testStarted('t1', 'checkout', 'chromium'));
      reporter.handle({
        type: 'step',
        testId: 't1',
        agent: 'default',
        target: 'chromium',
        progress: { phase: 'start', kind: 'locator', api: 'locator.tap', label: 'button' },
      });
      reporter.handle({
        type: 'step',
        testId: 't1',
        agent: 'default',
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
        agent: 'default',
        target: 'chromium',
        progress: { phase: 'start', kind: 'agent', api: 'agent.act', label: 'add a todo' },
      });
      reporter.handle({
        type: 'step',
        testId: 't1',
        agent: 'default',
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
      expect(window).toContain('• Thinking (1.20s) (1.1k tokens)');
      expect(window).toMatch(/[·✢✳✶✻✽] Thinking\n/);
      expect(window).toContain('└── b');
    });

    it('appends a model turn\'s collapsed reasoning to its Thinking line', () => {
      const restore = withTerminalSize({ columns: 120, rows: 40 });
      try {
        const { chunks, output } = liveCapture();
        const reporter = plainReporter(output, true);
        reporter.handle(runStarted());
        reporter.handle(testStarted('t1', 'a', 'chromium'));
        reporter.handle({
          type: 'step',
          testId: 't1',
          agent: 'default',
          target: 'chromium',
          progress: { phase: 'start', kind: 'agent', api: 'agent.act', label: 'pay' },
        });
        reporter.handle({
          type: 'step',
          testId: 't1',
          agent: 'default',
          target: 'chromium',
          progress: {
            phase: 'event',
            api: 'agent.act',
            event: {
              kind: 'model',
              startedAt: new Date(0).toISOString(),
              durationMs: 1_200,
              status: 'passed',
              inputTokens: 100,
              outputTokens: 20,
              reasoning: 'The modal blocks checkout.\nClosing it first, then paying.',
            },
          },
        });
        const window = chunks.at(-1)!.replace(ANSI_PATTERN, '');
        expect(window).toContain('• Thinking (1.20s) (↑100 ↓20) · The modal blocks checkout. Closing it first, then paying.');
      } finally {
        restore();
      }
    });

    it('clips the reasoning excerpt at the terminal width', () => {
      const restore = withTerminalSize({ columns: 80, rows: 40 });
      try {
        const { chunks, output } = liveCapture();
        const reporter = plainReporter(output, true);
        reporter.handle(runStarted());
        reporter.handle(testStarted('t1', 'a', 'chromium'));
        const step = (progress: object) => reporter.handle({ type: 'step', testId: 't1', agent: 'default', target: 'chromium', progress } as never);
        step({ phase: 'start', kind: 'agent', api: 'agent.act', label: 'pay' });
        step({
          phase: 'event',
          api: 'agent.act',
          event: {
            kind: 'model',
            startedAt: new Date(0).toISOString(),
            durationMs: 1_200,
            status: 'passed',
            inputTokens: 100,
            outputTokens: 20,
            reasoning: 'The modal blocks checkout, so I will close it before trying to pay for the cart.',
          },
        });
        const row = chunks.at(-1)!.replace(ANSI_PATTERN, '').split('\n').find((line) => line.includes('• Thinking'))!;
        expect([...row].length).toBeLessThanOrEqual(78);
        expect(row).toMatch(/…$/);
      } finally {
        restore();
      }
    });

    it('drops the reasoning excerpt when the terminal leaves it no room', () => {
      const restore = withTerminalSize({ columns: 40, rows: 40 });
      try {
        const { chunks, output } = liveCapture();
        const reporter = plainReporter(output, true);
        reporter.handle(runStarted());
        reporter.handle(testStarted('t1', 'a', 'chromium'));
        const step = (progress: object) => reporter.handle({ type: 'step', testId: 't1', agent: 'default', target: 'chromium', progress } as never);
        step({ phase: 'start', kind: 'agent', api: 'agent.act', label: 'pay' });
        step({
          phase: 'event',
          api: 'agent.act',
          event: {
            kind: 'model',
            startedAt: new Date(0).toISOString(),
            durationMs: 1_200,
            status: 'passed',
            inputTokens: 100,
            outputTokens: 20,
            reasoning: 'The modal blocks checkout.',
          },
        });
        const row = chunks.at(-1)!.replace(ANSI_PATTERN, '').split('\n').find((line) => line.includes('• Thinking'))!;
        expect(row).toContain('• Thinking (1.20s) (↑100 ↓20)');
        expect(row).not.toContain('modal');
      } finally {
        restore();
      }
    });

    it('lists a passing file\u2019s tests and steps when it ran agent steps, and keeps other files to one line', () => {
      const lines: string[] = [];
      const output = { write: (line: string) => lines.push(line.replace(ANSI_PATTERN, '')), raw: () => {} };
      const reporter = plainReporter(output, true);
      reporter.handle(plan([{ file: 'tests/flow.e2e.ts', tests: 1 }, { file: 'tests/plain.e2e.ts', tests: 1 }]));
      reporter.handle(testStarted('t1', 'checkout', 'chromium', 'tests/flow.e2e.ts'));
      reporter.handle({
        type: 'step',
        testId: 't1',
        agent: 'default',
        target: 'chromium',
        progress: { phase: 'end', kind: 'agent', api: 'agent.act', label: 'pay', status: 'passed', durationMs: 4_200, modelCalls: 3 },
      });
      reporter.handle(finished(result({ status: 'passed', id: 't1', file: 'tests/flow.e2e.ts', title: ['checkout'] })));
      reporter.handle(testStarted('t2', 'renders', 'chromium', 'tests/plain.e2e.ts'));
      reporter.handle(finished(result({ status: 'passed', id: 't2', file: 'tests/plain.e2e.ts', title: ['renders'] })));
      expect(lines).toEqual([
        ' ✓ |chromium| tests/flow.e2e.ts (1 test) 120ms',
        '   ✓ checkout 120ms',
        '     ✓ agent.act "pay" 4.20s · 3 model calls',
        ' ✓ |chromium| tests/plain.e2e.ts (1 test) 120ms',
      ]);
    });

    it('clips a finished step label so the row keeps its tail at the terminal width', () => {
      const restore = withTerminalSize({ columns: 80, rows: 40 });
      try {
        const { chunks, output } = liveCapture();
        const reporter = plainReporter(output, true);
        reporter.handle(runStarted());
        reporter.handle(plan([{ file: 'tests/flow.e2e.ts', tests: 1 }]));
        reporter.handle(testStarted('t1', 'checkout', 'chromium', 'tests/flow.e2e.ts'));
        const label = 'add two todos named "Buy milk" and "Walk the dog", then mark the first one as done';
        const step = (progress: object) => reporter.handle({ type: 'step', testId: 't1', agent: 'default', target: 'chromium', progress } as never);
        step({ phase: 'start', kind: 'agent', api: 'agent.act', label });
        step({ phase: 'end', kind: 'agent', api: 'agent.act', label, status: 'passed', durationMs: 4_200, modelCalls: 3 });
        const row = chunks.at(-1)!.replace(ANSI_PATTERN, '').split('\n').find((line) => line.includes('agent.act'))!;
        expect([...row].length).toBeLessThanOrEqual(78);
        expect(row).toMatch(/^ {7}✓ agent\.act "add two todos .*…" 4\.20s · 3 model calls$/);
      } finally {
        restore();
      }
    });

    it('shows finished steps under the running test, then the current step with its calls and wait', () => {
      const { chunks, output } = liveCapture();
      const reporter = plainReporter(output, true);
      reporter.handle(runStarted());
      reporter.handle(plan([{ file: 'tests/flow.e2e.ts', tests: 1 }]));
      reporter.handle(testStarted('t1', 'checkout', 'chromium', 'tests/flow.e2e.ts'));
      const step = (progress: object) => reporter.handle({ type: 'step', testId: 't1', agent: 'default', target: 'chromium', progress } as never);
      step({ phase: 'start', kind: 'agent', api: 'agent.act', label: 'add to cart' });
      step({ phase: 'end', kind: 'agent', api: 'agent.act', label: 'add to cart', status: 'passed', durationMs: 4_200, modelCalls: 3 });
      step({ phase: 'start', kind: 'agent', api: 'agent.act', label: 'pay' });
      step({ phase: 'event', api: 'agent.act', event: { kind: 'engine', name: 'tool:tap', detail: 'tap button "Pay"', durationMs: 27, status: 'passed' } });
      const window = chunks.at(-1)!.replace(ANSI_PATTERN, '');
      expect(window).toMatch(
        /\n ❯ \|chromium\| tests\/flow\.e2e\.ts 0\/1\n   └── checkout \d+m?s\n {7}✓ agent\.act "add to cart" 4\.20s · 3 model calls\n {7}↳ agent\.act "pay"\n {9}› tap button "Pay" \(27ms\)\n {9}[·✢✳✶✻✽] Thinking\n/,
      );
      step({ phase: 'event', api: 'agent.act', event: { kind: 'model', durationMs: 9_000, count: 133, inputTokens: 6, outputTokens: 127 } });
      // Stream order: the executor reports the turn once its tools ran.
      expect(chunks.at(-1)!.replace(ANSI_PATTERN, '')).toMatch(
        /› tap button "Pay" \(27ms\)\n {9}• Thinking \(9\.00s\) \(↑6 ↓127\)\n {9}[·✢✳✶✻✽] Thinking\n/,
      );
    });

    it('shows the trace cache replaying instead of a model turn, and the model again once it hands off', () => {
      const { chunks, output } = liveCapture();
      const reporter = plainReporter(output, true);
      reporter.handle(runStarted());
      reporter.handle(testStarted('t1', 'checkout', 'chromium'));
      const step = (progress: object) => reporter.handle({ type: 'step', testId: 't1', agent: 'default', target: 'chromium', progress } as never);
      step({ phase: 'start', kind: 'agent', api: 'agent.act', label: 'pay' });
      step({ phase: 'replay', api: 'agent.act', active: true });
      step({ phase: 'event', api: 'agent.act', event: { kind: 'engine', name: 'tap', detail: 'tap button "Pay"', durationMs: 27, status: 'passed' } });
      const replaying = chunks.at(-1)!.replace(ANSI_PATTERN, '');
      expect(replaying).toMatch(/↳ agent\.act "pay"\n {9}› tap button "Pay" \(27ms\)\n {9}[·✢✳✶✻✽] Replaying\n/);
      expect(replaying).not.toContain('Thinking');
      step({ phase: 'replay', api: 'agent.act', active: false });
      const handedOff = chunks.at(-1)!.replace(ANSI_PATTERN, '');
      expect(handedOff).toMatch(/› tap button "Pay" \(27ms\)\n {9}[·✢✳✶✻✽] Thinking\n/);
      expect(handedOff).not.toContain('Replaying');
    });

    it('shows no wait row for a deterministic step and keeps the one clock on the test row', () => {
      const { chunks, output } = liveCapture();
      const reporter = plainReporter(output, true);
      reporter.handle(runStarted());
      reporter.handle(testStarted('t1', 'checkout', 'chromium'));
      reporter.handle({
        type: 'step',
        testId: 't1',
        agent: 'default',
        target: 'chromium',
        progress: { phase: 'start', kind: 'locator', api: 'locator.tap', label: 'Pay' },
      });
      const window = chunks.at(-1)!.replace(ANSI_PATTERN, '');
      expect(window).toMatch(/└── checkout \d+m?s\n {7}↳ locator\.tap "Pay"\n\n/);
      expect(window).not.toContain('Thinking');
    });

    it('reserves a fixed running area so the summary stays put as calls come and go', () => {
      const restore = withTerminalSize({ rows: 40, columns: 100 });
      try {
        const { chunks, output } = liveCapture();
        const reporter = plainReporter(output, true);
        reporter.handle(runStarted());
        reporter.handle(plan([{ file: 'tests/flow.e2e.ts', tests: 1 }]));
        const summaryRow = (chunk: string) =>
          chunk.replace(ANSI_PATTERN, '').split('\n').findIndex((line) => line.startsWith(' Test Files'));
        const before = summaryRow(chunks.at(-1)!);
        reporter.handle(testStarted('t1', 'checkout', 'chromium', 'tests/flow.e2e.ts'));
        reporter.handle({ type: 'step', testId: 't1', agent: 'default', target: 'chromium', progress: { phase: 'start', kind: 'agent', api: 'agent.act', label: 'pay' } });
        for (let i = 0; i < 4; i += 1) {
          reporter.handle({ type: 'step', testId: 't1', agent: 'default', target: 'chromium', progress: { phase: 'event', api: 'agent.act', event: { kind: 'model', durationMs: 10, count: 100 } as never } });
        }
        const during = summaryRow(chunks.at(-1)!);
        reporter.handle({ type: 'step', testId: 't1', agent: 'default', target: 'chromium', progress: { phase: 'end', kind: 'agent', api: 'agent.act', label: 'pay', status: 'passed', durationMs: 40, modelCalls: 4 } });
        const after = summaryRow(chunks.at(-1)!);
        expect(before).toBeGreaterThan(5);
        expect(during).toBe(before);
        expect(after).toBe(before);
      } finally {
        restore();
      }
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

    it('shows no clock in the live window until the plan arrives', () => {
      const { chunks, output } = liveCapture();
      const reporter = plainReporter(output, true);
      reporter.handle(runStarted());
      reporter.handle({
        type: 'notice',
        target: 'web',
        message: 'Downloading missing Playwright browsers (first run): chromium...',
      });
      // The block below a first-run download has counters but no ticking
      // duration: the run has not started executing yet.
      expect(chunks.at(-1)).toContain('Tests');
      expect(chunks.at(-1)).not.toContain('Duration');
      reporter.handle(plan([{ file: 'tests/a.e2e.ts', tests: 1 }]));
      expect(chunks.at(-1)).toContain('Duration');
      reporter.handle(runFinished({ reportPath: 'r.json' }));
    });

    it('shows the setup step in flight with its clock and drops it once done', () => {
      const { chunks, output } = liveCapture();
      const reporter = plainReporter(output, true);
      reporter.handle(runStarted());
      reporter.handle({ type: 'setup', step: { kind: 'service', label: 'service "compose"' }, state: 'started' });
      expect(chunks.at(-1)).toMatch(/ ❯ starting service "compose" \d+ms/);
      reporter.handle({ type: 'setup', step: { kind: 'service', label: 'service "compose"' }, state: 'finished', durationMs: 900 });
      expect(chunks.at(-1)).not.toContain('starting');
      expect(chunks.some((chunk) => chunk.includes(' ✓ service "compose" ready 900ms'))).toBe(true);
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
    it('keeps the window within the terminal height and folds the tests that do not fit', () => {
      const restore = withTerminalSize({ rows: 8, columns: 60 });
      try {
        const { chunks, output } = liveCapture();
        const reporter = plainReporter(output, true);
        reporter.handle(runStarted());
        reporter.handle(plan([{ file: 'tests/a.e2e.ts', tests: 4 }]));
        for (const id of ['a', 'b', 'c', 'd']) {
          reporter.handle(testStarted(id, `test ${id}`, 'chromium', 'tests/a.e2e.ts'));
          reporter.handle({
            type: 'step',
            testId: id,
            agent: 'default',
            target: 'chromium',
            progress: { phase: 'start', kind: 'agent', api: 'agent.act', label: `step ${id}` },
          });
          for (let i = 0; i < 5; i += 1) {
            reporter.handle({
              type: 'step',
              testId: id,
              agent: 'default',
              target: 'chromium',
              progress: { phase: 'event', api: 'agent.act', event: { kind: 'model', durationMs: 10, count: 100 } as never },
            });
          }
        }
        const rowsPainted = chunks.map((chunk) => chunk.split('\n').length - 1);
        expect(Math.max(...rowsPainted)).toBeLessThanOrEqual(7);
        // eslint-disable-next-line no-control-regex
        const rowsErased = chunks.map((chunk) => Number(/\u001b\[(\d+)A/.exec(chunk)?.[1] ?? 0));
        expect(Math.max(...rowsErased)).toBeLessThanOrEqual(7);
        expect(chunks.at(-1)).toContain('more running');
      } finally {
        restore();
      }
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

  it('never lets control characters through error codes, phases, categories, or paths', () => {
    const raw: string[] = [];
    const reporter = new ListReporter({ write: (line) => raw.push(line) }, { live: false, colors: false });
    const esc = '\u001b[2J';
    reporter.handle(runStarted());
    reporter.handle(plan([{ file: `tests/${esc}a.e2e.ts`, tests: 1 }]));
    reporter.handle(finished(result({
      status: 'failed',
      file: `tests/${esc}a.e2e.ts`,
      attempts: [attempt({
        status: 'failed',
        error: { category: 'test', code: `CODE${esc}`, message: `msg${esc}`, retryable: false },
      })],
    })));
    reporter.handle({
      type: 'run-error',
      error: { category: `infra${esc}` as never, code: `X${esc}`, message: 'm', retryable: false, phase: `prepare${esc}` as never },
    });
    reporter.handle(runFinished({ status: 'failed', exitCode: 1, reportPath: `/project/${esc}/report.json`, aiTracePath: `${esc}t.json` }));
    expect(raw.length).toBeGreaterThan(10);
    // eslint-disable-next-line no-control-regex
    expect(raw.some((line) => /[\u0000-\u001f\u007f]/.test(line))).toBe(false);
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

describe('explore runs', () => {
  const GOAL = 'Explore checkout like a first-time buyer';
  const FINDING = {
    id: 'f-1',
    index: 0,
    step: 1,
    kind: 'issue' as const,
    severity: 4 as const,
    title: 'Cart total shows $0.00 with two items',
    expected: 'The total equals the sum of the two line items',
    actual: 'The cart shows "Total: $0.00" under two items priced $12.00 and $8.00 each',
    reproduction: ['Open the catalog', 'Add two books to the cart', 'Open the cart'],
    path: '/cart',
    artifactId: 'shot-1',
    reportedAt: '2026-09-11T10:00:05.000Z',
  };
  const WARNING = {
    ...FINDING,
    id: 'f-2',
    index: 1,
    step: 2,
    kind: 'warning' as const,
    severity: 1 as const,
    title: 'Footer misspells Receive',
    expected: 'Receive',
    actual: 'Recieve',
    reproduction: ['Scroll to the footer'],
    path: '/',
    artifactId: undefined,
    reportedAt: '2026-09-11T10:00:20.000Z',
  };
  const STEP_1 = { index: 1, title: 'Cart', instruction: 'Add two books and open the cart' };
  const STEP_2 = { index: 2, title: 'Checkout', instruction: 'Pay for the cart' };

  function explore(progress: Extract<RunEventFact, { type: 'explore' }>['progress']): RunEventFact {
    return { type: 'explore', progress };
  }

  function stepEvent(progress: RunEventOf<'step'>['progress']): RunEventFact {
    return { type: 'step', testId: 't1', agent: 'default', target: 'web', progress };
  }

  function engineEvent(name: string, detail?: string): RunEventFact {
    return stepEvent({
      phase: 'event',
      api: 'agent.act',
      event: { kind: 'engine', name, startedAt: '2026-09-11T10:00:04.000Z', durationMs: 40, status: 'passed', ...(detail === undefined ? {} : { detail }) },
    });
  }

  /** The whole exploration from its start to the closing assessment, as the run's stream carries it. */
  function play(reporter: ListReporter): void {
    reporter.handle(runStarted({ targets: ['web'] }));
    reporter.handle(plan([{ file: 'explore', target: 'web', tests: 1 }]));
    reporter.handle(testStarted('t1', GOAL, 'web', 'explore'));
    reporter.handle(explore({ phase: 'started', goal: GOAL, budgets: { maxSteps: 4, timeoutMs: 300_000 } }));
    reporter.handle(explore({ phase: 'planning', closing: false }));
    reporter.handle(stepEvent({ phase: 'start', kind: 'agent', api: 'agent.extract', label: 'Plan the next step' }));
    reporter.handle(stepEvent({ phase: 'end', kind: 'agent', api: 'agent.extract', label: 'Plan the next step', status: 'passed', durationMs: 900, modelCalls: 1 }));
    reporter.handle(explore({ phase: 'step-started', step: STEP_1 }));
    reporter.handle(stepEvent({ phase: 'start', kind: 'agent', api: 'agent.act', label: STEP_1.instruction }));
    reporter.handle(engineEvent('tap', 'tap link "Catalog"'));
    reporter.handle(engineEvent('tap', 'tap button "Add to cart"'));
    reporter.handle(engineEvent('tool:report_finding'));
    reporter.handle(explore({ phase: 'finding', finding: FINDING }));
    reporter.handle(stepEvent({ phase: 'end', kind: 'agent', api: 'agent.act', label: STEP_1.instruction, status: 'passed', durationMs: 32_000, modelCalls: 6 }));
    reporter.handle(explore({ phase: 'step-finished', step: { ...STEP_1, status: 'passed', summary: 'Cart holds two items', startedAt: '2026-09-11T10:00:01.000Z', durationMs: 32_000 } }));
    reporter.handle(explore({ phase: 'planning', closing: false }));
    reporter.handle(explore({ phase: 'step-started', step: STEP_2 }));
    reporter.handle(explore({ phase: 'finding', finding: WARNING }));
    reporter.handle(
      explore({
        phase: 'step-finished',
        step: { ...STEP_2, status: 'failed', summary: 'The Pay button stayed disabled with every field filled', errorCode: 'STEP_FAILED', startedAt: '2026-09-11T10:00:40.000Z', durationMs: 91_000 },
      }),
    );
    reporter.handle(explore({ phase: 'finished', ended: 'finished', summary: 'Checkout cannot be completed. Script the cart total.' }));
    reporter.handle(
      finished(
        result({
          status: 'failed',
          id: 't1',
          file: 'explore',
          title: [GOAL],
          target: 'web',
          attempts: [
            attempt({
              status: 'failed',
              error: { category: 'test', code: 'ASSERTION_FAILED', message: 'exploration found 1 issue(s): [severity 4] Cart total shows $0.00 with two items', retryable: false },
              artifacts: [{ id: 'shot-1', kind: 'screenshot', mediaType: 'image/png', path: 'web/explore/attempt-0/finding-1.png', redaction: 'complete', producer: { kind: 'attempt' } }],
            }),
          ],
        }),
      ),
    );
    reporter.handle(runFinished({ status: 'failed', exitCode: 1, reportPath: '/project/.e2e/report.json' }));
  }

  it('without a live window, streams the header, each finding, and each step as they happen, then the findings with their evidence', () => {
    const { lines, output } = capture();
    const reporter = plainReporter(output);
    play(reporter);
    const text = lines.join('\n');
    expect(lines).toContain(` ❯ |web| Exploring  ${GOAL}`);
    expect(lines).toContain('   ⚑ high issue  Cart total shows $0.00 with two items (/cart)');
    expect(lines).toContain('   ✓ 1  Cart 32.00s · 2 actions · 1 finding');
    expect(lines).toContain('   ⚑ trivial warning  Footer misspells Receive (/)');
    expect(lines).toContain('   × 2  Checkout 91.00s · 1 finding failed');
    expect(lines).toContain('        The Pay button stayed disabled with every field filled');
    expect(lines).toContain('   ended: the agent covered the goal');
    // The planner's and the charter's own agent steps are not rows of their own.
    expect(text).not.toContain('agent.extract');
    expect(text).not.toContain('agent.act');
    // The one synthetic test has no file block, test counters, or failure entry: its verdict is the findings.
    expect(text).not.toContain('Failed Tests');
    expect(text).not.toContain('Test Files');
    expect(text).not.toContain('exploration found');
    expect(lines).toContainEqual(expect.stringContaining(' Findings 2 '));
    const first = lines.indexOf(' 1. high issue       Cart total shows $0.00 with two items');
    expect(first).toBeGreaterThan(0);
    expect(lines.slice(first + 1, first + 9)).toEqual([
      '    /cart · step 1',
      '    expected  The total equals the sum of the two line items',
      '    actual    The cart shows "Total: $0.00" under two items priced $12.00 and',
      '              $8.00 each',
      '    steps     1. Open the catalog',
      '              2. Add two books to the cart',
      '              3. Open the cart',
      '    evidence  .e2e/artifacts/web/explore/attempt-0/finding-1.png',
    ]);
    const second = lines.indexOf(' 2. trivial warning  Footer misspells Receive');
    expect(lines[second + 1]).toBe('    / · step 2');
    const assessment = lines.indexOf(' Assessment');
    expect(lines[assessment + 1]).toBe('   Checkout cannot be completed. Script the cart total.');
    expect(lines).toContain('   Findings  1 issue | 1 warning');
    expect(lines).toContain('      Steps  2 of 4 · 1 passed · 1 failed · the agent covered the goal');
    expect(lines).toContain('     Report  .e2e/report.json');
  });

  it('with a live window, shows the exploration in the window and prints the record with its steps once the run is over', () => {
    const lines: string[] = [];
    const frames: string[] = [];
    const output = {
      write: (line: string) => lines.push(line.replace(ANSI_PATTERN, '')),
      raw: (text: string) => frames.push(text.replace(ANSI_PATTERN, '')),
    };
    const reporter = plainReporter(output, true);
    reporter.handle(runStarted({ targets: ['web'] }));
    reporter.handle(plan([{ file: 'explore', target: 'web', tests: 1 }]));
    reporter.handle(testStarted('t1', GOAL, 'web', 'explore'));
    reporter.handle(explore({ phase: 'started', goal: GOAL, budgets: { maxSteps: 4, timeoutMs: 300_000 } }));
    reporter.handle(explore({ phase: 'planning', closing: false }));
    expect(frames.at(-1)).toContain('↳ planning step 1 of 4');
    expect(frames.at(-1)).toContain('Steps  0 done of 4 · planning');
    // The budget can end the run before the step cap: the planner is then writing the assessment, not a step.
    reporter.handle(explore({ phase: 'planning', closing: true }));
    expect(frames.at(-1)).toContain('↳ planning the closing assessment');
    expect(frames.at(-1)).toContain('Steps  0 done of 4 · closing');
    reporter.handle(explore({ phase: 'step-started', step: STEP_1 }));
    reporter.handle(stepEvent({ phase: 'start', kind: 'agent', api: 'agent.act', label: STEP_1.instruction }));
    reporter.handle(
      stepEvent({
        phase: 'event',
        api: 'agent.act',
        event: {
          kind: 'model',
          startedAt: '2026-09-11T10:00:03.000Z',
          durationMs: 2_500,
          status: 'passed',
          reasoning: 'The cart total is stale; adding an item first.',
        },
      }),
    );
    reporter.handle(engineEvent('tap', 'tap button "Add to cart"'));
    reporter.handle(engineEvent('tool:report_finding'));
    reporter.handle(explore({ phase: 'finding', finding: FINDING }));
    const frame = frames.at(-1)!;
    expect(frame).toContain(`Exploring  ${GOAL}`);
    expect(frame).toContain('↳ 1  Cart (step 1 of 4)');
    expect(frame).toContain('• Thinking (2.50s) · The cart total is stale; adding an item first.');
    expect(frame).toContain('› tap button "Add to cart" (40ms)');
    expect(frame).toContain('⚑ high issue  Cart total shows $0.00 with two items (/cart)');
    expect(frame).not.toContain('report_finding');
    expect(frame).toContain('Findings  1 issue');
    expect(frame).toContain('Steps  0 done of 4 · step 1 running');
    expect(lines).toEqual(expect.not.arrayContaining([expect.stringContaining('Exploring')]));
    play(reporter);
    expect(lines).toContain(` × |web| Explored  ${GOAL}`);
    expect(lines).toContain('   ✓ 1  Cart 32.00s · 2 actions · 1 finding');
    expect(lines).toContain('   × 2  Checkout 91.00s · 1 finding failed');
    expect(lines.join('\n')).not.toContain('Failed Tests');
  });

  it('keeps a failure that is not the findings verdict, such as a run that explored nothing', () => {
    const { lines, output } = capture();
    const reporter = plainReporter(output);
    reporter.handle(runStarted({ targets: ['web'] }));
    reporter.handle(plan([{ file: 'explore', target: 'web', tests: 1 }]));
    reporter.handle(testStarted('t1', GOAL, 'web', 'explore'));
    reporter.handle(explore({ phase: 'started', goal: GOAL, budgets: { maxSteps: 4, timeoutMs: 300_000 } }));
    reporter.handle(explore({ phase: 'finished', ended: 'aborted' }));
    reporter.handle(
      finished(
        result({
          status: 'failed',
          id: 't1',
          file: 'explore',
          title: [GOAL],
          target: 'web',
          attempts: [
            attempt({
              status: 'failed',
              error: { category: 'test', code: 'AUTOMATION_UNSUPPORTED', message: 'exploration concluded nothing: no step ran and no finding was recorded', retryable: false },
            }),
          ],
        }),
      ),
    );
    reporter.handle(runFinished({ status: 'failed', exitCode: 1 }));
    expect(lines).toContain('   no step ran');
    expect(lines).toContain('   ended: the run was cut short');
    expect(lines.join('\n')).toContain('AUTOMATION_UNSUPPORTED: exploration concluded nothing');
    expect(lines).toContain('   Findings  none');
    expect(lines).toContain('      Steps  0 of 4 · the run was cut short');
  });
});

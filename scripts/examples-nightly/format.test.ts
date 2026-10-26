import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatMessage, type Outcome, type ReportCounts, type Row } from './format.ts';

const run = { runUrl: 'https://github.com/o/r/actions/runs/1', sha: 'abcdef1234567' };

function outcome(over: Partial<Outcome> = {}): Outcome {
  return { id: 'vite', name: 'Vite', platform: 'web', job: 'web vite', setup: 'success', build: '', test: 'success', ...over };
}

function report(over: Partial<ReportCounts> = {}): ReportCounts {
  return { passed: 5, failed: 0, flaky: 0, skipped: 0, interrupted: 0, durationMs: 65_000, ...over };
}

test('an all-green run says so and lists every example', () => {
  const rows: Row[] = [
    { outcome: outcome({ id: 'flutter', name: 'Flutter', platform: 'ios', job: 'ios flutter' }), report: report() },
    { outcome: outcome(), report: report({ durationMs: 9_400 }) },
  ];
  assert.equal(
    formatMessage(rows, run),
    [
      '✅ *Nightly examples*: all 2 passed on `main@abcdef1`. <https://github.com/o/r/actions/runs/1|run>',
      '',
      '✅ *Vite* · web: 5 passed (9s)',
      '✅ *Flutter* · iOS: 5 passed (1m 05s)',
    ].join('\n'),
  );
});

test('failures name the stage that failed and link the log', () => {
  const rows: Row[] = [
    { outcome: outcome({ platform: 'android', name: '.NET MAUI', build: 'failure', test: 'skipped' }), jobUrl: 'https://x/1' },
    { outcome: outcome({ test: 'failure' }), report: report({ passed: 3, failed: 2 }), jobUrl: 'https://x/2' },
    { outcome: outcome({ name: 'Next.js' }), report: report({ flaky: 1, passed: 4 }) },
  ];
  const message = formatMessage(rows, { ...run, missing: ['ios expo'] });
  assert.match(message, /^❌ \*Nightly examples\*: 3 of 4 failed/);
  assert.match(message, /❌ \*\.NET MAUI\* · Android: app build failed <https:\/\/x\/1\|log>/);
  assert.match(message, /❌ \*Vite\* · web: 2 failed, 3 passed \(1m 05s\) <https:\/\/x\/2\|log>/);
  assert.match(message, /🟡 \*Next\.js\* · web: 1 flaky, 4 passed/);
  assert.match(message, /❌ \*ios expo\*: the job ended without a result/);
});

test('a run whose tests all skipped is not green', () => {
  const message = formatMessage([{ outcome: outcome(), report: report({ passed: 0, skipped: 5 }) }], run);
  assert.match(message, /❌ \*Vite\* · web: no test passed: 0 passed, 5 skipped/);
});

test('a suite a second pass recovered after an infrastructure failure reads as flaky', () => {
  const rows: Row[] = [
    { outcome: outcome(), report: report({ passed: 1, durationMs: 15_000 }), secondPass: 'last-failed' },
    { outcome: outcome({ name: 'Next.js' }), report: report(), secondPass: 'full' },
  ];
  const message = formatMessage(rows, run);
  assert.match(message, /^🟡 \*Nightly examples\*: all 2 passed, 2 flaky/);
  assert.match(message, /🟡 \*Vite\* · web: infrastructure failure, then the tests it stopped once more: 1 passed \(15s\)/);
  assert.match(message, /🟡 \*Next\.js\* · web: infrastructure failure before any report, then the suite once more: 5 passed/);
});

test('a suite that still fails on its second pass says it had one', () => {
  const rows: Row[] = [{ outcome: outcome({ test: 'failure' }), report: report({ passed: 0, failed: 1 }), secondPass: 'last-failed' }];
  assert.match(formatMessage(rows, run), /❌ \*Vite\* · web: infrastructure failure, then the tests it stopped once more: 1 failed, 0 passed/);
});

test('a run that never reached the examples says why', () => {
  assert.match(formatMessage([], { ...run, blocked: 'pack' }), /building the packages from `main@abcdef1` failed/);
  assert.match(formatMessage([], { ...run, blocked: 'credential' }), /the AI_GATEWAY_API_KEY secret is missing/);
});

test('a run with no result at all is not green', () => {
  assert.match(formatMessage([], run), /^❌ \*Nightly examples\*: no example reported a result/);
});

test('a run whose jobs could not be listed says a missing job may be hidden', () => {
  const message = formatMessage([{ outcome: outcome(), report: report() }], { ...run, jobsUnknown: true });
  assert.match(message, /Could not list the run's jobs/);
});

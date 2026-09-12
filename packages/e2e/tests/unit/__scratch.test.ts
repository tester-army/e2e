import { it } from 'vitest';
import { renderMarkdownReport } from '../../src/report/markdown.ts';
import type { ReportStep } from '../../src/report/build.ts';
import { attempt, report, result } from '../helpers/report-fixture.ts';

function step(overrides: Partial<ReportStep> & Pick<ReportStep, 'index' | 'label'>): ReportStep {
  return { id: `s${overrides.index}`, kind: 'screen', api: 'screen.tap', source: { file: 'tests/members.e2e.ts', line: 40 + overrides.index, column: 1 }, status: 'passed', startedAt: '2026-07-24T12:00:00.000Z', durationMs: 900, events: [], artifacts: [], ...overrides };
}
const agentFail = step({ index: 3, kind: 'agent', api: 'agent.act', label: 'Accept the invitation from the email', status: 'failed', durationMs: 38_000, metrics: { modelCalls: 12, actionSteps: 9, observationBytes: 1, contextBytes: 1, ledgerBytes: 1 }, explanation: 'The Accept button opened a page that still shows Sign in.' });
const failing = result({ title: ['members', 'an email invitation is accepted by the invited account only'], file: 'tests/members.e2e.ts', line: 41, status: 'failed', attempts: [{ ...attempt({ status: 'failed', error: { code: 'ASSERTION_FAILED', message: 'expected heading "Welcome, Ada" to be visible' }, artifacts: ['trace', 'screenshot', 'video'] }), steps: [step({ index: 0, api: 'app.open', kind: 'app', label: 'open /' }), step({ index: 1, kind: 'agent', api: 'agent.act', label: 'Sign in as the owner', metrics: { modelCalls: 4, actionSteps: 3, observationBytes: 1, contextBytes: 1, ledgerBytes: 1 }, cache: { mode: 'self-finalized', replayedActions: 3, totalActions: 3 } }), step({ index: 2, label: 'tap Send invitation' }), agentFail, step({ index: 4, label: 'tap Accept', status: 'cancelled' }), step({ index: 5, api: 'expect', kind: 'assertion', label: 'heading visible', status: 'cancelled' })] }] });
const flaky = result({ title: 'todos survive a filter round-trip', file: 'tests/todos.e2e.ts', status: 'flaky', attempts: [attempt({ status: 'failed', error: { code: 'STEP_TIMEOUT', message: 'slow' }, artifacts: ['screenshot'] }), attempt({ status: 'passed', durationMs: 6_400 })] });
const skipped = result({ title: 'not ready yet', file: 'tests/todos.e2e.ts', status: 'skipped', skip: { cause: 'explicit', reason: 'waiting on the API' } });
const passing = result({ title: 'opens the app', file: 'tests/smoke.e2e.ts', status: 'passed', attempts: [attempt({ durationMs: 850 })] });
const passing2 = result({ title: ['dashboard', 'opens directly'], file: 'tests/smoke.e2e.ts', status: 'passed', attempts: [{ ...attempt({ durationMs: 2_100 }), steps: [step({ index: 0, kind: 'agent', api: 'agent.assert', label: 'the dashboard is shown', metrics: { modelCalls: 1, actionSteps: 0, observationBytes: 1, contextBytes: 1, ledgerBytes: 1 } })] }] });
const doc = report({ status: 'failed', results: [passing, failing, flaky, skipped, passing2] });
doc.run.usage = { ...doc.run.usage, modelTokens: 128_400, modelCachedTokens: 79_600, estimatedCostUsd: 0.31 };
it('prints', () => {
  process.stdout.write(renderMarkdownReport(doc, { artifactsUrl: 'https://github.com/o/r/actions/runs/9', sourceUrl: (f, l) => `https://github.com/o/r/blob/abc/${f}#L${l}`, marker: '<!-- m -->' }));
  process.stdout.write('\n=====\n');
  process.stdout.write(renderMarkdownReport(report({ results: [passing, passing2] }), { artifactsDir: '.e2e/artifacts' }));
});

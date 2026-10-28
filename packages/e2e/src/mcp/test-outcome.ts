/**
 * The lines a session that ran a test opens with: how the test ended, the
 * failure with the line it came from and the code around it, the nodes on
 * screen nearest what a failed locator asked for, the steps that ran, and
 * what to do next from the screen the session shows below them.
 */

import path from 'node:path';
import picocolors from 'picocolors';
import { codeFrame } from '../report/code-frame.ts';
import { formatTime } from '../report/format.ts';
import { plural } from '../report/markdown-text.ts';
import { testLocation, type StandaloneTest, type StandaloneTestOutcome } from '../run/standalone-test.ts';
import type { StepRecord } from '../run/steps.ts';

const plain = picocolors.createColors(false);
/** Steps the text lists; a longer run shows its last ones, where it stopped. */
const MAX_STEPS = 15;
/** Frame lines are clipped here, not at a terminal's width: the agent reads the line it fixes whole. */
const FRAME_CHARS = 160;

const STATUS_TEXT: Record<StandaloneTestOutcome['status'], string> = {
  passed: 'passed',
  failed: 'failed',
  'timed-out': 'timed out',
  skipped: 'skipped itself',
  interrupted: 'was interrupted',
};

const STEP_GLYPH: Record<StepRecord['status'], string> = { passed: '✓', failed: '✗', blocked: '✗', 'timed-out': '✗', cancelled: '–' };

/** The opening lines of a session that ran `test`, before its summary and catalog. */
export function describeTestOutcome(test: StandaloneTest, outcome: StandaloneTestOutcome, projectRoot: string): string {
  const { steps, error, failure } = outcome;
  const title = test.pair.test.titlePath.join(' › ');
  const lines = [`Test "${title}" (${testLocation(test.pair.test)}) ${STATUS_TEXT[outcome.status]} after ${formatTime(outcome.durationMs)}; ${plural(steps.length, 'step')} ran.`];
  if (error !== undefined) {
    const phase = error.phase === undefined || error.phase === 'body' ? '' : ` in ${error.phase}`;
    lines.push(`${error.code}${phase}: ${error.message}`);
    // The line the failure unwound through, else the failing step's own call.
    const source = error.source ?? steps.findLast((step) => step.status !== 'passed')?.source;
    if (source !== undefined) {
      lines.push(`At ${source.file}:${source.line}:${source.column}`);
      const frame = codeFrame({ file: path.resolve(projectRoot, source.file), line: source.line, column: source.column }, plain, FRAME_CHARS);
      for (const row of frame) lines.push(`  ${row}`);
    }
  }
  if (outcome.skipReason !== undefined) lines.push(`Reason: ${outcome.skipReason}`);
  if (failure?.url !== undefined) lines.push(`URL at failure: ${failure.url}`);
  if (failure?.candidates !== undefined && failure.candidates.length > 0) {
    lines.push('On screen, closest to what the locator asked for:', ...failure.candidates.map((candidate) => `  ${candidate}`));
  }
  for (const secondary of outcome.secondaryErrors) {
    lines.push(`Also failed${secondary.phase === undefined || secondary.phase === 'body' ? '' : ` in ${secondary.phase}`}: ${secondary.code}: ${secondary.message}`);
  }
  // A pass needs no story; where a run stopped does.
  if (outcome.status !== 'passed' && steps.length > 0) {
    const shown = steps.slice(-MAX_STEPS);
    lines.push(shown.length < steps.length ? `Steps, the last ${shown.length} of ${steps.length}:` : 'Steps:');
    for (const step of shown) lines.push(`  ${stepLine(step)}`);
  }
  lines.push(nextSteps(test, outcome));
  return lines.join('\n');
}

/** `7. ✗ locator.fill getByLabel('Name') LOCATOR_NOT_FOUND (tests/a.e2e.ts:13)`. */
function stepLine(step: StepRecord): string {
  const hook = step.phase === undefined ? '' : ` in ${step.phase}`;
  const failed = step.status === 'passed' ? '' : ` ${step.error?.code ?? step.status}`;
  const at = step.source === undefined ? '' : ` (${step.source.file}:${step.source.line})`;
  return `${step.index + 1}. ${STEP_GLYPH[step.status]} ${step.api}${step.label === '' ? '' : ` ${step.label}`}${hook}${failed}${at}`;
}

/** What the session is for now, and how to run the test again. */
function nextSteps(test: StandaloneTest, outcome: StandaloneTestOutcome): string {
  const teardown = 'Its afterEach hooks and fixture teardown run at close_session.';
  if (outcome.status === 'passed' || outcome.status === 'skipped') {
    return `The session is on the screen the test ended on, shown below. ${teardown}`;
  }
  // A file that declares one test names it whatever lines an edit adds above it.
  const alone = test.file.tests.filter((each) => each.kind === 'test').length === 1;
  const rerun = alone ? test.pair.test.file : testLocation(test.pair.test);
  return `The session is on the screen where the test stopped, shown below: observe and locate from here, and act out the test's next lines to check them too, then fix the test file. ${teardown} To run the fixed test from the start, close_session, then open_session {test: "${rerun}"}.`;
}

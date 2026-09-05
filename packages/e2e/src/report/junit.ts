/** JUnit XML reporter (spec 06-cli.md): the report-1 document as `.e2e/junit.xml`. */

import { sanitizeText } from '../internal/errors.ts';
import type { Report1Document, ReportError, ReportResult, ReportSerialGroup } from './build.ts';

/** What the final attempt of one result left behind, in the terms JUnit knows. */
interface FinalAttempt {
  durationMs: number;
  error: ReportError | undefined;
  /** Attempts that did not pass before the final one; the flaky note counts these. */
  failedAttempts: number;
}

interface SuiteCounts {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  timeMs: number;
}

interface RenderedCase {
  lines: readonly string[];
  outcome: 'passed' | 'failure' | 'error' | 'skipped';
  durationMs: number;
}

/**
 * Code units XML 1.0 forbids beyond the control range `sanitizeText` already
 * replaces: the two noncharacters U+FFFE and U+FFFF, and a surrogate half
 * without its partner. One of them makes a parser reject the whole document.
 */
const XML_FORBIDDEN = /[\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Escapes text content; every character XML 1.0 forbids becomes U+FFFD. */
function text(value: string): string {
  return sanitizeText(value)
    .replace(XML_FORBIDDEN, '\uFFFD')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Escapes an attribute value; whitespace is entity-encoded so parsers keep it verbatim. */
function attribute(value: string): string {
  return text(value).replaceAll('\n', '&#10;').replaceAll('\r', '&#13;').replaceAll('\t', '&#9;');
}

/** JUnit durations are seconds; three decimals keep millisecond precision. */
function seconds(ms: number): string {
  return (ms / 1_000).toFixed(3);
}

function attributes(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([key, value]) => `${key}="${attribute(value)}"`)
    .join(' ');
}

function countAttributes(counts: SuiteCounts): Record<string, string> {
  return {
    tests: `${counts.tests}`,
    failures: `${counts.failures}`,
    errors: `${counts.errors}`,
    skipped: `${counts.skipped}`,
    time: seconds(counts.timeMs),
  };
}

function emptyCounts(): SuiteCounts {
  return { tests: 0, failures: 0, errors: 0, skipped: 0, timeMs: 0 };
}

function addCase(counts: SuiteCounts, rendered: RenderedCase): void {
  counts.tests += 1;
  counts.timeMs += rendered.durationMs;
  if (rendered.outcome === 'failure') counts.failures += 1;
  else if (rendered.outcome === 'error') counts.errors += 1;
  else if (rendered.outcome === 'skipped') counts.skipped += 1;
}

function addCounts(total: SuiteCounts, part: SuiteCounts): void {
  total.tests += part.tests;
  total.failures += part.failures;
  total.errors += part.errors;
  total.skipped += part.skipped;
  total.timeMs += part.timeMs;
}

/**
 * A serial member's result carries no attempts of its own: its duration and
 * error live on the group's final attempt, keyed by test id. Every other
 * result answers from its own final attempt.
 */
function finalAttempt(
  result: ReportResult,
  groups: ReadonlyMap<string, ReportSerialGroup>,
): FinalAttempt {
  if (result.serialGroupId === undefined) {
    const last = result.attempts.at(-1);
    return {
      durationMs: last?.durationMs ?? 0,
      error: last?.error,
      failedAttempts: result.attempts.slice(0, -1).filter((attempt) => attempt.status !== 'passed').length,
    };
  }
  const group = groups.get(result.serialGroupId);
  const last = group?.attempts.at(-1);
  const member = last?.members.find((candidate) => candidate.testId === result.testId);
  return {
    durationMs: member?.durationMs ?? 0,
    error: member?.error ?? last?.error,
    failedAttempts: (group?.attempts ?? []).slice(0, -1).filter((attempt) => attempt.status !== 'passed').length,
  };
}

/** `<failure>` for a product verdict, `<error>` for anything that prevented one. */
function verdictElement(error: ReportError | undefined, status: ReportResult['status']): 'failure' | 'error' {
  if (error !== undefined) return error.category === 'test' ? 'failure' : 'error';
  return status === 'interrupted' ? 'error' : 'failure';
}

function errorBody(error: ReportError): string {
  const phase = error.phase === undefined ? '' : ` (${error.phase})`;
  return `${error.code}${phase}: ${error.message}`;
}

function renderResult(result: ReportResult, groups: ReadonlyMap<string, ReportSerialGroup>): RenderedCase {
  const final = finalAttempt(result, groups);
  const open = `<testcase ${attributes({
    name: `${result.titlePath.join(' > ')} [${result.targetId}]`,
    classname: result.file,
    time: seconds(final.durationMs),
  })}`;
  switch (result.status) {
    case 'passed':
      return { lines: [`${open}/>`], outcome: 'passed', durationMs: final.durationMs };
    case 'flaky': {
      const count = final.failedAttempts;
      const note = `flaky: ${count} failed attempt${count === 1 ? '' : 's'} before passing`;
      return {
        lines: [`${open}>`, `  <system-out>${text(note)}</system-out>`, '</testcase>'],
        outcome: 'passed',
        durationMs: final.durationMs,
      };
    }
    case 'skipped':
      return {
        lines: [
          `${open}>`,
          `  <skipped ${attributes({ message: result.skip?.reason ?? 'skipped' })}/>`,
          '</testcase>',
        ],
        outcome: 'skipped',
        durationMs: final.durationMs,
      };
    default: {
      const element = verdictElement(final.error, result.status);
      const error = final.error;
      const message = error?.message ?? result.status;
      const type = error?.code ?? result.status;
      const body = error === undefined ? result.status : errorBody(error);
      return {
        lines: [
          `${open}>`,
          `  <${element} ${attributes({ message, type })}>${text(body)}</${element}>`,
          '</testcase>',
        ],
        outcome: element,
        durationMs: final.durationMs,
      };
    }
  }
}

/**
 * A run-level error never becomes a result, so it gets a case of its own in a
 * `run` suite: a startup failure such as `APP_UNREACHABLE` is then visible in
 * CI without opening the JSON report.
 */
function renderRunError(error: ReportError): RenderedCase {
  const phase = error.phase === undefined ? '' : ` (${error.phase})`;
  return {
    lines: [
      `<testcase ${attributes({ name: `${error.code}${phase}`, classname: 'run', time: '0.000' })}>`,
      `  <error ${attributes({ message: error.message, type: error.code })}>${text(`${error.category} error ${errorBody(error)}`)}</error>`,
      '</testcase>',
    ],
    outcome: 'error',
    durationMs: 0,
  };
}

function renderSuite(name: string, cases: readonly RenderedCase[]): { lines: string[]; counts: SuiteCounts } {
  const counts = emptyCounts();
  for (const rendered of cases) addCase(counts, rendered);
  const lines = [`<testsuite ${attributes({ name, ...countAttributes(counts) })}>`];
  for (const rendered of cases) {
    for (const line of rendered.lines) lines.push(`  ${line}`);
  }
  lines.push('</testsuite>');
  return { lines, counts };
}

/**
 * Renders the report-1 document as JUnit XML: one `<testsuite>` per test file
 * (in report order, so the output is completion-time independent), one
 * `<testcase>` per test-target pair, plus a `run` suite for run-level errors.
 * Like every reporter it reads the document, never runner state, and it can
 * never change run status.
 */
export function renderJunitReport(report: Report1Document): string {
  const groups = new Map(report.run.serialGroups.map((group) => [group.id, group]));
  const byFile = new Map<string, RenderedCase[]>();
  for (const result of report.run.results) {
    const cases = byFile.get(result.file) ?? [];
    cases.push(renderResult(result, groups));
    byFile.set(result.file, cases);
  }
  const suites = [...byFile].map(([file, cases]) => renderSuite(file, cases));
  if (report.run.errors.length > 0) {
    suites.push(renderSuite('run', report.run.errors.map(renderRunError)));
  }

  const total = emptyCounts();
  for (const suite of suites) addCounts(total, suite.counts);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites ${attributes({ name: 'e2e', ...countAttributes(total) })}>`,
  ];
  for (const suite of suites) {
    for (const line of suite.lines) lines.push(`  ${line}`);
  }
  lines.push('</testsuites>');
  return `${lines.join('\n')}\n`;
}

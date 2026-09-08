import { describe, expect, it } from 'vitest';
import type { Report1Document, ReportSerialGroup } from '../../src/report/build.ts';
import { renderJunitReport } from '../../src/report/junit.ts';
import { REPORT_AT as AT, reportAttempt, reportDocument, reportError, reportResult } from '../helpers/report.ts';

/** XML 1.0 `Char`, over UTF-16 code units: a surrogate counts only as a proper pair. */
// oxlint-disable-next-line no-control-regex -- the allowed range is the point
const XML_CHARS = /^(?:[\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd]|[\ud800-\udbff][\udc00-\udfff])*$/;
const ENTITY_ONLY = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
const START_TAG = /^<([A-Za-z_][\w.-]*)((?:\s+[A-Za-z_][\w.-]*="[^"<]*")*)\s*(\/?)>$/;

/**
 * Strict well-formedness check standing in for a parser (none is a dependency):
 * every code unit is an XML 1.0 character, tags nest and close by name,
 * attributes are double-quoted without raw `<`, and every `&` is an entity.
 */
function assertWellFormed(xml: string): void {
  if (!XML_CHARS.test(xml)) throw new Error(`XML contains a forbidden character:\n${xml}`);
  const body = xml.replace(/^<\?xml version="1.0" encoding="UTF-8"\?>\n/, '');
  if (body === xml) throw new Error('missing XML declaration');
  const stack: string[] = [];
  let roots = 0;
  for (const token of body.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith('</')) {
      const name = token.slice(2, -1).trim();
      if (stack.pop() !== name) throw new Error(`unbalanced close tag ${token}`);
      continue;
    }
    if (token.startsWith('<')) {
      const match = START_TAG.exec(token);
      if (match === null) throw new Error(`malformed tag ${token}`);
      if (ENTITY_ONLY.test(match[2]!)) throw new Error(`raw ampersand in ${token}`);
      if (stack.length === 0) roots += 1;
      if (match[3] !== '/') stack.push(match[1]!);
      continue;
    }
    if (ENTITY_ONLY.test(token)) throw new Error(`raw ampersand in text ${JSON.stringify(token)}`);
    if (stack.length === 0 && token.trim() !== '') throw new Error(`text outside the root: ${JSON.stringify(token)}`);
  }
  if (stack.length !== 0) throw new Error(`unclosed elements: ${stack.join(', ')}`);
  if (roots !== 1) throw new Error(`expected one root element, found ${roots}`);
}

/** Renders and asserts well-formedness, so every case below also parses. */
function render(document: Report1Document): string {
  const xml = renderJunitReport(document);
  assertWellFormed(xml);
  return xml;
}

function rootAttributes(xml: string): Record<string, string> {
  const match = /<testsuites ([^>]*)>/.exec(xml);
  if (match === null) throw new Error(`no <testsuites> root in:\n${xml}`);
  return Object.fromEntries([...match[1]!.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
}

describe('renderJunitReport', () => {
  it('starts with the XML declaration and ends with a newline', () => {
    const xml = render(reportDocument());
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites ')).toBe(true);
    expect(xml.endsWith('</testsuites>\n')).toBe(true);
  });

  it('renders an empty run as a root with zero counts and no suites', () => {
    const xml = render(reportDocument());
    expect(rootAttributes(xml)).toEqual({
      name: 'e2e',
      tests: '0',
      failures: '0',
      errors: '0',
      skipped: '0',
      time: '0.000',
    });
    expect(xml).not.toContain('<testsuite ');
  });

  it('renders a passed result as a bare testcase named by title path and target', () => {
    const xml = render(reportDocument({ results: [reportResult()] }));
    expect(xml).toContain(
      '<testcase name="auth &gt; signs in [web]" classname="tests/auth.e2e.ts" time="1.234"/>',
    );
    expect(xml).toContain(
      '<testsuite name="tests/auth.e2e.ts" tests="1" failures="0" errors="0" skipped="0" time="1.234">',
    );
    expect(rootAttributes(xml)).toMatchObject({ tests: '1', failures: '0', errors: '0', skipped: '0' });
  });

  it('uses the final attempt for time and notes flaky passes in system-out', () => {
    const xml = render(
      reportDocument({
        results: [
          reportResult({
            status: 'flaky',
            attempts: [
              reportAttempt({ index: 0, status: 'failed', durationMs: 5000, error: reportError() }),
              reportAttempt({ id: 'attempt-2', index: 1, durationMs: 800 }),
            ],
          }),
        ],
      }),
    );
    expect(xml).toContain('time="0.800">');
    expect(xml).toContain('<system-out>flaky: 1 failed attempt before passing</system-out>');
    expect(xml).not.toContain('<failure');
    expect(rootAttributes(xml)).toMatchObject({ tests: '1', failures: '0', errors: '0' });
  });

  it('renders a test-category error as <failure> with code, message, and body', () => {
    const xml = render(
      reportDocument({
        results: [reportResult({ status: 'failed', attempts: [reportAttempt({ status: 'failed', error: reportError() })] })],
      }),
    );
    expect(xml).toContain(
      '<failure message="expected &quot;Sign in&quot; to be visible" type="ASSERTION_FAILED">' +
        'ASSERTION_FAILED: expected &quot;Sign in&quot; to be visible</failure>',
    );
    expect(rootAttributes(xml)).toMatchObject({ failures: '1', errors: '0' });
  });

  it('renders infrastructure and configuration errors as <error>', () => {
    const infrastructure = reportError({
      category: 'infrastructure',
      code: 'DRIVER_CRASHED',
      message: 'gone',
      phase: 'launch',
    });
    const configuration = reportError({ category: 'configuration', code: 'MODEL_UNAVAILABLE', message: 'no model' });
    const xml = render(
      reportDocument({
        results: [
          reportResult({ status: 'failed', attempts: [reportAttempt({ status: 'failed', error: infrastructure })] }),
          reportResult({
            id: 'result-2',
            testId: 'test-2',
            declarationIndex: 1,
            titlePath: ['agent', 'plans'],
            status: 'failed',
            attempts: [reportAttempt({ status: 'failed', error: configuration })],
          }),
        ],
      }),
    );
    expect(xml).toContain('<error message="gone" type="DRIVER_CRASHED">DRIVER_CRASHED (launch): gone</error>');
    expect(xml).toContain(
      '<error message="no model" type="MODEL_UNAVAILABLE">MODEL_UNAVAILABLE: no model</error>',
    );
    expect(xml).not.toContain('<failure');
    expect(rootAttributes(xml)).toMatchObject({ tests: '2', failures: '0', errors: '2' });
  });

  it('falls back to the result status when a failed result carries no error', () => {
    const xml = render(
      reportDocument({
        results: [
          reportResult({ status: 'timed-out', attempts: [reportAttempt({ status: 'timed-out' })] }),
          reportResult({
            id: 'result-2',
            testId: 'test-2',
            declarationIndex: 1,
            status: 'interrupted',
            attempts: [reportAttempt({ status: 'interrupted' })],
          }),
        ],
      }),
    );
    expect(xml).toContain('<failure message="timed-out" type="timed-out">timed-out</failure>');
    expect(xml).toContain('<error message="interrupted" type="interrupted">interrupted</error>');
  });

  it('renders skipped results with their reason and no attempt time', () => {
    const xml = render(
      reportDocument({
        results: [
          reportResult({
            status: 'skipped',
            attempts: [],
            skip: { cause: 'filtered', reason: 'tag filter excluded it' },
          }),
        ],
      }),
    );
    expect(xml).toContain('time="0.000">');
    expect(xml).toContain('<skipped message="tag filter excluded it"/>');
    expect(rootAttributes(xml)).toMatchObject({ tests: '1', skipped: '1' });
  });

  it('groups results into one suite per file, in report order', () => {
    const xml = render(
      reportDocument({
        results: [
          reportResult({ file: 'tests/a.e2e.ts' }),
          reportResult({ id: 'result-2', testId: 'test-2', file: 'tests/b.e2e.ts' }),
          reportResult({ id: 'result-3', testId: 'test-3', file: 'tests/a.e2e.ts', targetId: 'webkit' }),
        ],
      }),
    );
    const suites = [...xml.matchAll(/<testsuite name="([^"]*)" tests="(\d+)"/g)].map((m) => [m[1], m[2]]);
    expect(suites).toEqual([
      ['tests/a.e2e.ts', '2'],
      ['tests/b.e2e.ts', '1'],
    ]);
    expect(xml).toContain('[webkit]');
  });

  it('escapes markup in attributes and text and strips control characters', () => {
    const xml = render(
      reportDocument({
        results: [
          reportResult({
            titlePath: ['<b>bold</b> & "quoted"'],
            status: 'failed',
            attempts: [
              reportAttempt({
                status: 'failed',
                error: reportError({ message: 'line one\nline <two> & done' }),
              }),
            ],
          }),
        ],
      }),
    );
    expect(xml).toContain('name="&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot; [web]"');
    expect(xml).toContain('message="line one&#10;line &lt;two&gt;� &amp; done"');
    expect(xml).toContain('>ASSERTION_FAILED: line one\nline &lt;two&gt;� &amp; done</failure>');
    expect(xml).not.toContain('');
  });

  it('replaces XML-forbidden noncharacters and lone surrogates in text and attributes', () => {
    const lonePair = '\ud83d\ude00';
    const xml = render(
      reportDocument({
        results: [
          reportResult({
            titlePath: [`fffe\ufffe high\ud83d low\ude00 pair${lonePair}`],
            status: 'failed',
            attempts: [
              reportAttempt({
                status: 'failed',
                error: reportError({ message: `ffff\uffff end\udc00 start\udbff` }),
              }),
            ],
          }),
          reportResult({
            id: 'result-2',
            testId: 'test-2',
            declarationIndex: 1,
            status: 'skipped',
            attempts: [],
            skip: { cause: 'filtered', reason: `reason\ufffe\ud800` },
          }),
        ],
        errors: [reportError({ category: 'infrastructure', code: 'APP_UNREACHABLE', message: `run\uffff\udfff` })],
      }),
    );
    expect(xml).not.toMatch(/[\ufffe\uffff]/);
    expect(xml).toContain(`name="fffe\ufffd high\ufffd low\ufffd pair${lonePair} [web]"`);
    expect(xml).toContain('message="ffff\ufffd end\ufffd start\ufffd"');
    expect(xml).toContain('>ASSERTION_FAILED: ffff\ufffd end\ufffd start\ufffd</failure>');
    expect(xml).toContain('<skipped message="reason\ufffd\ufffd"/>');
    expect(xml).toContain('message="run\ufffd\ufffd" type="APP_UNREACHABLE"');
  });

  it('rejects the well-formedness check itself on a forbidden character', () => {
    expect(() => assertWellFormed('<?xml version="1.0" encoding="UTF-8"?>\n<a>\ufffe</a>\n')).toThrow(/forbidden/);
    expect(() => assertWellFormed('<?xml version="1.0" encoding="UTF-8"?>\n<a>\ud800</a>\n')).toThrow(/forbidden/);
    expect(() => assertWellFormed('<?xml version="1.0" encoding="UTF-8"?>\n<a><b></a>\n')).toThrow(/unbalanced/);
    expect(() => assertWellFormed('<?xml version="1.0" encoding="UTF-8"?>\n<a x="1 & 2"/>\n')).toThrow(/ampersand/);
  });

  it('adds a run suite with one <error> case per run-level error', () => {
    const xml = render(
      reportDocument({
        errors: [
          reportError({
            category: 'infrastructure',
            code: 'APP_UNREACHABLE',
            message: 'http://127.0.0.1:3000 did not answer',
            phase: 'launch',
          }),
        ],
      }),
    );
    expect(xml).toContain(
      '<testsuite name="run" tests="1" failures="0" errors="1" skipped="0" time="0.000">',
    );
    expect(xml).toContain('<testcase name="APP_UNREACHABLE (launch)" classname="run" time="0.000">');
    expect(xml).toContain(
      '<error message="http://127.0.0.1:3000 did not answer" type="APP_UNREACHABLE">' +
        'infrastructure error APP_UNREACHABLE (launch): http://127.0.0.1:3000 did not answer</error>',
    );
    expect(rootAttributes(xml)).toMatchObject({ tests: '1', errors: '1' });
  });

  it('reads a serial member from its group attempt', () => {
    const group: ReportSerialGroup = {
      id: 'group-1',
      serialId: 'checkout',
      declarationIndex: 0,
      file: 'tests/checkout.e2e.ts',
      source: { file: 'tests/checkout.e2e.ts', line: 1, column: 1 },
      titlePath: ['checkout'],
      targetId: 'web',
      platform: 'web',
      memberTestIds: ['test-1', 'test-2'],
      status: 'failed',
      attempts: [
        {
          ...reportAttempt({ status: 'failed', durationMs: 3000 }),
          members: [
            {
              id: 'member-1',
              index: 0,
              testId: 'test-1',
              status: 'passed',
              startedAt: AT,
              durationMs: 1000,
              steps: [],
              secondaryErrors: [],
            },
            {
              id: 'member-2',
              index: 1,
              testId: 'test-2',
              status: 'failed',
              startedAt: AT,
              durationMs: 2000,
              steps: [],
              error: reportError({ message: 'cart is empty' }),
              secondaryErrors: [],
            },
          ],
        },
      ],
    };
    const xml = render(
      reportDocument({
        serialGroups: [group],
        results: [
          reportResult({
            file: 'tests/checkout.e2e.ts',
            titlePath: ['checkout', 'adds'],
            serialGroupId: 'group-1',
            attempts: [],
          }),
          reportResult({
            id: 'result-2',
            testId: 'test-2',
            declarationIndex: 1,
            file: 'tests/checkout.e2e.ts',
            titlePath: ['checkout', 'pays'],
            serialGroupId: 'group-1',
            status: 'failed',
            attempts: [],
          }),
        ],
      }),
    );
    expect(xml).toContain(
      '<testcase name="checkout &gt; adds [web]" classname="tests/checkout.e2e.ts" time="1.000"/>',
    );
    expect(xml).toContain(
      '<testcase name="checkout &gt; pays [web]" classname="tests/checkout.e2e.ts" time="2.000">',
    );
    expect(xml).toContain('<failure message="cart is empty" type="ASSERTION_FAILED">');
  });
});

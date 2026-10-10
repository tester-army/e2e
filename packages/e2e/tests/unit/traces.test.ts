/**
 * The trace pages a run writes, `trace.md` in each test's directory under
 * `<output>/results/`: one per result that kept a trace, in a directory named
 * so a reader can find it, and each step told with what it did: the cache's
 * decision, the actions, the polls, and what the app logged.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ReportResult } from '../../src/report/build.ts';
import { writeTracePages } from '../../src/report/traces.ts';
import { reportAttempt, reportDocument, reportError, reportResult, reportStep } from '../helpers/report.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'e2e-traces-'));
  dirs.push(root);
  return root;
}

const ENTRY = 'e'.repeat(64);

const failing = reportResult({
  id: '1a2b3c4d5e6f7a8b9c0d',
  file: 'tests/checkout.e2e.ts',
  titlePath: ['checkout', 'applies the coupon'],
  status: 'failed',
  attempts: [
    reportAttempt({
      status: 'failed',
      error: reportError({ code: 'ASSERTION_FAILED', message: 'expect.toHaveText failed' }),
      secondaryErrors: [reportError({ code: 'ENGINE_FAILURE', message: 'the browser closed early', phase: 'cleanup' })],
      appLog: [{ source: 'network', level: 'error', text: 'POST http://127.0.0.1:4100/api/coupon 500 Internal Server Error', at: '2026-01-01T00:00:02.000Z', step: 0 }],
      steps: [
        reportStep({
          index: 0,
          kind: 'agent',
          api: 'agent.act',
          label: 'add the coupon',
          cache: { mode: 'agent-concluded', reason: 'target-not-found', replayedActions: 1, totalActions: 3, entry: ENTRY, detail: 'at action 2 of 3, tap button "Apply"', write: 'saved' },
          events: [
            { kind: 'engine', name: 'tap', startedAt: '2026-01-01T00:00:01.000Z', durationMs: 12, status: 'passed', detail: 'tap button "Coupon"' },
          ],
        }),
        reportStep({
          index: 1,
          kind: 'assertion',
          api: 'expect.toHaveText',
          label: 'getByRole("status")',
          status: 'failed',
          events: [{ kind: 'poll', name: 'expect', startedAt: '2026-01-01T00:00:03.000Z', durationMs: 5000, status: 'failed', count: 50, detail: 'text "$10" (1 match) x50' }],
        }),
      ],
    }),
  ],
});
const passing = reportResult({ id: 'f'.repeat(12), titlePath: ['opens'], status: 'passed' });
const interrupted = reportResult({ id: '9'.repeat(12), titlePath: ['cut short'], status: 'interrupted', attempts: [reportAttempt({ status: 'interrupted' })] });

describe('writeTracePages', () => {
  it("writes one page per traced result into its test's readable directory, beside what is there, and returns paths from the project root", async () => {
    const root = project();
    const dir = path.join(root, '.e2e', 'results');
    const evidence = path.join(dir, 'checkout-applies-the-coupon-1a2b3c4d5e6f7a8b', 'attempt-1', 'screen-at-failure.txt');
    mkdirSync(path.dirname(evidence), { recursive: true });
    writeFileSync(evidence, 'screen');
    const document = reportDocument({ status: 'failed', results: [passing, failing, interrupted] });
    const pages = await writeTracePages(document, new Set([failing.id]), { projectRoot: root, resultsRoot: dir, cacheDir: path.join(root, '.e2e', 'cache') });
    expect(readdirSync(dir)).toEqual(['checkout-applies-the-coupon-1a2b3c4d5e6f7a8b']);
    expect(readdirSync(path.join(dir, 'checkout-applies-the-coupon-1a2b3c4d5e6f7a8b')).toSorted()).toEqual(['attempt-1', 'trace.md']);
    expect([...pages]).toEqual([[failing.id, '.e2e/results/checkout-applies-the-coupon-1a2b3c4d5e6f7a8b/trace.md']]);
    const text = readFileSync(path.join(dir, 'checkout-applies-the-coupon-1a2b3c4d5e6f7a8b', 'trace.md'), 'utf8');
    expect(text).toContain(`(\`.e2e/cache/${ENTRY}.json\`)`);
    expect(text).toContain('## Also failed');
    expect(text).toContain('**ENGINE_FAILURE** in cleanup: the browser closed early');
  });

  it('tells a traced passing result as its steps, with no failure to look at', async () => {
    const opened = reportResult({ id: 'f'.repeat(12), titlePath: ['opens'], status: 'passed', attempts: [reportAttempt({ status: 'passed', steps: [reportStep({ index: 0, api: 'app.open', label: '/' })] })] });
    const [page] = await pagesOf(opened);
    expect(page!.text).toMatch(/^# ✓ opens\n\n`[^\n]+` · passed · [^\n]+\n\n## Steps\n/);
    expect(page!.text).toContain('1. ✓ `app.open`');
    expect(page!.text).not.toContain('Look at:');
    expect(page!.text).not.toContain('no error was recorded');
  });
});

/** Writes the pages of `results` into a fresh project and returns each page's directory name and text. */
async function pagesOf(...results: ReportResult[]): Promise<{ name: string; text: string }[]> {
  const root = project();
  const dir = path.join(root, '.e2e', 'results');
  await writeTracePages(reportDocument({ status: 'failed', results }), new Set(results.map((result) => result.id)), { projectRoot: root, resultsRoot: dir, cacheDir: path.join(root, '.e2e', 'cache') });
  return readdirSync(dir).map((name) => ({ name, text: readFileSync(path.join(dir, name, 'trace.md'), 'utf8') }));
}

/** The lines a page lists under its step `index`, without their list markers. */
function stepLines(text: string, index: number): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${index}. `));
  const under: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('   - ')) break;
    under.push(line.slice(5));
  }
  return under;
}

describe('trace page names', () => {
  it('read as the file and the title, keep two results with the same words apart by their id, and bound a long file name', async () => {
    const named = (id: string, file: string) => reportResult({ id, file, titlePath: ['signs up', 'with Google'], status: 'failed', attempts: [reportAttempt({ status: 'failed' })] });
    const pages = await pagesOf(named('abcdef0123456789ff', 'tests/Sign Up.e2e.ts'), named('0123456789abcdefff', 'tests/sign-up.e2e.ts'), named('99999999aaaaaaaaff', `tests/${'very-long-name-'.repeat(20)}.e2e.ts`));
    expect(pages.map((page) => page.name).toSorted()).toEqual([
      'sign-up-signs-up-with-google-0123456789abcdef',
      'sign-up-signs-up-with-google-abcdef0123456789',
      `${'very-long-name-'.repeat(3).slice(0, 40)}-signs-up-with-google-99999999aaaaaaaa`,
    ]);
  });
});

describe('the steps on a trace page', () => {
  it("tell the cache's decision first, then the actions, polls, and app log in the order they happened", async () => {
    const [page] = await pagesOf(failing);
    expect(stepLines(page!.text, 1)).toEqual([
      `cache: replayed 1 of 3 recorded actions, then the agent took over: a recorded target is not on the screen; at action 2 of 3, tap button "Apply"; recording saved (\`.e2e/cache/${ENTRY}.json\`)`,
      'tap button "Coupon" (12ms)',
      '✗ network error: `POST /api/coupon 500 Internal Server Error`',
    ]);
    expect(stepLines(page!.text, 2)).toEqual(['expect gave up after 50 reads in 5.0s: text "$10" (1 match) x50']);
  });

  it('leave out a poll that passed on its first read, and name a failed action with its code', async () => {
    const step = reportStep({
      index: 0,
      status: 'failed',
      events: [
        { kind: 'poll', name: 'expect', startedAt: '2026-01-01T00:00:01.000Z', durationMs: 3, status: 'passed', count: 1 },
        { kind: 'engine', name: 'tap', startedAt: '2026-01-01T00:00:02.000Z', durationMs: 30, status: 'failed', code: 'NOT_ACTIONABLE', detail: 'tap button "Save"' },
      ],
    });
    const [page] = await pagesOf(reportResult({ id: 'aaaaaaaa11', status: 'failed', attempts: [reportAttempt({ status: 'failed', steps: [step] })] }));
    expect(stepLines(page!.text, 1)).toEqual(['✗ tap button "Save": **NOT_ACTIONABLE**']);
  });

  it.each(['REPLAY_MISSING', 'REPLAY_STALE'])('say a partial replay stopped, with no agent, when %s ended the step there', async (errorCode) => {
    const step = reportStep({
      index: 0,
      kind: 'agent',
      api: 'agent.act',
      label: 'add the coupon',
      status: 'failed',
      cache: { mode: 'agent-concluded', reason: 'target-not-found', replayedActions: 1, totalActions: 2, entry: ENTRY },
      error: reportError({ code: errorCode, message: 'the replay stopped' }),
      events: [],
    });
    const [page] = await pagesOf(reportResult({ id: `cccccccc3${errorCode.length}`, status: 'failed', attempts: [reportAttempt({ status: 'failed', steps: [step] })] }));
    expect(stepLines(page!.text, 1)[0]).toBe(
      `cache: replayed 1 of 2 recorded actions, then stopped without handing the step to the agent: a recorded target is not on the screen (\`.e2e/cache/${ENTRY}.json\`)`,
    );
  });

  it('keep every failure and the latest events of a step with more than the page has room for', async () => {
    const events = Array.from({ length: 30 }, (_, index) => ({
      kind: 'engine' as const,
      name: 'tap',
      startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      durationMs: 1,
      status: index === 2 ? ('failed' as const) : ('passed' as const),
      detail: `tap button "${index}"`,
    }));
    const step = reportStep({ index: 0, kind: 'agent', api: 'agent.act', label: 'tap them all', status: 'failed', events });
    const [page] = await pagesOf(reportResult({ id: 'bbbbbbbb22', status: 'failed', attempts: [reportAttempt({ status: 'failed', steps: [step] })] }));
    const lines = stepLines(page!.text, 1);
    expect(lines[0]).toBe('10 events left out');
    expect(lines[1]).toBe('✗ tap button "2"');
    expect(lines.at(-1)).toBe('tap button "29" (1ms)');
    expect(lines).toHaveLength(21);
  });

  it('tell how the screen changed by the step, where the page went, and what the app said in passing', async () => {
    const at = (second: number) => `2026-01-01T00:00:0${second}.000Z`;
    const open = reportStep({ index: 0, api: 'app.open', label: '/', screen: { location: 'http://127.0.0.1:4100/todos', nodes: 33, changes: [] } });
    const tap = reportStep({
      index: 1,
      status: 'failed',
      events: [{ kind: 'navigation', startedAt: at(2), durationMs: 0, status: 'passed', detail: 'navigated to http://127.0.0.1:4100/login' }],
      screen: { location: 'http://127.0.0.1:4100/login', nodes: 5, since: 0, changes: ['added heading "Sign in"', 'removed heading "Todos"'], more: 3 },
    });
    const still = reportStep({ index: 2, api: 'locator.tap', screen: { nodes: 5, since: 1, changes: [] } });
    const [page] = await pagesOf(
      reportResult({
        id: 'cccccccc33',
        status: 'failed',
        attempts: [
          reportAttempt({
            status: 'failed',
            environment: { browser: 'chromium 141.0', 'user agent': 'Mozilla/5.0' },
            steps: [open, tap, still],
            appLog: [{ source: 'console', level: 'info', text: 'loaded 3 todos', at: at(1), step: 1 }],
          }),
        ],
      }),
    );
    expect(page!.text).toContain('Ran on: browser `chromium 141.0` · user agent `Mozilla/5.0`');
    expect(stepLines(page!.text, 1)).toEqual(['screen: 33 nodes at `/todos`']);
    expect(stepLines(page!.text, 2)).toEqual(['ℹ console: `loaded 3 todos`', '↪ navigated to /login', 'screen: 5 changes since step 1 at `/login`, 5 nodes']);
    expect(page!.text).toContain('     - `added heading "Sign in"`\n     - `removed heading "Todos"`\n     - 3 more\n');
    expect(stepLines(page!.text, 3)).toEqual(['screen: unchanged since step 2']);
  });
});

describe('the app log on a trace page', () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
  const logged = (ms: number, level: 'info' | 'warning' | 'error', text: string, step: number | undefined, source: 'console' | 'network' = 'console') =>
    ({ source, level, text, at: at(ms), ...(step === undefined ? {} : { step }) }) as const;

  it('lists every line the app logged in one section, oldest first, with its step on the page, and one before the first step as such', async () => {
    const first = reportStep({ index: 0, api: 'app.open', events: [{ kind: 'navigation', startedAt: at(10), durationMs: 0, status: 'passed', detail: 'navigated to http://127.0.0.1:4100/' }] });
    const second = reportStep({ index: 1, status: 'failed' });
    const appLog = [logged(40, 'error', 'POST /api/todos 500', 1, 'network'), logged(20, 'info', 'booted', 0), logged(30, 'warning', 'slow render', 1), logged(5, 'info', 'early', undefined)];
    const [page] = await pagesOf(reportResult({ id: 'dddddddd44', status: 'failed', attempts: [reportAttempt({ status: 'failed', steps: [first, second], appLog })] }));
    expect(page!.text).toContain(
      [
        '## App log',
        '',
        'What the app logged, oldest first, with the step it happened in.',
        '',
        '- before step 1 · ℹ console: `early`',
        '- step 1 · ℹ console: `booted`',
        '- step 2 · ⚠ console warning: `slow render`',
        '- step 2 · ✗ network error: `POST /api/todos 500`',
        '',
      ].join('\n'),
    );
    expect(stepLines(page!.text, 1)).toEqual(['↪ navigated to /', 'ℹ console: `booted`']);
  });

  it('keeps every error past the cap, then the latest of the rest, and says how many it left out', async () => {
    const chatter = Array.from({ length: 60 }, (_, index) => logged(index, 'info', `tick ${index}`, 0));
    const step = reportStep({ index: 0, status: 'failed' });
    const appLog = [logged(-1, 'error', 'first failure', 0), ...chatter];
    const [page] = await pagesOf(reportResult({ id: 'eeeeeeee55', status: 'failed', attempts: [reportAttempt({ status: 'failed', steps: [step], appLog })] }));
    const section = page!.text.split('## App log')[1]!.split('\n## ')[0]!;
    const items = section.split('\n').filter((line) => line.startsWith('- '));
    expect(items).toHaveLength(51);
    expect(items[0]).toBe('- 11 lines left out');
    expect(items[1]).toBe('- step 1 · ✗ console error: `first failure`');
    expect(items.at(-1)).toBe('- step 1 · ℹ console: `tick 59`');
    expect(section).not.toContain('`tick 10`');
  });

  it('leaves the section out when the app logged nothing', async () => {
    const [page] = await pagesOf(reportResult({ id: 'ffffffff66', status: 'failed', attempts: [reportAttempt({ status: 'failed', steps: [reportStep({ index: 0 })] })] }));
    expect(page!.text).not.toContain('## App log');
  });
});

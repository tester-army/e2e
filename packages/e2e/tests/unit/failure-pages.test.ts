/**
 * The failure pages a run writes under `<output>/failures/`: one per failed or
 * flaky result, named so a reader can find it, the directory cleared of an
 * earlier run's pages, and each step told with what it did: the cache's
 * decision, the actions, the polls, and what the app logged.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ReportResult } from '../../src/report/build.ts';
import { writeFailurePages } from '../../src/report/failure-pages.ts';
import { reportAttempt, reportDocument, reportError, reportResult, reportStep } from '../helpers/report.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'e2e-failure-pages-'));
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
      steps: [
        reportStep({
          index: 0,
          kind: 'agent',
          api: 'agent.act',
          label: 'add the coupon',
          cache: { mode: 'agent-concluded', reason: 'target-not-found', replayedActions: 1, totalActions: 3, entry: ENTRY, detail: 'at action 2 of 3, tap button "Apply"', write: 'saved' },
          events: [
            { kind: 'engine', name: 'tap', startedAt: '2026-01-01T00:00:01.000Z', durationMs: 12, status: 'passed', detail: 'tap button "Coupon"' },
            { kind: 'app', name: 'network', level: 'error', startedAt: '2026-01-01T00:00:02.000Z', durationMs: 0, status: 'failed', detail: 'POST http://127.0.0.1:4100/api/coupon 500 Internal Server Error' },
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

describe('writeFailurePages', () => {
  it('writes one page per failed result under its readable name, clears an earlier run, and returns paths from the project root', async () => {
    const root = project();
    const dir = path.join(root, '.e2e', 'failures');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'stale.md'), 'old');
    const document = reportDocument({ status: 'failed', results: [passing, failing, interrupted] });
    const pages = await writeFailurePages(document, { dir, projectRoot: root, artifactsRoot: path.join(root, '.e2e', 'artifacts'), cacheDir: path.join(root, '.e2e', 'cache') });
    expect(readdirSync(dir)).toEqual(['checkout-applies-the-coupon-1a2b3c4d5e6f7a8b.md']);
    expect([...pages]).toEqual([[failing.id, '.e2e/failures/checkout-applies-the-coupon-1a2b3c4d5e6f7a8b.md']]);
    const text = readFileSync(path.join(dir, 'checkout-applies-the-coupon-1a2b3c4d5e6f7a8b.md'), 'utf8');
    expect(text).toContain(`(\`.e2e/cache/${ENTRY}.json\`)`);
    expect(text).toContain('## Also failed');
    expect(text).toContain('**ENGINE_FAILURE** in cleanup: the browser closed early');
  });
});

/** Writes the pages of `results` into a fresh project and returns each page's name and text. */
async function pagesOf(...results: ReportResult[]): Promise<{ name: string; text: string }[]> {
  const root = project();
  const dir = path.join(root, '.e2e', 'failures');
  await writeFailurePages(reportDocument({ status: 'failed', results }), { dir, projectRoot: root, artifactsRoot: path.join(root, '.e2e', 'artifacts'), cacheDir: path.join(root, '.e2e', 'cache') });
  return readdirSync(dir).map((name) => ({ name, text: readFileSync(path.join(dir, name), 'utf8') }));
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

describe('failure page names', () => {
  it('read as the file and the title, keep two results with the same words apart by their id, and bound a long file name', async () => {
    const named = (id: string, file: string) => reportResult({ id, file, titlePath: ['signs up', 'with Google'], status: 'failed', attempts: [reportAttempt({ status: 'failed' })] });
    const pages = await pagesOf(named('abcdef0123456789ff', 'tests/Sign Up.e2e.ts'), named('0123456789abcdefff', 'tests/sign-up.e2e.ts'), named('99999999aaaaaaaaff', `tests/${'very-long-name-'.repeat(20)}.e2e.ts`));
    expect(pages.map((page) => page.name).toSorted()).toEqual([
      'sign-up-signs-up-with-google-0123456789abcdef.md',
      'sign-up-signs-up-with-google-abcdef0123456789.md',
      `${'very-long-name-'.repeat(3).slice(0, 40)}-signs-up-with-google-99999999aaaaaaaa.md`,
    ]);
  });
});

describe('the steps on a failure page', () => {
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
    expect(lines[0]).toBe('10 earlier events left out');
    expect(lines[1]).toBe('✗ tap button "2"');
    expect(lines.at(-1)).toBe('tap button "29" (1ms)');
    expect(lines).toHaveLength(21);
  });
});

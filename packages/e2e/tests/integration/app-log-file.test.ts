/**
 * `appLog.file`: every entry the engine reports for an attempt streamed to
 * `app-log.txt`, uncapped and redacted, beside the attempt's screenshots and
 * registered as a `log` artifact — driven through the real runner over the fake
 * engine, so no browser starts.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppLogEntry, EngineAttemptContext } from '../../src/engine/index.ts';
import type { E2EConfig } from '../../src/index.ts';
import { secrets } from '../../src/secrets.ts';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';

const projects: FixtureProject[] = [];
afterEach(() => {
  for (const project of projects.splice(0)) project.cleanup();
});

/** Runs `files` on the fake engine with `config`, registering the project for cleanup. */
async function run(files: Record<string, string>, config: Partial<E2EConfig>, engine: ReturnType<typeof createFakeEngine>) {
  const { outcome, project } = await runProject(files, {
    config: { targets: [{ name: 'fake', platform: 'web', engine: engine.engine, app: FAKE_APP }], workers: 1, actionTimeout: 300, ...config } as Partial<E2EConfig>,
  });
  projects.push(project);
  return { outcome, project };
}

/** Every `app-log.txt` under the run's `.e2e`, its path relative to the project and its text. */
function appLogFiles(dir: string): { rel: string; text: string }[] {
  const base = path.join(dir, '.e2e');
  const found: { rel: string; text: string }[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === 'app-log.txt') found.push({ rel: path.relative(dir, full), text: readFileSync(full, 'utf8') });
    }
  };
  if (existsSync(base)) walk(base);
  return found.toSorted((a, b) => a.rel.localeCompare(b.rel));
}

const info = (text: string): AppLogEntry => ({ source: 'console', level: 'info', text });

/** A test that opens the app then taps the one button the fake reports. */
const TAP = (title: string, opts = ''): string =>
  `import { test } from 'e2e';\ntest(${JSON.stringify(title)}, ${opts ? `{ ${opts} }` : '{}'}, async ({ app, screen }) => {\n  await app.open('/');\n  await screen.getByRole('button').tap();\n});\n`;

describe('appLog.file', () => {
  it('writes every entry uncapped and in order while the report keeps its cap, as a complete log artifact', async () => {
    let log: ((entry: AppLogEntry) => void) | undefined;
    const fake = createFakeEngine({
      onStartAttempt: (context: EngineAttemptContext) => {
        log = context.appLog;
        // Three lines during the launch, before any step routes: the pre-route
        // hold window the report's quota would otherwise drop.
        for (const t of ['boot 1', 'boot 2', 'boot 3']) log(info(t));
      },
      perform: () => {
        for (let i = 0; i < 105; i += 1) log?.(info(`step ${i}`));
      },
    });
    const { outcome, project } = await run({ 'tests/log.e2e.ts': TAP('logs a lot') }, { appLog: { file: true } }, fake);
    assertValidReport(outcome.report);

    const [file] = appLogFiles(project.dir);
    expect(file, 'app-log.txt written').toBeDefined();
    const lines = file!.text.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(108); // 3 launch + 105 step, none dropped
    expect(lines[0]).toMatch(/ info console boot 1$/);
    expect(lines[2]!.endsWith('info console boot 3')).toBe(true);
    expect(lines[107]!.endsWith('info console step 104')).toBe(true);

    const attempt = resultByTitle(outcome, 'logs a lot').attempts[0]!;
    const reportInfo = (attempt.appLog ?? []).filter((e) => e.level === 'info');
    expect(reportInfo.length).toBeLessThanOrEqual(100); // APP_LOG_LIMITS.info
    expect(reportInfo.length).toBeLessThan(lines.length); // the file is the uncapped superset
    expect(attempt.artifacts).toContainEqual(
      expect.objectContaining({ kind: 'log', mediaType: 'text/plain', redaction: 'complete', path: expect.stringMatching(/attempt-1\/app-log\.txt$/) }),
    );
  });

  it('a test opts out of a run that turned it on, and opts in to a run that left it off', async () => {
    const fake = createFakeEngine({ onStartAttempt: (c) => c.appLog(info('hello')) });
    const off = await run(
      { 'tests/x.e2e.ts': `import { test } from 'e2e';\ntest('quiet', { appLog: { file: false } }, async ({ app }) => { await app.open('/'); });\n` },
      { appLog: { file: true } },
      fake,
    );
    expect(appLogFiles(off.project.dir)).toEqual([]);
    expect(resultByTitle(off.outcome, 'quiet').attempts[0]!.artifacts.every((a) => a.kind !== 'log')).toBe(true);

    const on = await run(
      { 'tests/y.e2e.ts': `import { test } from 'e2e';\ntest('loud', { appLog: { file: true } }, async ({ app }) => { await app.open('/'); });\n` },
      {},
      fake,
    );
    const onFiles = appLogFiles(on.project.dir);
    expect(onFiles).toHaveLength(1);
    expect(onFiles[0]!.text).toContain('hello');
  });

  it('ends the file with one stop line past maxBytes', async () => {
    const fake = createFakeEngine({ onStartAttempt: (c) => { for (let i = 0; i < 50; i += 1) c.appLog(info(`line number ${i} is long enough to matter`)); } });
    const { outcome, project } = await run({ 'tests/cap.e2e.ts': TAP('capped') }, { appLog: { file: true, maxBytes: 400 } }, fake);
    assertValidReport(outcome.report);
    const [file] = appLogFiles(project.dir);
    const lines = file!.text.split('\n').filter((l) => l !== '');
    expect(lines.at(-1)).toMatch(/^\[e2e\] app log stopped at \d+ bytes of 400 \(appLog\.maxBytes\), \d+ entries$/);
    expect(lines.length).toBeLessThan(50); // the cap tripped before every entry landed
  });

  it('writes one file per attempt under retries, contents differing by attempt', async () => {
    let log: ((entry: AppLogEntry) => void) | undefined;
    const fake = createFakeEngine({
      onStartAttempt: (context, attemptIndex) => {
        log = context.appLog;
        log(info(`attempt ${attemptIndex}`));
      },
    });
    // The first attempt fails in the body (a retryable test error, not an
    // engine failure), the retry passes; a module counter persists across the
    // two attempts of one test in the same worker.
    const suite = `import { test } from 'e2e';\nlet tries = 0;\ntest('flaky', async ({ app }) => { await app.open('/'); tries += 1; if (tries === 1) throw new Error('only the first attempt fails'); });\n`;
    const { outcome, project } = await run({ 'tests/flaky.e2e.ts': suite }, { appLog: { file: true }, retries: 1 }, fake);
    assertValidReport(outcome.report);
    const files = appLogFiles(project.dir);
    expect(files).toHaveLength(2);
    expect(files[0]!.text).toContain('attempt 0');
    expect(files[1]!.text).toContain('attempt 1');
    expect(resultByTitle(outcome, 'flaky').attempts).toHaveLength(2);
  });

  it('gives a serial group one file across its members', async () => {
    let log: ((entry: AppLogEntry) => void) | undefined;
    const fake = createFakeEngine({
      onStartAttempt: (context) => {
        log = context.appLog;
        log(info('group boot'));
      },
      perform: () => log?.(info('a member tapped')),
    });
    const suite = `import { test } from 'e2e';\ntest.describe('group', { serial: true }, () => {\n  test('m1', async ({ app, screen }) => { await app.open('/'); await screen.getByRole('button').tap(); });\n  test('m2', async ({ screen }) => { await screen.getByRole('button').tap(); });\n});\n`;
    const { outcome, project } = await run({ 'tests/serial.e2e.ts': suite }, { appLog: { file: true } }, fake);
    assertValidReport(outcome.report);
    const files = appLogFiles(project.dir);
    expect(files).toHaveLength(1); // one session, one attempt, one file
    const lines = files[0]!.text.split('\n').filter((l) => l !== '');
    expect(lines.filter((l) => l.endsWith('group boot'))).toHaveLength(1);
    expect(lines.filter((l) => l.endsWith('a member tapped'))).toHaveLength(2); // both members share the file
  });

  it('redacts a static secret from every line of the file', async () => {
    const fake = createFakeEngine({
      onStartAttempt: (c) => c.appLog({ source: 'network', level: 'error', text: 'header leaked sk-abcdef12345' }),
      perform: () => undefined,
    });
    const { project } = await run(
      { 'tests/sec.e2e.ts': TAP('secret') },
      { appLog: { file: true }, secrets: { apiKey: 'sk-abcdef12345' } },
      fake,
    );
    expect(appLogFiles(project.dir)[0]!.text).not.toContain('sk-abcdef12345');
  });

  it('catches a provider-backed value resolved mid-attempt, in a line written before it was known', async () => {
    const LATE = 'late-provider-value-7Q';
    const handle = secrets.get('sessionToken');
    const fake = createFakeEngine({
      secrets: [handle],
      async onStartAttempt(context) {
        // Written first: the ledger does not hold the provider value yet, so
        // per-line redaction cannot catch it — only the whole-file pass does.
        context.appLog({ source: 'system', level: 'warning', text: `resolved ${LATE} on boot` });
        await context.resolveSecret(handle);
      },
    });
    const { project } = await run(
      { 'tests/late.e2e.ts': TAP('late') },
      { appLog: { file: true }, secrets: { sessionToken: () => LATE } },
      fake,
    );
    const text = appLogFiles(project.dir)[0]!.text;
    expect(text).not.toContain(LATE);
    expect(text).toContain('resolved');
  });

  it('leaves no file and no artifact when the attempt reports nothing', async () => {
    const fake = createFakeEngine({});
    const { outcome, project } = await run({ 'tests/empty.e2e.ts': TAP('silent') }, { appLog: { file: true } }, fake);
    assertValidReport(outcome.report);
    expect(appLogFiles(project.dir)).toEqual([]);
    expect(resultByTitle(outcome, 'silent').attempts[0]!.artifacts.some((a) => a.kind === 'log')).toBe(false);
  });
});

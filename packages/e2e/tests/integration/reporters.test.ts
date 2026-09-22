/**
 * Reporter objects end to end: one sees the event stream and the finished
 * run with resolvable artifact paths, and neither a throwing, a hanging, nor a
 * misbehaving reporter can touch the run's outcome.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, runExisting, type FixtureProject } from '../helpers/run-project.ts';
import type { FinishedRun, Reporter, RunEvent } from '../../src/index.ts';

const SUITE = `import { test, expect } from 'e2e';

test('shows the counter', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByRole('status')).toHaveText('0');
});
`;

describe('reporter objects', () => {
  let app: FixtureApp;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/reporters.e2e.ts': SUITE });
  });

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('receives the event stream and the finished run, whose artifact paths resolve', async () => {
    const events: RunEvent[] = [];
    let finished: FinishedRun | undefined;
    const recording: Reporter = {
      name: 'recording',
      onEvent: (event) => {
        events.push(event);
      },
      onRunFinished: async (run) => {
        finished = run;
        return [{ label: 'Results', text: 'https://example.test/runs/1' }];
      },
    };
    const outcome = await runExisting(project, {
      appUrl: app.url,
      config: { tests: 'tests/**/*.e2e.ts', reporters: [recording], cache: 'off' as const },
    });

    expect(outcome.exitCode).toBe(0);
    expect(events[0]?.type).toBe('run-started');
    expect(events.at(-1)?.type).toBe('run-finished');
    expect(events.some((event) => event.type === 'test-finished')).toBe(true);

    expect(finished).toBeDefined();
    const run = finished!;
    expect(run.status).toBe('passed');
    expect(run.exitCode).toBe(0);
    expect(run.report).toBe(outcome.report);
    expect(run.reportPath).toBe(outcome.reportPath);
    // The document a reporter uploads is the file on disk, byte for byte.
    expect(JSON.parse(readFileSync(run.reportPath!, 'utf8'))).toEqual(run.report);
    expect(run.projectRoot).toBe(project.dir);
    expect(run.artifactsRoot).toBe(path.join(project.dir, '.e2e', 'artifacts'));
    const artifacts = run.report.run.results.flatMap((result) =>
      result.attempts.flatMap((attempt) => attempt.artifacts),
    );
    expect(artifacts.length).toBeGreaterThan(0);
    for (const artifact of artifacts) {
      expect(artifact.path).toBeDefined();
      expect(existsSync(path.join(run.artifactsRoot, artifact.path!))).toBe(true);
    }
  }, 120_000);

  it('warns on stderr for a throwing, hanging, or malformed reporter and leaves the outcome alone', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const throwing: Reporter = {
      name: 'throwing',
      onRunFinished: async () => {
        throw new Error('boom');
      },
    };
    let hangingSignal: AbortSignal | undefined;
    const hanging: Reporter = {
      name: 'hanging',
      onRunFinished: (_run, signal) => {
        hangingSignal = signal;
        return new Promise(() => undefined);
      },
    };
    // What untyped JavaScript hands back: not rows.
    const malformed = {
      name: 'malformed',
      onRunFinished: async () => [{ href: 'https://example.test' }, { label: 'ok', text: 'https://example.test/ok' }],
    } as unknown as Reporter;
    const scalar = { name: 'scalar', onRunFinished: async () => 'done' } as unknown as Reporter;
    const loud: Reporter = {
      name: 'loud',
      onEvent: () => {
        throw new Error('bang');
      },
    };
    const seen: RunEvent['type'][] = [];
    const quiet: Reporter = {
      name: 'quiet',
      onEvent: (event) => {
        seen.push(event.type);
      },
    };
    const outcome = await runExisting(project, {
      appUrl: app.url,
      config: { tests: 'tests/**/*.e2e.ts', reporters: [throwing, hanging, malformed, scalar, loud, quiet], cache: 'off' as const },
      runOptions: {
        reporterTimeout: 200,
        onEvent: () => {
          throw new Error('host bang');
        },
      },
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.status).toBe('passed');
    // The budget running out aborts the reporter's own signal, so it can stop its work.
    expect(hangingSignal?.aborted).toBe(true);
    const written = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain('e2e: reporter "throwing" failed: boom');
    expect(written).toContain('e2e: reporter "hanging" did not finish within 200ms');
    expect(written).toContain('e2e: reporter "malformed" returned 1 row(s) without a label and text; dropped');
    expect(written).toContain('e2e: reporter "scalar" returned something other than summary rows; dropped');
    const loudLine = 'e2e: reporter "loud" threw on run-started: bang; ignoring it for the rest of the run';
    expect(written.split(loudLine)).toHaveLength(2);
    expect(written).toContain('e2e: reporter "onEvent" threw on run-started: host bang; ignoring it for the rest of the run');
    // The quarantine is per sink: the reporter beside the loud one and the host still see the whole run.
    expect(seen[0]).toBe('run-started');
    expect(seen).toContain('test-finished');
    expect(seen.at(-1)).toBe('run-finished');
  }, 120_000);

  it('abandons a reporter when the run is forced to stop', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const force = new AbortController();
    const uploading: Reporter = {
      name: 'uploading',
      onRunFinished: () => {
        // The second Ctrl-C lands while the upload is in flight.
        setTimeout(() => force.abort(), 50);
        return new Promise(() => undefined);
      },
    };
    const outcome = await runExisting(project, {
      appUrl: app.url,
      config: { tests: 'tests/**/*.e2e.ts', reporters: [uploading], cache: 'off' as const },
      runOptions: { reporterTimeout: 30_000, forceSignal: force.signal },
    });

    expect(outcome.status).toBe('passed');
    expect(outcome.exitCode).toBe(0);
    const written = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain('e2e: reporter "uploading" abandoned: the run was forced to stop');
  }, 120_000);
});

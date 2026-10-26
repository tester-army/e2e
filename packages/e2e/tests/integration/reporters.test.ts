/**
 * Reporter objects end to end: one sees the event stream and the finished
 * run with resolvable artifact paths, neither a throwing, a hanging, nor a
 * misbehaving reporter can touch the run's outcome, and one the run gave up
 * on is work left behind, which the CLI does not wait for.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { engineConfig } from '../helpers/fixture-config.ts';
import { createProject, runExisting, type FixtureProject } from '../helpers/run-project.ts';
import type { FinishedRun, Reporter, RunEvent } from '../../src/index.ts';

// The built runner's flag. It stays set for the rest of the process, so only the first reporter given up on can show it.
const abandonedModule = new URL('../../dist/internal/abandoned.js', import.meta.url).href;
const { leftWorkBehind } = (await import(abandonedModule)) as typeof import('../../src/internal/abandoned.ts');

const SUITE = `import { test, expect } from 'e2e';

test('shows the submit button', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByRole('button', { name: 'Submit' })).toBeVisible();
});
`;

describe('reporter objects', () => {
  let project: FixtureProject;

  beforeAll(() => {
    project = createProject({ 'tests/reporters.e2e.ts': SUITE });
  });

  afterAll(() => {
    project?.cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('receives the event stream and the finished run, whose artifact paths resolve, and leaves no work behind', async () => {
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
      config: {
        ...engineConfig(createFakeEngine({ video: true }).engine),
        video: 'on' as const,
        tests: 'tests/**/*.e2e.ts',
        reporters: [recording],
        cache: 'off' as const,
      },
    });

    expect(outcome.exitCode).toBe(0);
    expect(leftWorkBehind()).toBe(false);
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
    expect(run.artifactsRoot).toBe(path.join(project.dir, '.e2e', 'results'));
    const artifacts = run.report.run.results.flatMap((result) =>
      result.attempts.flatMap((attempt) => attempt.artifacts),
    );
    expect(artifacts.length).toBeGreaterThan(0);
    for (const artifact of artifacts) {
      expect(artifact.path).toBeDefined();
      expect(existsSync(path.join(run.artifactsRoot, artifact.path!))).toBe(true);
    }
  }, 120_000);

  it('never calls a reporter when the run was forced to stop before reporting, so it leaves no work behind', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const force = new AbortController();
    force.abort();
    const onRunFinished = vi.fn(async () => undefined);
    await runExisting(project, {
      config: {
        ...engineConfig(createFakeEngine().engine),
        tests: 'tests/**/*.e2e.ts',
        reporters: [{ name: 'uploading', onRunFinished }],
        cache: 'off' as const,
      },
      runOptions: { forceSignal: force.signal },
    });

    expect(onRunFinished).not.toHaveBeenCalled();
    expect(leftWorkBehind()).toBe(false);
    const written = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain('e2e: reporter "uploading" abandoned: the run was forced to stop');
  }, 120_000);

  it('warns on stderr for a throwing, hanging, or malformed reporter, leaves the outcome alone, and records the hanging one as work left behind', async () => {
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
      config: {
        ...engineConfig(createFakeEngine({ video: true }).engine),
        video: 'on' as const,
        tests: 'tests/**/*.e2e.ts',
        reporters: [throwing, hanging, malformed, scalar, loud, quiet],
        cache: 'off' as const,
      },
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
    expect(leftWorkBehind()).toBe(true);
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
      config: {
        ...engineConfig(createFakeEngine({ video: true }).engine),
        video: 'on' as const,
        tests: 'tests/**/*.e2e.ts',
        reporters: [uploading],
        cache: 'off' as const,
      },
      runOptions: { reporterTimeout: 30_000, forceSignal: force.signal },
    });

    expect(outcome.status).toBe('passed');
    expect(outcome.exitCode).toBe(0);
    const written = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain('e2e: reporter "uploading" abandoned: the run was forced to stop');
  }, 120_000);
});

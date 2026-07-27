/**
 * Scheduler tests against a fake transport. The `SpawnUnitRunner` seam means
 * dispatch, capacity, setup gating, and crash handling are all testable
 * without spawning processes or browsers.
 */

import { describe, expect, it } from 'vitest';
import type { CollectedFile, CollectedTest, Collection } from '../../src/collect/collect.ts';
import type {
  ResolvedTestOptions,
  Selection,
  TestTargetPair,
} from '../../src/collect/select.ts';
import type { ResolvedTarget } from '../../src/config/resolve.ts';
import type { ResultRecord, RunError, SerialGroupRecord } from '../../src/run/records.ts';
import { runUnits } from '../../src/run/scheduler.ts';
import type { SpawnUnitRunner, UnitRunner, UnitRunnerEvents } from '../../src/run/unit-runner.ts';
import type { MainToWorker, RunUnitMessage } from '../../src/run/worker/protocol.ts';

const defaultOptions: ResolvedTestOptions = {
  timeout: 30_000,
  retries: 0,
  tags: [],
  platforms: undefined,
  requires: [],
  session: undefined,
  agentContext: undefined,
  skipReason: undefined,
  serial: false,
};

function makeTarget(name: string, index: number): ResolvedTarget {
  return {
    name,
    index,
    platform: 'web',
    browser: 'chromium',
    viewport: undefined,
    driver: 'playwright',
    driverTarget: { name, platform: 'web', browser: 'chromium' },
  };
}

function makeTest(file: string, title: string, overrides: Partial<CollectedTest> = {}): CollectedTest {
  return {
    kind: 'test',
    title,
    titlePath: [title],
    declarationIndex: 0,
    options: {},
    sessions: [],
    fn: () => undefined,
    group: undefined,
    mode: 'normal',
    source: undefined,
    file,
    id: `${file}::${title}`,
    serialRoot: undefined,
    serialId: undefined,
    ...overrides,
  };
}

function makePair(
  test: CollectedTest,
  target: ResolvedTarget,
  overrides: Partial<TestTargetPair> = {},
): TestTargetPair {
  return { test, target, options: defaultOptions, disposition: 'run', skip: undefined, ...overrides };
}

function makeCollection(files: readonly string[], pairs: readonly TestTargetPair[]): Collection {
  const collected: CollectedFile[] = files.map((file) => ({
    file,
    absolutePath: `/project/${file}`,
    registration: { tests: [], hooks: [] },
    tests: pairs.filter((pair) => pair.test.file === file).map((pair) => pair.test),
  }));
  return { files: collected, tests: collected.flatMap((file) => file.tests) };
}

function makeSelection(perTarget: readonly { target: ResolvedTarget; pairs: TestTargetPair[] }[]): Selection {
  return { pairs: perTarget.flatMap((entry) => entry.pairs), perTarget };
}

interface FakeBehaviour {
  /** Statuses to report per test id; defaults to passed. */
  readonly status?: Record<string, ResultRecord['status']>;
  /** Unit ids whose worker exits mid-unit instead of finishing. */
  readonly crashOn?: readonly string[];
  /** Targets whose workers exit instead of becoming ready. */
  readonly failInit?: readonly string[];
  /** Targets whose workers hang in startup, never becoming ready or exiting. */
  readonly neverReady?: readonly string[];
}

class FakeFleet {
  readonly spawned: { targetName: string }[] = [];
  readonly unitsByWorker: RunUnitMessage[][] = [];
  live = 0;
  peakLive = 0;

  constructor(private readonly behaviour: FakeBehaviour = {}) {}

  readonly spawn: SpawnUnitRunner = (targetName, events) => {
    const index = this.spawned.length;
    this.spawned.push({ targetName });
    this.unitsByWorker.push([]);
    this.live += 1;
    this.peakLive = Math.max(this.peakLive, this.live);
    return new FakeRunner(index, targetName, events, this, this.behaviour);
  };

  onExit(): void {
    this.live -= 1;
  }
}

class FakeRunner implements UnitRunner {
  readonly exit: Promise<void>;
  private finish!: () => void;
  private exited = false;

  constructor(
    private readonly index: number,
    private readonly targetName: string,
    private readonly events: UnitRunnerEvents,
    private readonly fleet: FakeFleet,
    private readonly behaviour: FakeBehaviour,
  ) {
    this.exit = new Promise<void>((resolve) => {
      this.finish = resolve;
    });
    setTimeout(() => {
      if (this.exited) return;
      if (behaviour.neverReady?.includes(targetName) === true) return;
      if (behaviour.failInit?.includes(targetName) === true) this.end('init failed');
      else this.events.onMessage({ type: 'ready' });
    }, 0);
  }

  get alive(): boolean {
    return !this.exited;
  }

  send(message: MainToWorker): void {
    if (this.exited) return;
    if (message.type === 'shutdown') {
      setTimeout(() => this.end('shut down'), 0);
      return;
    }
    if (message.type !== 'run-unit') return;
    this.fleet.unitsByWorker[this.index]!.push(message);
    setTimeout(() => this.completeUnit(message), 0);
  }

  kill(): void {
    this.end('killed');
  }

  private completeUnit(message: RunUnitMessage): void {
    if (this.exited) return;
    const crash = this.behaviour.crashOn?.includes(message.unitId) === true;
    for (const pair of message.pairs) {
      if (crash) {
        this.events.onMessage({ type: 'pair-start', testId: pair.test.id });
        this.end('crashed');
        return;
      }
      const status = this.behaviour.status?.[pair.test.id] ?? 'passed';
      this.events.onMessage({
        type: 'result',
        result: { test: pair.test, status, selected: true, attempts: [] },
      });
    }
    this.events.onMessage({ type: 'unit-done', unitId: message.unitId, runErrors: [] });
  }

  private end(detail: string): void {
    if (this.exited) return;
    this.exited = true;
    this.fleet.onExit();
    this.events.onExit(detail);
    this.finish();
  }
}

interface Collected {
  readonly results: ResultRecord[];
  readonly serialGroups: SerialGroupRecord[];
  readonly runErrors: RunError[];
}

async function run(
  selection: Selection,
  collection: Collection,
  fleet: FakeFleet,
  overrides: { workers?: number; interruptSignal?: AbortSignal } = {},
): Promise<Collected> {
  const collected: Collected = { results: [], serialGroups: [], runErrors: [] };
  await runUnits({
    selection,
    collection,
    projectRoot: '/project',
    workers: overrides.workers ?? 2,
    interruptGraceMs: 1_000,
    interruptSignal: overrides.interruptSignal ?? new AbortController().signal,
    spawn: fleet.spawn,
    events: {
      onResult: (result) => collected.results.push(result),
      onSerialGroup: (group) => collected.serialGroups.push(group),
      onRunError: (error) => collected.runErrors.push(error),
    },
  });
  return collected;
}

describe('scheduler capacity', () => {
  it('never exceeds the worker cap, counting discarded workers until they exit', async () => {
    const target = makeTarget('web', 0);
    // Every unit fails, so every worker is discarded right after its unit.
    const pairs = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) =>
      makePair(makeTest(`tests/${name}.e2e.ts`, name), target),
    );
    const files = pairs.map((pair) => pair.test.file);
    const status = Object.fromEntries(
      pairs.map((pair) => [pair.test.id, 'failed' as const]),
    );
    const fleet = new FakeFleet({ status });

    const collected = await run(
      makeSelection([{ target, pairs }]),
      makeCollection(files, pairs),
      fleet,
      { workers: 2 },
    );

    expect(collected.results).toHaveLength(6);
    expect(fleet.peakLive).toBeLessThanOrEqual(2);
    // A discarded worker is replaced, so more than the cap is spawned overall.
    expect(fleet.spawned.length).toBeGreaterThan(2);
  });

  it('spawns no worker for a unit that dissolves into skips', async () => {
    const target = makeTarget('web', 0);
    const setup = makePair(
      makeTest('tests/setup.e2e.ts', 'login', {
        kind: 'setup',
        sessions: ['user'],
        id: 'setup::user',
      }),
      target,
    );
    // Both ordinary tests depend on the session the failing setup produces.
    const dependents = ['a', 'b'].map((name) =>
      makePair(makeTest(`tests/${name}.e2e.ts`, name), target, {
        options: { ...defaultOptions, session: 'user' },
      }),
    );
    const pairs = [setup, ...dependents];
    const fleet = new FakeFleet({ status: { 'setup::user': 'failed' } });

    const collected = await run(
      makeSelection([{ target, pairs }]),
      makeCollection(
        pairs.map((pair) => pair.test.file),
        pairs,
      ),
      fleet,
      { workers: 4 },
    );

    // One worker ran the setup; the dependent units never needed one.
    expect(fleet.spawned).toHaveLength(1);
    const dependentResults = collected.results.filter((result) => result.test.kind === 'test');
    expect(dependentResults).toHaveLength(2);
    for (const result of dependentResults) {
      expect(result.status).toBe('skipped');
      expect(result.skip?.cause).toBe('setup-failed');
      expect(result.skip?.relatedId).toBe('setup::user');
    }
  });
});

describe('scheduler gating and dispatch', () => {
  it('completes every setup before dispatching ordinary units', async () => {
    const target = makeTarget('web', 0);
    const setup = makePair(
      makeTest('tests/setup.e2e.ts', 'login', {
        kind: 'setup',
        sessions: ['user'],
        id: 'setup::user',
      }),
      target,
    );
    const ordinary = ['a', 'b'].map((name) =>
      makePair(makeTest(`tests/${name}.e2e.ts`, name), target),
    );
    const pairs = [setup, ...ordinary];
    const fleet = new FakeFleet();

    const collected = await run(
      makeSelection([{ target, pairs }]),
      makeCollection(
        pairs.map((pair) => pair.test.file),
        pairs,
      ),
      fleet,
      { workers: 3 },
    );

    expect(collected.results).toHaveLength(3);
    const dispatchedIds = fleet.unitsByWorker.flat().map((unit) => unit.unitId);
    expect(dispatchedIds[0]).toContain('setup::');
    // The setup unit is the only one dispatched before it reports done.
    const firstWorkerUnits = fleet.unitsByWorker[0]!;
    expect(firstWorkerUnits[0]!.kind).toBe('setup');
    expect(collected.results[0]!.test.kind).toBe('setup');
  });

  it('runs units for several targets under a single worker cap', async () => {
    const web = makeTarget('web', 0);
    const firefox = makeTarget('firefox', 1);
    const perTarget = [web, firefox].map((target) => ({
      target,
      pairs: ['a', 'b'].map((name) => makePair(makeTest(`tests/${name}.e2e.ts`, name), target)),
    }));
    const fleet = new FakeFleet();

    const collected = await run(
      makeSelection(perTarget),
      makeCollection(['tests/a.e2e.ts', 'tests/b.e2e.ts'], perTarget[0]!.pairs),
      fleet,
      { workers: 1 },
    );

    expect(collected.results).toHaveLength(4);
    expect(fleet.peakLive).toBe(1);
    expect(new Set(fleet.spawned.map((worker) => worker.targetName))).toEqual(
      new Set(['web', 'firefox']),
    );
  });
});

describe('scheduler fault handling', () => {
  it('synthesizes results and a run error when a worker dies mid-unit', async () => {
    const target = makeTarget('web', 0);
    const pairs = ['first', 'second'].map((name, index) =>
      makePair(makeTest('tests/a.e2e.ts', name, { declarationIndex: index }), target),
    );
    const fleet = new FakeFleet({ crashOn: ['file::web::tests/a.e2e.ts'] });

    const collected = await run(
      makeSelection([{ target, pairs }]),
      makeCollection(['tests/a.e2e.ts'], pairs),
      fleet,
      { workers: 1 },
    );

    expect(collected.runErrors).toHaveLength(1);
    expect(collected.runErrors[0]!.error.code).toBe('WORKER_EXIT');
    const running = collected.results.find((result) => result.test.title === 'first')!;
    expect(running.status).toBe('failed');
    expect(running.attempts[0]!.error?.code).toBe('WORKER_CRASH');
    const notStarted = collected.results.find((result) => result.test.title === 'second')!;
    expect(notStarted.status).toBe('skipped');
    expect(notStarted.skip?.cause).toBe('infrastructure-unavailable');
  });

  it('fails a target whose workers never start and skips its remaining units', async () => {
    const target = makeTarget('web', 0);
    const pairs = ['a', 'b'].map((name) =>
      makePair(makeTest(`tests/${name}.e2e.ts`, name), target),
    );
    const fleet = new FakeFleet({ failInit: ['web'] });

    const collected = await run(
      makeSelection([{ target, pairs }]),
      makeCollection(
        pairs.map((pair) => pair.test.file),
        pairs,
      ),
      fleet,
      { workers: 2 },
    );

    expect(collected.runErrors.some((error) => error.error.code === 'WORKER_INIT_FAILED')).toBe(true);
    expect(collected.results).toHaveLength(2);
    for (const result of collected.results) expect(result.status).toBe('skipped');
    // Boot failures stop after the retry budget rather than spawning forever.
    expect(fleet.spawned.length).toBeLessThanOrEqual(3);
  });

  it('fails a target whose worker dies holding a setup unit, without deadlocking', async () => {
    // Regression: the setup unit is already off its queue and owned by a
    // worker that never becomes ready. If it is not requeued before the
    // target is failed, setup gating never clears, no file unit can dispatch,
    // and the run loop waits for a wake that can never come.
    const target = makeTarget('web', 0);
    const setup = makePair(
      makeTest('tests/setup.e2e.ts', 'login', {
        kind: 'setup',
        sessions: ['user'],
        id: 'setup::user',
      }),
      target,
    );
    const gated = ['a', 'b'].map((name) =>
      makePair(makeTest(`tests/${name}.e2e.ts`, name), target, {
        options: { ...defaultOptions, session: 'user' },
      }),
    );
    const pairs = [setup, ...gated];
    const fleet = new FakeFleet({ failInit: ['web'] });

    const collected = await run(
      makeSelection([{ target, pairs }]),
      makeCollection(
        pairs.map((pair) => pair.test.file),
        pairs,
      ),
      fleet,
      { workers: 2 },
    );

    // Every selected pair is accounted for, including the setup itself.
    expect(collected.results).toHaveLength(3);
    for (const result of collected.results) expect(result.status).toBe('skipped');
    expect(collected.results.map((result) => result.test.id)).toContain('setup::user');
    expect(collected.runErrors.some((error) => error.error.code === 'WORKER_INIT_FAILED')).toBe(true);
  });

  it('terminates when interrupted while a worker is still starting', async () => {
    const target = makeTarget('web', 0);
    const pairs = ['a', 'b'].map((name) =>
      makePair(makeTest(`tests/${name}.e2e.ts`, name), target),
    );
    const fleet = new FakeFleet({ neverReady: ['web'] });
    const controller = new AbortController();
    // Abort once the scheduler has spawned a worker and handed it a unit.
    const timer = setTimeout(() => controller.abort(), 20);

    const collected = await run(
      makeSelection([{ target, pairs }]),
      makeCollection(
        pairs.map((pair) => pair.test.file),
        pairs,
      ),
      fleet,
      { workers: 2, interruptSignal: controller.signal },
    );
    clearTimeout(timer);

    expect(fleet.spawned.length).toBeGreaterThan(0);
    expect(collected.results.every((result) => result.status === 'skipped')).toBe(true);
  });

  it('terminates without dispatching when interrupted before it starts', async () => {
    const target = makeTarget('web', 0);
    const pairs = ['a', 'b'].map((name) =>
      makePair(makeTest(`tests/${name}.e2e.ts`, name), target),
    );
    const fleet = new FakeFleet();
    const controller = new AbortController();
    controller.abort();

    const collected = await run(
      makeSelection([{ target, pairs }]),
      makeCollection(
        pairs.map((pair) => pair.test.file),
        pairs,
      ),
      fleet,
      { workers: 2, interruptSignal: controller.signal },
    );

    expect(fleet.spawned).toHaveLength(0);
    expect(collected.results).toHaveLength(0);
  });

  it('reports non-run pairs without dispatching them', async () => {
    const target = makeTarget('web', 0);
    const skipped = makePair(makeTest('tests/a.e2e.ts', 'skipped', { id: 'skip-me' }), target, {
      disposition: 'skip',
      skip: { cause: 'explicit', reason: 'test.skip' },
    });
    const filtered = makePair(makeTest('tests/a.e2e.ts', 'filtered', { id: 'filter-me' }), target, {
      disposition: 'filtered',
      skip: undefined,
    });
    const fleet = new FakeFleet();

    const collected = await run(
      makeSelection([{ target, pairs: [skipped, filtered] }]),
      makeCollection(['tests/a.e2e.ts'], [skipped, filtered]),
      fleet,
      { workers: 2 },
    );

    expect(fleet.spawned).toHaveLength(0);
    expect(collected.results).toHaveLength(2);
    expect(collected.results.find((result) => result.test.id === 'skip-me')!.selected).toBe(true);
    expect(collected.results.find((result) => result.test.id === 'filter-me')!.selected).toBe(false);
  });
});

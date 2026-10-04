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
  SkipInfo,
  TestTargetPair,
} from '../../src/collect/select.ts';
import type { ResolvedTarget } from '../../src/config/resolve.ts';
import { defineEngine, type EngineHandle } from '../../src/engine/index.ts';
import { classifyError, serializeError } from '../../src/internal/errors.ts';
import type { AttemptRecord, ResultRecord, RunError, SerialGroupRecord } from '../../src/run/records.ts';
import { runUnits } from '../../src/run/scheduler.ts';
import { serialGroupId, type SerialAttemptRun } from '../../src/run/serial.ts';
import { buildWorkPlans, type TargetWorkPlan } from '../../src/run/units.ts';
import type { SpawnUnitRunner, UnitRunner, UnitRunnerEvents } from '../../src/run/unit-runner.ts';
import type { MainToWorker, RunUnitMessage } from '../../src/run/worker/protocol.ts';

const defaultOptions: ResolvedTestOptions = {
  timeout: 30_000,
  retries: 0,
  platforms: undefined,
  requires: [],
  session: undefined,
  agents: ['default'],
  agentContext: undefined,
  skipReason: undefined,
  serial: false,
  trace: undefined,
  video: undefined,
};

const EMPTY_APP: ResolvedTarget['app'] = {
  base: undefined,
  portRequest: undefined,
  site: undefined,
  environment: 'test',
  identity: undefined,
  bundleId: undefined,
  appPath: undefined,
  launchArguments: undefined,
  permissions: undefined,
  command: undefined,
  readyUrl: undefined,
};
const EMPTY_DECLARED: ResolvedTarget['declaredApp'] = {
  url: undefined,
  bundleId: undefined,
  appPath: undefined,
  identity: undefined,
  environment: undefined,
  launchArguments: undefined,
  permissions: undefined,
  command: undefined,
  readyUrl: undefined,
};
function makeTarget(name: string, index: number, engine?: EngineHandle): ResolvedTarget {
  return {
    name,
    index,
    platform: 'web',
    engine,
    app: EMPTY_APP,
    declaredApp: EMPTY_DECLARED,
    trace: { mode: 'off', source: 'default' },
    video: { mode: 'off', source: 'default' },
  };
}

/** An engine that serves at most `workers` workers per target, like a device pool of that size. */
function boundedEngine(workers: number): EngineHandle {
  return defineEngine({ name: 'pool', version: '1.0.0', spiVersion: 1, workers });
}

function makeTest(file: string, title: string, overrides: Partial<CollectedTest> = {}): CollectedTest {
  return {
    kind: 'test',
    title,
    titlePath: [title],
    declarationIndex: 0,
    options: {},
    sessions: [],
    tags: [],
    fn: () => undefined,
    fixtures: [],
    group: undefined,
    mode: 'normal',
    source: undefined,
    file,
    id: `${file}::${title}`,
    serialRoot: undefined,
    serialId: undefined,
    selected: true,
    ...overrides,
  };
}

function makePair(
  test: CollectedTest,
  target: ResolvedTarget,
  overrides: Partial<TestTargetPair> = {},
): TestTargetPair {
  return { test, target, agent: 'default', repeat: 0, options: defaultOptions, disposition: 'run', skip: undefined, ...overrides };
}

function makeCollection(files: readonly string[], pairs: readonly TestTargetPair[]): Collection {
  const collected: CollectedFile[] = files.map((file) => ({
    file,
    absolutePath: `/project/${file}`,
    registration: { tests: [], hooks: [] },
    tests: pairs.filter((pair) => pair.test.file === file).map((pair) => pair.test),
    selected: true,
  }));
  return {
    files: collected,
    tests: collected.flatMap((file) => file.tests),
    nearMisses: [],
    unmatchedPositionals: [],
    uncollected: [],
  };
}

function makeSelection(perTarget: readonly { target: ResolvedTarget; pairs: TestTargetPair[] }[]): Selection {
  return { pairs: perTarget.flatMap((entry) => entry.pairs), perTarget };
}

interface FakeBehaviour {
  /** Statuses to report per test id; defaults to passed. */
  readonly status?: Record<string, ResultRecord['status']>;
  /** Unit ids whose worker exits mid-unit instead of finishing. */
  readonly crashOn?: readonly string[];
  /** Unit ids whose worker reports a fatal error instead of finishing, and waits to be killed. */
  readonly fatalOn?: readonly string[];
  /** Targets whose workers exit instead of becoming ready. */
  readonly failInit?: readonly string[];
  /** Targets whose workers hang in startup, never becoming ready or exiting. */
  readonly neverReady?: readonly string[];
  /** Unit ids whose worker never finishes: a test that will not end on its own. */
  readonly hangOn?: readonly string[];
  /** Attempts the unit's first pair finishes before the worker hangs: a test caught between attempts. */
  readonly attemptsBeforeHang?: readonly AttemptRecord[];
  /** The hung pair starts its next attempt after `attemptsBeforeHang`, and the worker exits on its own once interrupted. */
  readonly exitDuringNextAttemptOnInterrupt?: boolean;
  /** Serial group attempts the unit's pairs (one group) finish before the worker hangs. */
  readonly serialRunsBeforeHang?: readonly SerialAttemptRun[];
  /** Workers ignore `terminate` and have to be killed. */
  readonly ignoreTerminate?: boolean;
  /**
   * The first `workers` spawned die of `signal` before becoming ready, as
   * workers still loading do when a terminal Ctrl-C reaches the process
   * group; the ones after them hang in startup.
   */
  readonly signalledInit?: { readonly workers: number; readonly signal: NodeJS.Signals };
}

const FAILED_ATTEMPT: AttemptRecord = {
  id: 'attempt-0',
  index: 0,
  status: 'failed',
  startedAt: '2026-01-01T00:00:00.000Z',
  durationMs: 5,
  steps: [],
  artifacts: [],
  error: serializeError(classifyError(new Error('first attempt fails'))),
  secondaryErrors: [],
  cleanup: 'complete',
};

const PASSED_RETRY: AttemptRecord = {
  id: 'attempt-1',
  index: 1,
  status: 'passed',
  startedAt: '2026-01-01T00:00:01.000Z',
  durationMs: 5,
  steps: [],
  artifacts: [],
  secondaryErrors: [],
  cleanup: 'complete',
};

class FakeFleet {
  readonly spawned: { targetName: string; workerSlot: number }[] = [];
  readonly unitsByWorker: RunUnitMessage[][] = [];
  /** Control messages every worker received, in order. */
  readonly controlMessages: MainToWorker['type'][] = [];
  /** The skip each interrupt carried for unstarted pairs, `undefined` for a plain interrupt. */
  readonly interruptSkips: (SkipInfo | undefined)[] = [];
  live = 0;
  peakLive = 0;
  private readonly liveByTarget = new Map<string, number>();
  /** The most workers alive at once per target. */
  readonly peakLiveByTarget = new Map<string, number>();

  constructor(private readonly behaviour: FakeBehaviour = {}) {}

  readonly spawn: SpawnUnitRunner = (targetName, workerSlot, events) => {
    const index = this.spawned.length;
    this.spawned.push({ targetName, workerSlot });
    this.unitsByWorker.push([]);
    this.live += 1;
    this.peakLive = Math.max(this.peakLive, this.live);
    const liveForTarget = (this.liveByTarget.get(targetName) ?? 0) + 1;
    this.liveByTarget.set(targetName, liveForTarget);
    this.peakLiveByTarget.set(targetName, Math.max(this.peakLiveByTarget.get(targetName) ?? 0, liveForTarget));
    return new FakeRunner(index, targetName, events, this, this.behaviour);
  };

  onExit(targetName: string): void {
    this.live -= 1;
    this.liveByTarget.set(targetName, (this.liveByTarget.get(targetName) ?? 1) - 1);
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
      const signalled = behaviour.signalledInit;
      if (signalled !== undefined) {
        if (index < signalled.workers) this.end(`code null, signal ${signalled.signal}`, signalled.signal);
        return;
      }
      if (behaviour.failInit?.includes(targetName) === true) this.end('init failed');
      else this.events.onMessage({ type: 'ready' });
    }, 0);
  }

  get alive(): boolean {
    return !this.exited;
  }

  send(message: MainToWorker): void {
    if (this.exited) return;
    if (message.type !== 'run-unit') this.fleet.controlMessages.push(message.type);
    if (message.type === 'interrupt') this.fleet.interruptSkips.push(message.skip);
    if (message.type === 'interrupt' && this.behaviour.exitDuringNextAttemptOnInterrupt === true) {
      setTimeout(() => this.end('code 7, signal null'), 0);
      return;
    }
    if (message.type === 'shutdown') {
      setTimeout(() => this.end('shut down'), 0);
      return;
    }
    if (message.type === 'terminate') {
      if (this.behaviour.ignoreTerminate !== true) setTimeout(() => this.end('terminated'), 0);
      return;
    }
    if (message.type !== 'run-unit') return;
    this.fleet.unitsByWorker[this.index]!.push(message);
    if (this.behaviour.hangOn?.includes(message.unitId) === true) {
      const first = message.pairs[0];
      for (const groupRun of this.behaviour.serialRunsBeforeHang ?? []) {
        const groupId = serialGroupId(first!.test.serialId!, this.targetName, first!.agent, first!.repeat);
        for (const [index, member] of groupRun.record.members.entries()) {
          const pair = message.pairs[index]!;
          this.events.onMessage({ type: 'pair-start', testId: pair.test.id, agent: pair.agent, repeat: pair.repeat, title: pair.test.id, file: pair.test.file, serialId: pair.test.serialId });
          this.events.onMessage({ type: 'serial-member', groupId, attempt: groupRun.record, member });
        }
        this.events.onMessage({ type: 'serial-attempt', groupId, run: groupRun });
      }
      const attempts = this.behaviour.attemptsBeforeHang ?? [];
      const nextAttempt = this.behaviour.exitDuringNextAttemptOnInterrupt === true;
      if ((attempts.length > 0 || nextAttempt) && first !== undefined) {
        const pair = { testId: first.test.id, agent: first.agent, repeat: first.repeat };
        this.events.onMessage({ type: 'pair-start', ...pair, title: first.test.id, file: first.test.file, serialId: undefined });
        for (const attempt of attempts) {
          this.events.onMessage({ type: 'attempt-start', ...pair, index: attempt.index });
          this.events.onMessage({ type: 'attempt', ...pair, attempt });
        }
        if (nextAttempt) this.events.onMessage({ type: 'attempt-start', ...pair, index: attempts.length });
      }
      return;
    }
    setTimeout(() => this.completeUnit(message), 0);
  }

  kill(): void {
    this.end('killed');
  }

  private completeUnit(message: RunUnitMessage): void {
    if (this.exited) return;
    if (this.behaviour.fatalOn?.includes(message.unitId) === true) {
      this.events.onMessage({ type: 'fatal', error: serializeError(classifyError(new Error('engine exploded'))) });
      return;
    }
    const crash = this.behaviour.crashOn?.includes(message.unitId) === true;
    for (const pair of message.pairs) {
      if (crash) {
        this.events.onMessage({
          type: 'pair-start',
          testId: pair.test.id,
          agent: pair.agent,
          repeat: pair.repeat,
          title: pair.test.id,
          file: pair.test.file,
          serialId: pair.test.serialId,
        });
        this.end('crashed');
        return;
      }
      const status = this.behaviour.status?.[pair.test.id] ?? 'passed';
      this.events.onMessage({
        type: 'result',
        result: { test: pair.test, agent: pair.agent, repeat: pair.repeat, status, selected: true, attempts: [] },
      });
    }
    this.events.onMessage({ type: 'unit-done', unitId: message.unitId, runErrors: [] });
  }

  private end(detail: string, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.fleet.onExit(this.targetName);
    this.events.onExit(detail, signal);
    this.finish();
  }
}

interface Collected {
  readonly results: ResultRecord[];
  readonly serialGroups: SerialGroupRecord[];
  readonly runErrors: RunError[];
  /** `onFailureLimit` calls, as `[failures, limit]`. */
  readonly failureLimits: [number, number][];
}

async function run(
  selection: Selection,
  collection: Collection,
  fleet: FakeFleet,
  overrides: {
    workers?: number;
    /** Worker cap `prepare` reported per target name, applied to the plans. */
    preparedWorkers?: Record<string, number>;
    interruptSignal?: AbortSignal;
    forceSignal?: AbortSignal;
    interruptGraceMs?: number;
    forceGraceMs?: number;
    maxFailures?: number;
  } = {},
): Promise<Collected> {
  const collected: Collected = { results: [], serialGroups: [], runErrors: [], failureLimits: [] };
  await runUnits({
    ...(overrides.maxFailures === undefined ? {} : { maxFailures: overrides.maxFailures }),
    plans: buildWorkPlans(selection, collection, '/project').map((plan): TargetWorkPlan => {
      const workers = overrides.preparedWorkers?.[plan.target.name];
      return workers === undefined ? plan : { ...plan, workers };
    }),
    workers: overrides.workers ?? 2,
    interruptGraceMs: overrides.interruptGraceMs ?? 1_000,
    interruptSignal: overrides.interruptSignal ?? new AbortController().signal,
    forceSignal: overrides.forceSignal ?? new AbortController().signal,
    forceGraceMs: overrides.forceGraceMs ?? 1_000,
    spawn: fleet.spawn,
    events: {
      onResult: (result) => collected.results.push(result),
      onSerialGroup: (group) => collected.serialGroups.push(group),
      onRunError: (error) => collected.runErrors.push(error),
      onRunAbort: (error) => collected.runErrors.push(error),
      onFailureLimit: (failures, limit) => collected.failureLimits.push([failures, limit]),
    },
  });
  return collected;
}

describe('failure limit', () => {
  it('stops dispatching at the limit, skips every queued pair with the reason, and interrupts the workers with it', async () => {
    const target = makeTarget('web', 0);
    const pairs = ['a', 'b', 'c', 'd', 'e'].map((name) => makePair(makeTest(`tests/${name}.e2e.ts`, name), target));
    const status = Object.fromEntries(pairs.map((pair) => [pair.test.id, 'failed' as const]));
    const fleet = new FakeFleet({ status });

    const collected = await run(makeSelection([{ target, pairs }]), makeCollection(pairs.map((pair) => pair.test.file), pairs), fleet, {
      workers: 1,
      maxFailures: 2,
    });

    const byTitle = (title: string) => collected.results.find((result) => result.test.title === title)!;
    expect(collected.results).toHaveLength(5);
    expect(['a', 'b'].map((title) => byTitle(title).status)).toEqual(['failed', 'failed']);
    for (const title of ['c', 'd', 'e']) {
      expect(byTitle(title)).toMatchObject({
        status: 'skipped',
        selected: true,
        skip: { cause: 'failure-limit', reason: 'run stopped after 2 failures (--max-failures 2)' },
      });
    }
    expect(collected.failureLimits).toEqual([[2, 2]]);
    expect(fleet.unitsByWorker.flat()).toHaveLength(2);
    expect(fleet.interruptSkips).toEqual([{ cause: 'failure-limit', reason: 'run stopped after 2 failures (--max-failures 2)' }]);
    expect(collected.runErrors).toEqual([]);
  });

  it('kills a worker that outlives the interrupt grace after the limit without calling it an unexpected exit', async () => {
    const target = makeTarget('web', 0);
    const pairs = ['fails', 'hangs'].map((name) => makePair(makeTest(`tests/${name}.e2e.ts`, name), target));
    const fleet = new FakeFleet({ status: { [pairs[0]!.test.id]: 'failed' }, hangOn: ['file::web::tests/hangs.e2e.ts'] });
    const collected = await run(makeSelection([{ target, pairs }]), makeCollection(pairs.map((pair) => pair.test.file), pairs), fleet, {
      workers: 2,
      maxFailures: 1,
      interruptGraceMs: 10,
    });
    expect(collected.runErrors).toEqual([]);
    expect(collected.results.map((result) => [result.test.title, result.status, result.skip?.cause])).toEqual([
      ['fails', 'failed', undefined],
      ['hangs', 'skipped', 'failure-limit'],
    ]);
    expect(fleet.controlMessages).toContain('interrupt');
  });

  it('counts timed-out results and lets a run below the limit finish whole', async () => {
    const target = makeTarget('web', 0);
    const pairs = ['a', 'b', 'c'].map((name) => makePair(makeTest(`tests/${name}.e2e.ts`, name), target));
    const fleet = new FakeFleet({ status: { [pairs[0]!.test.id]: 'timed-out', [pairs[1]!.test.id]: 'failed' } });
    const collected = await run(makeSelection([{ target, pairs }]), makeCollection(pairs.map((pair) => pair.test.file), pairs), fleet, {
      workers: 1,
      maxFailures: 3,
    });
    expect(collected.results.map((result) => result.status)).toEqual(['timed-out', 'failed', 'passed']);
    expect(collected.failureLimits).toEqual([]);
    expect(fleet.interruptSkips).toEqual([]);
  });
});

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

  it('hands each worker the lowest free slot of its target and reuses a slot once its worker exited', async () => {
    const target = makeTarget('web', 0);
    const pairs = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) =>
      makePair(makeTest(`tests/${name}.e2e.ts`, name), target),
    );
    const files = pairs.map((pair) => pair.test.file);
    const status = Object.fromEntries(
      pairs.map((pair) => [pair.test.id, 'failed' as const]),
    );
    const fleet = new FakeFleet({ status });

    await run(makeSelection([{ target, pairs }]), makeCollection(files, pairs), fleet, { workers: 2 });

    // Two slots exist for a cap of two, however many replacement workers were spawned.
    const slots = fleet.spawned.map((worker) => worker.workerSlot);
    expect(fleet.spawned.length).toBeGreaterThan(2);
    expect(new Set(slots)).toEqual(new Set([0, 1]));
    expect(slots[0]).toBe(0);
  });

  it('caps a target at the workers its engine declares and hands the rest of the run cap to other targets', async () => {
    const ios = makeTarget('ios', 0, boundedEngine(2));
    const web = makeTarget('web', 1);
    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => `tests/${name}.e2e.ts`);
    const tests = files.map((file) => makeTest(file, 'case'));
    const iosPairs = tests.map((test) => makePair(test, ios));
    const webPairs = tests.map((test) => makePair(test, web));
    const fleet = new FakeFleet();

    const collected = await run(
      makeSelection([{ target: ios, pairs: iosPairs }, { target: web, pairs: webPairs }]),
      makeCollection(files, iosPairs),
      fleet,
      { workers: 4 },
    );

    expect(collected.results).toHaveLength(12);
    expect(fleet.peakLive).toBeLessThanOrEqual(4);
    // Two slots for ios, however many the run allows; every ios worker kept passing, so none was replaced.
    expect(fleet.spawned.filter((worker) => worker.targetName === 'ios').map((worker) => worker.workerSlot)).toEqual([0, 1]);
    expect(fleet.peakLiveByTarget.get('ios')).toBe(2);
    // The capacity ios left unused went to web at once instead of waiting for ios to run dry.
    expect(fleet.spawned.slice(0, 4).map((worker) => worker.targetName)).toEqual(['ios', 'ios', 'web', 'web']);
  });

  it('replaces a discarded worker of a capped target only once its exit freed the slot', async () => {
    const target = makeTarget('ios', 0, boundedEngine(1));
    const pairs = ['a', 'b', 'c', 'd'].map((name) => makePair(makeTest(`tests/${name}.e2e.ts`, name), target));
    const files = pairs.map((pair) => pair.test.file);
    const status = Object.fromEntries(pairs.map((pair) => [pair.test.id, 'failed' as const]));
    const fleet = new FakeFleet({ status });

    const collected = await run(makeSelection([{ target, pairs }]), makeCollection(files, pairs), fleet, { workers: 3 });

    expect(collected.results).toHaveLength(4);
    expect(fleet.spawned.length).toBe(4);
    expect(fleet.spawned.map((worker) => worker.workerSlot)).toEqual([0, 0, 0, 0]);
    expect(fleet.peakLiveByTarget.get('ios')).toBe(1);
  });

  it('caps a target at the workers its engine reported from prepare, under the run cap', async () => {
    const target = makeTarget('ios', 0);
    const pairs = ['a', 'b', 'c', 'd'].map((name) => makePair(makeTest(`tests/${name}.e2e.ts`, name), target));
    const files = pairs.map((pair) => pair.test.file);
    const fleet = new FakeFleet();

    const collected = await run(makeSelection([{ target, pairs }]), makeCollection(files, pairs), fleet, {
      workers: 4,
      preparedWorkers: { ios: 2 },
    });

    expect(collected.results).toHaveLength(4);
    expect(fleet.peakLive).toBe(2);
    expect(new Set(fleet.spawned.map((worker) => worker.workerSlot))).toEqual(new Set([0, 1]));
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

  it('reports a fatal error once and not the kill that follows it', async () => {
    const target = makeTarget('web', 0);
    const pairs = ['first', 'second'].map((name, index) =>
      makePair(makeTest('tests/a.e2e.ts', name, { declarationIndex: index }), target),
    );
    const fleet = new FakeFleet({ fatalOn: ['file::web::tests/a.e2e.ts'] });

    const collected = await run(
      makeSelection([{ target, pairs }]),
      makeCollection(['tests/a.e2e.ts'], pairs),
      fleet,
      { workers: 1 },
    );

    expect(collected.runErrors.map((error) => error.error.message)).toEqual(['engine exploded']);
    expect(collected.results.map((result) => [result.status, result.skip?.cause])).toEqual([
      ['skipped', 'infrastructure-unavailable'],
      ['skipped', 'infrastructure-unavailable'],
    ]);
  });

  it('records a boot failure once, however many workers of the target were still starting', async () => {
    const target = makeTarget('web', 0);
    const pairs = ['a', 'b', 'c', 'd'].map((name) =>
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
      { workers: 4 },
    );

    expect(collected.runErrors.map((error) => error.error.code)).toEqual(['WORKER_INIT_FAILED']);
    expect(collected.results).toHaveLength(4);
    for (const result of collected.results) expect(result.status).toBe('skipped');
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

  it('a forced interrupt tears busy workers down at once instead of waiting out the grace', async () => {
    const target = makeTarget('web', 0);
    const pairs = ['a', 'b'].map((name) => makePair(makeTest(`tests/${name}.e2e.ts`, name), target));
    // Every unit hangs: without the force, the scheduler would wait the whole
    // interrupt grace before killing the worker.
    const fleet = new FakeFleet({ hangOn: ['file::web::tests/a.e2e.ts', 'file::web::tests/b.e2e.ts'] });
    const interrupt = new AbortController();
    const force = new AbortController();
    const timers = [setTimeout(() => interrupt.abort(), 20), setTimeout(() => force.abort(), 40)];

    const started = Date.now();
    const collected = await run(
      makeSelection([{ target, pairs }]),
      makeCollection(pairs.map((pair) => pair.test.file), pairs),
      fleet,
      { workers: 2, interruptSignal: interrupt.signal, forceSignal: force.signal, interruptGraceMs: 30_000 },
    );
    for (const timer of timers) clearTimeout(timer);

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fleet.controlMessages).toContain('interrupt');
    expect(fleet.controlMessages).toContain('terminate');
    // The pairs never reported; a forced exit is the one that was asked for.
    expect(collected.results.map((result) => result.status).toSorted()).toEqual(['skipped', 'skipped']);
    expect(collected.runErrors).toEqual([]);
  });

  it.each([
    { finished: [FAILED_ATTEMPT], status: 'failed' },
    { finished: [FAILED_ATTEMPT, PASSED_RETRY], status: 'flaky' },
  ])('a forced interrupt keeps the attempts a test finished and their retry verdict ($status)', async ({ finished, status }) => {
    const target = makeTarget('web', 0);
    const pairs = [makePair(makeTest('tests/a.e2e.ts', 'a'), target)];
    const fleet = new FakeFleet({ hangOn: ['file::web::tests/a.e2e.ts'], attemptsBeforeHang: finished });
    const interrupt = new AbortController();
    const force = new AbortController();
    const timers = [setTimeout(() => interrupt.abort(), 20), setTimeout(() => force.abort(), 40)];

    const collected = await run(
      makeSelection([{ target, pairs }]),
      makeCollection(['tests/a.e2e.ts'], pairs),
      fleet,
      { workers: 1, interruptSignal: interrupt.signal, forceSignal: force.signal, interruptGraceMs: 30_000 },
    );
    for (const timer of timers) clearTimeout(timer);

    expect(collected.results).toHaveLength(1);
    expect(collected.results[0]!.status).toBe(status);
    expect(collected.results[0]!.attempts).toEqual(finished);
  });

  it.each<{ statuses: ('passed' | 'failed')[][]; verdict: string; results: string[] }>([
    { statuses: [['passed', 'failed']], verdict: 'failed', results: ['passed', 'failed'] },
    { statuses: [['passed', 'failed'], ['passed', 'passed']], verdict: 'flaky', results: ['flaky', 'flaky'] },
  ])('a forced interrupt keeps the group attempts a serial group finished and their retry verdict ($verdict)', async ({ statuses, verdict, results }) => {
    const target = makeTarget('web', 0);
    const pairs = ['step 1', 'step 2'].map((title, declarationIndex) =>
      makePair(makeTest('tests/a.e2e.ts', title, { declarationIndex, serialId: 'tests/a.e2e.ts::wizard' }), target),
    );
    const runs: SerialAttemptRun[] = statuses.map((members, index) => ({
      reachedMembers: true,
      record: {
        id: `group-attempt-${index}`,
        index,
        status: members.includes('failed') ? 'failed' : 'passed',
        startedAt: '2026-01-01T00:00:00.000Z',
        durationMs: 5,
        members: members.map((status, memberIndex) => ({
          id: `group-attempt-${index}:member:${memberIndex}`,
          index: memberIndex,
          testId: pairs[memberIndex]!.test.id,
          status,
          startedAt: '2026-01-01T00:00:00.000Z',
          durationMs: 1,
          steps: [],
          ...(status === 'failed' ? { error: FAILED_ATTEMPT.error! } : {}),
          secondaryErrors: [],
        })),
        artifacts: [],
        ...(members.includes('failed') ? { error: FAILED_ATTEMPT.error! } : {}),
        secondaryErrors: [],
        cleanup: 'complete',
      },
    }));
    const fleet = new FakeFleet({ hangOn: ['file::web::tests/a.e2e.ts'], serialRunsBeforeHang: runs });
    const interrupt = new AbortController();
    const force = new AbortController();
    const timers = [setTimeout(() => interrupt.abort(), 20), setTimeout(() => force.abort(), 40)];

    const collected = await run(
      makeSelection([{ target, pairs }]),
      makeCollection(['tests/a.e2e.ts'], pairs),
      fleet,
      { workers: 1, interruptSignal: interrupt.signal, forceSignal: force.signal, interruptGraceMs: 30_000 },
    );
    for (const timer of timers) clearTimeout(timer);

    expect(collected.serialGroups).toHaveLength(1);
    expect(collected.serialGroups[0]!.status).toBe(verdict);
    expect(collected.serialGroups[0]!.attempts).toEqual(runs.map((entry) => entry.record));
    expect(collected.results.map((result) => result.status)).toEqual(results);
  });

  it('a worker that exits on its own during the interrupt grace crashes the test it was running', async () => {
    const target = makeTarget('web', 0);
    const pairs = [makePair(makeTest('tests/a.e2e.ts', 'a'), target)];
    const fleet = new FakeFleet({
      hangOn: ['file::web::tests/a.e2e.ts'],
      attemptsBeforeHang: [FAILED_ATTEMPT],
      exitDuringNextAttemptOnInterrupt: true,
    });
    const interrupt = new AbortController();
    const timer = setTimeout(() => interrupt.abort(), 20);

    const collected = await run(
      makeSelection([{ target, pairs }]),
      makeCollection(['tests/a.e2e.ts'], pairs),
      fleet,
      { workers: 1, interruptSignal: interrupt.signal, interruptGraceMs: 30_000 },
    );
    clearTimeout(timer);

    expect(collected.runErrors.map((runError) => runError.error.code)).toEqual(['WORKER_EXIT']);
    expect(collected.results).toHaveLength(1);
    expect(collected.results[0]!.status).toBe('failed');
    expect(collected.results[0]!.attempts.map((attempt) => [attempt.index, attempt.error?.code])).toEqual([
      [0, FAILED_ATTEMPT.error!.code],
      [1, 'WORKER_CRASH'],
    ]);
  });

  it('kills a worker that ignores a forced interrupt once the force budget is spent', async () => {
    const target = makeTarget('web', 0);
    const pairs = [makePair(makeTest('tests/a.e2e.ts', 'a'), target)];
    const fleet = new FakeFleet({ hangOn: ['file::web::tests/a.e2e.ts'], ignoreTerminate: true });
    const interrupt = new AbortController();
    const force = new AbortController();
    const timers = [setTimeout(() => interrupt.abort(), 20), setTimeout(() => force.abort(), 40)];

    const started = Date.now();
    const collected = await run(
      makeSelection([{ target, pairs }]),
      makeCollection(['tests/a.e2e.ts'], pairs),
      fleet,
      { workers: 1, interruptSignal: interrupt.signal, forceSignal: force.signal, interruptGraceMs: 30_000, forceGraceMs: 100 },
    );
    for (const timer of timers) clearTimeout(timer);

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fleet.live).toBe(0);
    expect(collected.results.map((result) => result.status)).toEqual(['skipped']);
  });

  it('terminates when interrupted while workers are still starting, reporting each unit once and no init failure', async () => {
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

    expect(fleet.spawned).toHaveLength(2);
    expect(fleet.unitsByWorker.flat()).toHaveLength(0);
    expect(collected.results.map((result) => [result.test.title, result.status, result.skip?.reason]).toSorted()).toEqual([
      ['a', 'skipped', 'run interrupted before execution'],
      ['b', 'skipped', 'run interrupted before execution'],
    ]);
    expect(fleet.interruptSkips).toEqual([undefined, undefined]);
    // Both workers exit before becoming ready, as many as MAX_INIT_FAILURES: exits the interrupt asked for are not init failures.
    expect(collected.runErrors).toEqual([]);
  });

  it('takes workers a Ctrl-C killed while they were still loading for the interrupt it is, not a boot failure', async () => {
    const target = makeTarget('web', 0);
    const pairs = ['a', 'b'].map((name) => makePair(makeTest(`tests/${name}.e2e.ts`, name), target));
    const fleet = new FakeFleet({ signalledInit: { workers: 2, signal: 'SIGINT' } });
    const controller = new AbortController();
    // The runner handles its own SIGINT after the workers' exits reached it.
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

    expect(collected.runErrors).toEqual([]);
    expect(collected.results.map((result) => [result.test.title, result.status, result.skip?.reason]).toSorted()).toEqual([
      ['a', 'skipped', 'run interrupted before execution'],
      ['b', 'skipped', 'run interrupted before execution'],
    ]);
  });

  it('still fails a target whose every worker dies of SIGTERM while loading when no interrupt comes', async () => {
    const target = makeTarget('web', 0);
    const pairs = ['a', 'b'].map((name) => makePair(makeTest(`tests/${name}.e2e.ts`, name), target));
    const fleet = new FakeFleet({ signalledInit: { workers: 50, signal: 'SIGTERM' } });

    const collected = await run(
      makeSelection([{ target, pairs }]),
      makeCollection(
        pairs.map((pair) => pair.test.file),
        pairs,
      ),
      fleet,
      { workers: 2 },
    );

    expect(collected.runErrors.map((error) => error.error.code)).toEqual(['WORKER_INIT_FAILED']);
    expect(collected.results.map((result) => result.status)).toEqual(['skipped', 'skipped']);
    // The two workers alive when the first signal landed are excused; their
    // replacements count, so spawning stops as it does for any boot failure.
    expect(fleet.spawned.length).toBeLessThanOrEqual(5);
  });

  it('a plain interrupt reports the queued units it cancels, so a rerun can pick them up', async () => {
    const target = makeTarget('web', 0);
    const pairs = ['running', 'queued', 'queued-too'].map((name) =>
      makePair(makeTest(`tests/${name}.e2e.ts`, name), target),
    );
    const fleet = new FakeFleet({ hangOn: ['file::web::tests/running.e2e.ts'] });
    const controller = new AbortController();
    // Abort once the single worker is busy with the first unit and the rest waits in the queue.
    const timer = setTimeout(() => controller.abort(), 20);

    const collected = await run(
      makeSelection([{ target, pairs }]),
      makeCollection(
        pairs.map((pair) => pair.test.file),
        pairs,
      ),
      fleet,
      { workers: 1, interruptSignal: controller.signal, interruptGraceMs: 10 },
    );
    clearTimeout(timer);

    expect(fleet.unitsByWorker.flat().map((unit) => unit.unitId)).toEqual(['file::web::tests/running.e2e.ts']);
    expect(collected.results.map((result) => [result.test.title, result.status, result.skip?.cause])).toEqual([
      ['queued', 'skipped', 'infrastructure-unavailable'],
      ['queued-too', 'skipped', 'infrastructure-unavailable'],
      ['running', 'skipped', 'infrastructure-unavailable'],
    ]);
    expect(collected.runErrors).toEqual([]);
  });

  it('reports every pair once when interrupted before it starts, dispatching nothing', async () => {
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
    expect(collected.results.map((result) => [result.test.title, result.status, result.skip?.reason])).toEqual([
      ['a', 'skipped', 'run interrupted before execution'],
      ['b', 'skipped', 'run interrupted before execution'],
    ]);
  });

  it('reports a non-run pair once when the signal is already aborted', async () => {
    const target = makeTarget('web', 0);
    const skipped = makePair(makeTest('tests/a.e2e.ts', 'skipped', { id: 'skip-me' }), target, {
      disposition: 'skip',
      skip: { cause: 'explicit', reason: 'test.skip' },
    });
    const filtered = makePair(makeTest('tests/a.e2e.ts', 'filtered', { id: 'filter-me' }), target, {
      disposition: 'filtered',
      skip: undefined,
    });
    const queued = makePair(makeTest('tests/b.e2e.ts', 'queued'), target);
    const fleet = new FakeFleet();
    const controller = new AbortController();
    controller.abort();

    const collected = await run(
      makeSelection([{ target, pairs: [skipped, filtered, queued] }]),
      makeCollection(['tests/a.e2e.ts', 'tests/b.e2e.ts'], [skipped, filtered, queued]),
      fleet,
      { workers: 2, interruptSignal: controller.signal },
    );

    expect(fleet.spawned).toHaveLength(0);
    expect(collected.results.map((result) => [result.test.id, result.selected, result.status, result.skip])).toEqual([
      ['skip-me', true, 'skipped', { cause: 'explicit', reason: 'test.skip' }],
      ['filter-me', false, 'skipped', { cause: 'filtered', reason: 'not selected' }],
      ['tests/b.e2e.ts::queued', true, 'skipped', { cause: 'infrastructure-unavailable', reason: 'run interrupted before execution' }],
    ]);
    expect(collected.runErrors).toEqual([]);
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

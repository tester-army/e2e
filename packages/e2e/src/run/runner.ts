/** Run orchestration: config, collection, selection, execution, reporting. */

import path from 'node:path';
import { discoverConfig, loadConfigModule, missingConfigError } from '../config/load.ts';
import {
  isCiMode,
  resolveConfig,
  type CliOverrides,
  type ResolvedConfig,
  type ResolvedTarget,
} from '../config/resolve.ts';
import { collect, type Collection } from '../collect/collect.ts';
import { select, selectTargets, type Selection, type SelectionFilters } from '../collect/select.ts';
import {
  classifyError,
  combineExitCodes,
  ConfigurationError,
  E2EError,
  errorMessage,
  exitCodeForCategory,
  serializeError,
  translateProvisioningError,
  type ErrorPhase,
} from '../internal/errors.ts';
import { loadAiSdk } from '../agent/ai-sdk.ts';
import { AiTraceCollector, AiTraceRecorder, registerAiTraceRecorder } from '../internal/ai-trace.ts';
import { DebugTrace } from '../internal/debug.ts';
import { timestamp, uuidv7 } from '../internal/ids.ts';
import { buildReport, describeTarget, type Report1Document, type TargetProvenance } from '../report/build.ts';
import { agentStepTable } from '../report/debug-steps.ts';
import { renderJunitReport } from '../report/junit.ts';
import { ListReporter } from '../report/list.ts';
import { writeJsonReport, writeTextReport } from '../report/write.ts';
import { ManagedProcess, ServiceStack } from './managed-process.ts';
import { createRunEventEmitter, toEventResult, type RunEventSink, type RunExitCode, type RunStatus, type RunEventFact, type SetupStep } from './events.ts';
import { inProcessSpawner } from './in-process.ts';
import type { ResultRecord, RunError, SerialGroupRecord } from './records.ts';
import { runUnits } from './scheduler.ts';
import { buildWorkPlans, plannedSlots, type TargetWorkPlan } from './units.ts';
import { SessionStore } from './sessions.ts';
import { childProcessSpawner } from './worker/handle.ts';
import { setCredentialRegistry } from '../credentials.ts';
import { sleep } from '../internal/time.ts';
import type { BuiltinReporter, E2EConfig, FinishedRun, Reporter, ReporterLinks } from '../types.ts';
import type { ResolvedModel } from '../config/agent.ts';
import { declaredProcesses } from './declared-processes.ts';

export interface RunOptions {
  cwd?: string | undefined;
  configPath?: string | undefined;
  files?: readonly string[] | undefined;
  tags?: readonly string[] | undefined;
  tagMode?: 'any' | 'all' | undefined;
  targetIds?: readonly string[] | undefined;
  headed?: boolean | undefined;
  retries?: number | undefined;
  workers?: number | undefined;
  reporters?: readonly BuiltinReporter[] | undefined;
  artifactsDir?: string | undefined;
  passWithNoTests?: boolean | undefined;
  /** Runs with the trace cache off (`--no-cache`), overriding the config. */
  noCache?: boolean | undefined;
  /** Prints aggregated phase timings to stderr after the run. */
  debug?: boolean | undefined;
  /** Records every model call to `.e2e/ai-trace.json` (`--ai-trace`). */
  aiTrace?: boolean | undefined;
  /**
   * Records a video of every attempt (`--video`), on top of the configured
   * artifact kinds. The engine must be able to record; one that cannot fails
   * the run with `UNSUPPORTED_ARTIFACT` before any test starts.
   */
  video?: boolean | undefined;
  /**
   * A config value instead of a discovered file, for the test harness. May
   * hold live values (executors, engine handles, model instances, cache
   * stores, secret providers), which cannot cross a process boundary, so the
   * run executes in-process on one worker.
   */
  rawConfig?: E2EConfig | undefined;
  /** The environment the run resolves against, instead of `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Suppresses the list reporter. */
  quiet?: boolean | undefined;
  /** Cancellation: the running test ends, its teardown runs, the run finishes as `interrupted`. */
  interruptSignal?: AbortSignal | undefined;
  /**
   * Forced cancellation: every worker disposes its engine at once instead
   * of finishing its test, and is killed after the cleanup budget. Counts as
   * an interrupt on its own. The runner never handles process signals itself;
   * the CLI's Ctrl-C ladder (`cli/signals.ts`) feeds these two.
   */
  forceSignal?: AbortSignal | undefined;
  /** A second sink on the run's event spine, beside the list reporter. */
  onEvent?: RunEventSink | undefined;
  /** Budget for each reporter's `onRunFinished`, in ms; the test harness shortens it. */
  reporterTimeout?: number | undefined;
}

/** How long a reporter's `onRunFinished` may take before the run stops waiting for it. */
const REPORTER_TIMEOUT_MS = 60_000;

/** The selection flags of `run`, without anything that would start a process. */
export type ListOptions = Pick<
  RunOptions,
  'cwd' | 'configPath' | 'files' | 'tags' | 'tagMode' | 'targetIds' | 'passWithNoTests' | 'rawConfig' | 'env'
>;

/** One test-target pair the runner would report, as `e2e list` prints it. */
export interface ListedPair {
  readonly file: string;
  readonly title: string;
  readonly titlePath: readonly string[];
  readonly kind: 'test' | 'setup';
  readonly target: string;
  readonly disposition: 'run' | 'skip';
  readonly skipReason?: string;
}

/**
 * Collects and selects like `run` and stops there: no app process, no engine
 * prepare, no worker. The pairs are the ones `run` would report, in report
 * order; pairs the selection filtered out are left out, as the list reporter
 * leaves them out. Config, collection, and selection failures throw the same
 * classified error `run` would record.
 */
export async function list(options: ListOptions = {}): Promise<{ pairs: ListedPair[] }> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const config = await loadRunConfig(options, cwd, env, {});
  const collection = await collect(config, options.files);
  const selection = select(
    collection,
    config,
    selectionFilters(options),
    options.passWithNoTests !== undefined ? { passWithNoTests: options.passWithNoTests } : {},
  );
  const pairs: ListedPair[] = [];
  for (const pair of selection.pairs) {
    if (pair.disposition === 'filtered') continue;
    pairs.push({
      file: pair.test.file,
      title: pair.test.title,
      titlePath: pair.test.titlePath,
      kind: pair.test.kind,
      target: pair.target.name,
      disposition: pair.disposition,
      ...(pair.skip === undefined ? {} : { skipReason: pair.skip.reason }),
    });
  }
  return { pairs };
}

export interface RunOutcome {
  exitCode: RunExitCode;
  /** The same status `report.run.status` and the `run-finished` event carry. */
  status: RunStatus;
  report: Report1Document;
  reportPath: string | undefined;
  /** Where the JUnit XML was written; undefined unless the `junit` reporter was selected. */
  junitPath: string | undefined;
  /** Where the AI trace was written; undefined unless `aiTrace` was requested. */
  aiTracePath: string | undefined;
  results: readonly ResultRecord[];
}

/**
 * Added to the cleanup budget before a force-terminated worker is killed: its
 * own disposal is bounded by that budget, and the margin lets a worker that
 * used all of it still report and exit before the kill lands.
 */
const FORCE_KILL_MARGIN_MS = 1_000;

/** Executes one complete run and returns the outcome without exiting. */
export async function run(options: RunOptions = {}): Promise<RunOutcome> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const runId = uuidv7();
  /**
   * When the run began executing: taken again right before `plan`, once
   * collection and provisioning are done, so a first-run download is never
   * part of the reported span. A run that fails before then keeps its launch
   * time, and the span is the time it took to fail.
   */
  let startedAt = timestamp();
  const debug = new DebugTrace(options.debug === true);
  const aiTrace = options.aiTrace === true ? new AiTraceCollector() : undefined;
  /** The in-process recorder; child-process workers own their own. */
  let aiTraceRecorder: AiTraceRecorder | undefined;
  const interruptController = new AbortController();
  const forceController = new AbortController();
  const runErrors: RunError[] = [];
  const results: ResultRecord[] = [];
  const serialGroups: SerialGroupRecord[] = [];
  const targetProvenance = new Map<string, TargetProvenance>();
  /** Dependency processes declared by the targets' engines, deduplicated, started before any app command. */
  let services: ServiceStack | undefined;
  /** App processes started for this run, one per distinct declared command. */
  const appProcesses: ManagedProcess[] = [];
  let sessionStore: SessionStore | undefined;

  // Hoisted: workers re-resolve the same config file and need these overrides,
  // or a flag would apply in the runner and be dropped in every worker.
  const cli: CliOverrides = {};
  if (options.retries !== undefined) cli.retries = options.retries;
  if (options.workers !== undefined) cli.workers = options.workers;
  if (options.reporters !== undefined) cli.reporters = options.reporters;
  if (options.noCache === true) cli.cache = 'off';
  if (options.video === true) cli.video = true;

  // Config resolves before anything is emitted, and its failure is kept rather
  // than thrown: the reporter set is config truth (CLI overrides merge during
  // resolution), so the emitter below is built exactly once from the set
  // actually in force. When config itself failed, the CLI's own value is the
  // best available, and the failure still renders through it.
  const loaded = await debug.time('config.load', () => loadRunConfig(options, cwd, env, cli)).then(
    (config) => ({ config, error: undefined }),
    (cause: unknown) => ({ config: undefined, error: classifyError(cause) }),
  );

  // The event stream is the run's single spine: the list reporter is one sink
  // on it, beside every reporter object's `onEvent`, so every consumer sees
  // the same story.
  const reporters = loaded.config?.reporters ?? options.reporters ?? ['list'];
  const customReporters = loaded.config?.customReporters ?? [];
  const listReporter =
    options.quiet === true || !reporters.includes('list') ? undefined : new ListReporter();
  const emit = createRunEventEmitter([
    listReporter?.handle,
    ...customReporters.map((reporter) =>
      reporter.onEvent === undefined ? undefined : reporter.onEvent.bind(reporter),
    ),
    options.onEvent,
  ]);
  const jsonReport = reporters.includes('json');
  const junitReport = reporters.includes('junit');

  /** Records one run-level error once: into the report and onto the stream. */
  const recordRunError = (runError: RunError): void => {
    runErrors.push(runError);
    emit({ type: 'run-error', error: runError.error });
  };

  /** Records a failure of the run itself, outside any test. */
  const recordFailure = (cause: unknown, phase?: ErrorPhase): void => {
    recordRunError({ error: serializeError(classifyError(cause), phase === undefined ? {} : { phase }) });
  };

  /**
   * A worker's run-level configuration failure stops the run through the
   * interrupt signal, recorded once: workers that meet the same failure in
   * parallel report the one already on the way out. The work it cuts short is
   * interrupted, but the run is not: its exit code is the error's, not 130.
   */
  let runAborted = false;
  const abortRun = (runError: RunError): void => {
    if (runAborted) return;
    runAborted = true;
    recordRunError(runError);
    interruptController.abort();
  };

  /**
   * The exit code is a fold over run state — every result, every run error,
   * the interrupt — never threaded through by hand. A run error recorded
   * anywhere, including during teardown or the report write, reaches the exit
   * code the same way.
   */
  const currentExitCode = (): RunExitCode =>
    combineExitCodes(
      [
        ...resultExitCodes(results),
        ...runErrors.map((runError) => exitCodeForCategory(runError.error.category)),
        ...(interruptController.signal.aborted ? [130] : []),
      ].filter((code) => code !== 130 || !runAborted),
    );

  const buildRunReport = (exitCode: RunExitCode): Report1Document =>
    buildReport({
      runId,
      config: loaded.config,
      startedAt,
      status: statusOf(exitCode),
      exitCode,
      results,
      serialGroups,
      runErrors,
      targetProvenance,
    });

  /**
   * Writes the canonical report and returns its path only once the file
   * exists: a host must never be handed a path to a report that was not
   * written. A lost canonical report is an infrastructure run error, not a
   * footnote: recorded like any other, it reaches the exit code, and the
   * returned in-memory document becomes the only complete record. The file
   * is not retried — the destination just failed.
   */
  const writeCanonicalReport = async (config: ResolvedConfig, document: Report1Document): Promise<string | undefined> => {
    const target = path.join(path.dirname(resolveArtifactsRoot(config, options.artifactsDir)), 'report.json');
    try {
      await writeJsonReport(target, document);
      return target;
    } catch (cause) {
      recordFailure(
        new E2EError(
          'infrastructure',
          'REPORT_WRITE_FAILED',
          `the canonical report could not be written: ${errorMessage(cause)}`,
          { cause },
        ),
        'report',
      );
      return undefined;
    }
  };

  /**
   * Writes the JUnit rendering of one document next to the canonical report.
   * Same terms: the path is returned only once the file exists, and a lost
   * file is a recorded run error.
   */
  const writeJunitReport = async (config: ResolvedConfig, document: Report1Document): Promise<string | undefined> => {
    if (!junitReport) return undefined;
    const target = path.join(path.dirname(resolveArtifactsRoot(config, options.artifactsDir)), 'junit.xml');
    try {
      await writeTextReport(target, renderJunitReport(document));
      return target;
    } catch (cause) {
      recordFailure(
        new E2EError(
          'infrastructure',
          'REPORT_WRITE_FAILED',
          `the JUnit report could not be written: ${errorMessage(cause)}`,
          { cause },
        ),
        'report',
      );
      return undefined;
    }
  };

  /**
   * Writes the AI trace next to the report, on the same terms: the path is
   * returned only once the file exists, and a lost trace is a recorded run
   * error. The in-process recorder is drained here; child-process workers
   * already shipped theirs over the worker channel.
   */
  const writeAiTrace = async (config: ResolvedConfig): Promise<string | undefined> => {
    if (aiTrace === undefined) return undefined;
    if (aiTraceRecorder !== undefined) {
      aiTrace.merge(aiTraceRecorder.drain({ all: true }));
      aiTraceRecorder.dispose();
      aiTraceRecorder = undefined;
    }
    const target = path.join(path.dirname(resolveArtifactsRoot(config, options.artifactsDir)), 'ai-trace.json');
    try {
      await writeJsonReport(target, aiTrace.document());
      return target;
    } catch (cause) {
      recordFailure(
        new E2EError(
          'infrastructure',
          'REPORT_WRITE_FAILED',
          `the AI trace could not be written: ${errorMessage(cause)}`,
          { cause },
        ),
        'report',
      );
      return undefined;
    }
  };

  const finish = async (): Promise<RunOutcome> => {
    const aiTracePath = loaded.config === undefined ? undefined : await writeAiTrace(loaded.config);
    let reportPath: string | undefined;
    let junitPath: string | undefined;
    if (loaded.config !== undefined) {
      // The JUnit rendering goes first, from the document as it stands, and
      // the canonical report is written once, last: a lost junit.xml is then
      // recorded before report.json exists, so the failure lands in the file,
      // the exit code, the outcome, and run-finished alike. When the rendering
      // succeeds nothing was recorded in between, and the canonical report is
      // that very document.
      const document = buildRunReport(currentExitCode());
      const recorded = runErrors.length;
      junitPath = await writeJunitReport(loaded.config, document);
      reportPath = await writeCanonicalReport(
        loaded.config,
        runErrors.length === recorded ? document : buildRunReport(currentExitCode()),
      );
    }
    const exitCode = currentExitCode();
    const report = buildRunReport(exitCode);
    // Read back from the report rather than recomputed: the report derives
    // `blocked` from the results, and the outcome and the event must agree
    // with the file a host reads afterwards.
    const status = report.run.status;
    setCredentialRegistry(undefined);
    emit({
      type: 'run-finished',
      status,
      exitCode,
      ...(reportPath === undefined ? {} : { reportPath }),
      ...(junitPath === undefined ? {} : { junitPath }),
      ...(aiTracePath === undefined ? {} : { aiTracePath }),
    });
    // Reporters run after the summary, so the terminal never waits on an
    // upload, and their links print under it. Only a loaded config has any:
    // a config failure ran nothing they could report.
    if (loaded.config !== undefined && customReporters.length > 0) {
      const links = await runReporters(customReporters, {
        report,
        status,
        exitCode,
        reportPath,
        artifactsRoot: resolveArtifactsRoot(loaded.config, options.artifactsDir),
        junitPath,
        aiTracePath,
      }, options.reporterTimeout ?? REPORTER_TIMEOUT_MS);
      listReporter?.links(links);
    }
    if (jsonReport) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    if (debug.enabled) {
      process.stderr.write(debug.summary());
      process.stderr.write(agentStepTable(results, serialGroups));
    }
    return { exitCode, status, report, reportPath, junitPath, aiTracePath, results };
  };

  if (loaded.config === undefined) {
    recordFailure(loaded.error, 'config');
    return finish();
  }
  const config = loaded.config;

  setCredentialRegistry(config.credentials);
  emit({
    type: 'run-started',
    runId,
    projectId: config.projectId,
    projectRoot: config.projectRoot,
    artifactsRoot: resolveArtifactsRoot(config, options.artifactsDir),
    ci: isCiMode(env),
    targets: config.targets.map((target) => target.name),
    ...(config.agent.model === undefined ? {} : { model: modelName(config.agent.model) }),
    ...(config.agent.visionModel === undefined ? {} : { visionModel: modelName(config.agent.visionModel) }),
  });

  const executeRun = async (): Promise<void> => {
    const interrupted = interruptController.signal;
    // A run cancelled before it began collects nothing: the interrupt alone
    // decides the outcome.
    if (interrupted.aborted) return;

    // Which targets the run is for, settled before anything is collected,
    // downloaded, or started: an unknown --target is a collection failure.
    let targets: readonly ResolvedTarget[];
    try {
      targets = selectTargets(config.targets, options.targetIds);
    } catch (cause) {
      recordFailure(cause, 'collection');
      return;
    }

    // Each selected engine declares the app it drives: the dependency
    // processes it needs and the command that starts it. Declarations are
    // deduplicated across targets (two browsers on one dev server share one
    // process) and checked for consistency here, first; the processes start
    // only after the plan, and only for the selected targets.
    const declared = declaredProcesses(targets);

    /**
     * Narrates and times one setup step on the event spine. A step that
     * throws ends as a run error, and a step the interrupt cut short reports
     * nothing more; either way no `finished` follows.
     */
    const setupStep = async <T>(step: SetupStep, work: () => Promise<T>): Promise<T> => {
      emit({ type: 'setup', step, state: 'started' });
      const startedMs = Date.now();
      const result = await work();
      if (!interrupted.aborted) emit({ type: 'setup', step, state: 'finished', durationMs: Date.now() - startedMs });
      return result;
    };

    // Collection comes first and starts no process: a collection failure or
    // NO_TESTS is reported before any dev server boots or browser downloads.
    let planned: { collection: Collection; selection: Selection };
    try {
      planned = await setupStep({ kind: 'collect' }, () =>
        debug.time('collect', async () => {
          const collection = await collect(config, options.files);
          const selection = select(
            collection,
            config,
            selectionFilters(options),
            options.passWithNoTests !== undefined ? { passWithNoTests: options.passWithNoTests } : {},
          );
          return { collection, selection };
        }),
      );
    } catch (cause) {
      recordFailure(cause, 'collection');
      return;
    }
    const { collection, selection } = planned;

    // Pre-flight: grade every selected target from its engine declaration
    // before any worker starts, so a config that asks for more than the
    // engine offers fails here, once, instead of inside a launch budget.
    for (const { target } of selection.perTarget) {
      targetProvenance.set(target.name, validateEngine(target, config));
    }

    // The work units, built once: the same plans tell each engine's `prepare`
    // how many worker slots to provision and the scheduler what to dispatch.
    const plans = buildWorkPlans(selection, collection, config.projectRoot);
    // Workers re-load the config module themselves, so a file-backed config
    // runs across processes. A supplied `rawConfig` cannot cross a process
    // boundary (it may hold live engine handles), so it runs in-process
    // against one worker.
    const runWorkers = config.configPath === undefined ? 1 : config.workers;

    // Provisioning: an engine that must fetch something onto this machine (a
    // first-run browser download) does it here, once per target, before the
    // app starts and before the run's clock starts. Only an interrupt cuts it
    // short. Each target is one setup step, and the engine's progress lines
    // stream as `notice` events under it, so the reporter prints them instead
    // of a worker's stderr fighting the live status block.
    try {
      await debug.time('engine.prepare', () =>
        prepareEngines(plans, runWorkers, { runId, env, signal: interrupted }, emit),
      );
    } catch (cause) {
      if (!interrupted.aborted) recordFailure(cause, 'launch');
      return;
    }
    if (interrupted.aborted) return;

    // The run's clock starts here, once collection and provisioning are done.
    // `plan` marks the moment and the report's `startedAt` agrees with it, so
    // everything a run pays for every time (the app, the tests, the report)
    // is on the clock and a one-off download is not.
    startedAt = timestamp();
    emit({ type: 'plan', total: selection.pairs.length, files: plannedFiles(selection) });

    // Every service is ready before the first app command starts. Nothing
    // spawns once the run was interrupted. Each process is one setup step; a
    // reused process or an ignored `reuseExisting` narrates as a run notice.
    const processHooks = (kind: 'service' | 'app') => ({
      ci: isCiMode(env),
      notice: (message: string) => emit({ type: 'notice', target: 'app', message }),
      starting: (label: string) => emit({ type: 'setup', step: { kind, label }, state: 'started' }),
      ready: (label: string, durationMs: number, reused: boolean) =>
        emit({
          type: 'setup',
          step: { kind, label },
          state: 'finished',
          durationMs,
          ...(reused ? { outcome: 'reused' as const } : {}),
        }),
    });
    if (declared.services.length > 0) {
      const stack = new ServiceStack(declared.services, config.projectRoot, processHooks('service'));
      services = stack;
      await debug.time('app.services.start', () => stack.start(interrupted));
      if (interrupted.aborted) return;
    }
    for (const { label, command, readyUrl } of declared.commands) {
      const app = new ManagedProcess(label, command, config.projectRoot, { readyUrl }, processHooks('app'));
      appProcesses.push(app);
      await debug.time(`app.start(${label})`, () => app.start(interrupted));
      if (interrupted.aborted) return;
    }
    // A run cancelled while the app was starting runs no test: the interrupt
    // alone decides the outcome.
    if (interrupted.aborted) return;

    const artifactsRoot = resolveArtifactsRoot(config, options.artifactsDir);
    const sessionsRoot = path.join(config.projectRoot, '.e2e', 'sessions');
    const store = SessionStore.create(runId, sessionsRoot);
    sessionStore = store;

    // Both transports are reached through `SpawnUnitRunner`: the scheduler is
    // the only engine either way.
    if (aiTrace !== undefined && config.configPath === undefined) {
      // In-process execution shares this process with the runner, so the
      // recorder lives here and is drained straight into the collector.
      aiTraceRecorder = new AiTraceRecorder();
      await registerAiTraceRecorder(aiTraceRecorder, loadAiSdk);
    }
    const spawn =
      config.configPath === undefined
        ? inProcessSpawner({
            config,
            selection,
            runId,
            artifactsRoot,
            sessionStore: store,
            headed: options.headed ?? false,
            debug,
          })
        : childProcessSpawner({
            configPath: config.configPath,
            projectRoot: config.projectRoot,
            configDigest: config.configDigest,
            cli,
            runId,
            artifactsRoot,
            headed: options.headed ?? false,
            sessionsRoot,
            sessionKeyBase64: store.exportKeyForWorker(),
            debug: debug.enabled,
            aiTrace: aiTrace !== undefined,
            env,
          });

    await debug.time('scheduler', () =>
      runUnits({
        plans,
        workers: runWorkers,
        spawn,
        interruptGraceMs: config.timeout + config.cleanupTimeout,
        interruptSignal: interrupted,
        forceSignal: forceController.signal,
        forceGraceMs: config.cleanupTimeout + FORCE_KILL_MARGIN_MS,
        events: {
          onResult: (result) => {
            results.push(result);
            emit({ type: 'test-finished', result: toEventResult(result) });
          },
          onSerialGroup: (group) => {
            serialGroups.push(group);
            emit({ type: 'serial-group', group });
          },
          onRunError: recordRunError,
          onRunAbort: abortRun,
          onTestStart: (start, targetName) =>
            emit({ type: 'test-started', ...start, target: targetName }),
          onProgress: (testId, targetName, progress) =>
            emit({ type: 'step', testId, target: targetName, progress }),
          onDebug: (snapshot) => debug.merge(snapshot),
          onAiTrace: (snapshot) => aiTrace?.merge(snapshot),
        },
      }),
    );
  };

  // The interrupt bridge is armed for the whole body — app startup, collection,
  // scheduling, teardown, the report — so a host's cancellation lands wherever
  // the run is, not only once the scheduler happens to be running. From here
  // the run owns external resources. Failures anywhere are recorded, never
  // thrown — the outcome must survive its own execution and its own cleanup —
  // and teardown always runs before the terminal `run-finished`, so that
  // event means the app process, its services, and the session store are
  // gone. A forced interrupt is also an interrupt; that is enforced here,
  // once, so the scheduler can take it for granted.
  const interrupt = (mode: 'graceful' | 'forced'): void => {
    if (mode === 'forced') interrupt('graceful');
    const controller = mode === 'graceful' ? interruptController : forceController;
    if (controller.signal.aborted) return;
    controller.abort();
    emit({ type: 'run-interrupted', mode });
  };
  const bridges = (
    [
      [options.interruptSignal, 'graceful'],
      [options.forceSignal, 'forced'],
    ] as const
  ).map(([signal, mode]) => {
    const onAbort = (): void => interrupt(mode);
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    return () => signal?.removeEventListener('abort', onAbort);
  });
  try {
    try {
      await executeRun();
    } catch (cause) {
      recordFailure(cause);
    }
    // Services go down after the apps that depended on them; a failing service
    // teardown command is a cleanup error of the run, not a crash.
    for (const teardown of [
      () => sessionStore?.cleanup(),
      ...appProcesses.map((app) => () => app.stop()),
      () => services?.stop((cause) => recordFailure(cause, 'cleanup')),
    ]) {
      try {
        await teardown();
      } catch (cause) {
        recordFailure(cause);
      }
    }
    return await finish();
  } finally {
    for (const release of bridges) release();
  }
}

/**
 * Runs each target's `prepare` hook in turn, before `plan` is emitted and the
 * run's clock starts, each as one `setup` step with the hook's progress lines
 * streaming as `notice` events under it. Sequential on purpose: two engines
 * provisioning the same toolchain would race, and the notices of one download
 * read better than two interleaved.
 */
async function prepareEngines(
  plans: readonly TargetWorkPlan[],
  runWorkers: number,
  scope: { runId: string; env: NodeJS.ProcessEnv; signal: AbortSignal },
  emit: (fact: RunEventFact) => void,
): Promise<void> {
  for (const plan of plans) {
    const { target } = plan;
    const engine = target.engine;
    if (engine?.prepare === undefined) continue;
    if (scope.signal.aborted) return;
    const step: SetupStep = { kind: 'prepare', target: target.name, engine: engine.name };
    emit({ type: 'setup', step, state: 'started' });
    const startedMs = Date.now();
    try {
      // The same `env` the workers are started with: what prepare provisions
      // must be where a worker's launch will look for it.
      await engine.prepare({
        runId: scope.runId,
        targetName: target.name,
        slots: plannedSlots(plan, runWorkers),
        env: scope.env,
        signal: scope.signal,
        log: (line) => emit({ type: 'notice', target: target.name, message: line }),
      });
    } catch (cause) {
      throw translateProvisioningError(cause, ` while preparing engine ${engine.name} for target "${target.name}"`);
    }
    if (!scope.signal.aborted) {
      emit({ type: 'setup', step, state: 'finished', durationMs: Date.now() - startedMs });
    }
  }
}

/** A configured model as `run-started` and the reporter name it. */
function modelName(model: ResolvedModel): string {
  return `${model.provider}/${model.id}`;
}

function selectionFilters(options: ListOptions): SelectionFilters {
  return {
    ...(options.tags !== undefined ? { tags: options.tags } : {}),
    ...(options.tagMode !== undefined ? { tagMode: options.tagMode } : {}),
    ...(options.targetIds !== undefined ? { targetIds: options.targetIds } : {}),
  };
}

/** Resolves the run's config: a supplied value, or the discovered file. */
async function loadRunConfig(
  options: ListOptions,
  cwd: string,
  env: NodeJS.ProcessEnv,
  cli: CliOverrides,
): Promise<ResolvedConfig> {
  if (options.rawConfig !== undefined) {
    return resolveConfig(options.rawConfig, { projectRoot: cwd, env, cli });
  }
  const discovered = discoverConfig(cwd, options.configPath);
  // A run with no config file has nothing to run against: `targets` is
  // required, so resolving an empty config would only report that symptom.
  if (discovered.configPath === undefined) throw missingConfigError(cwd);
  const raw = await loadConfigModule(discovered.configPath);
  return resolveConfig(raw, {
    projectRoot: discovered.projectRoot,
    configPath: discovered.configPath,
    env,
    cli,
  });
}

/**
 * The plan's per-file breakdown: reportable pairs (run or explicitly skipped)
 * counted per test file and target, in selection order. Unselected pairs are
 * left out: the list reporter never shows them, so counting them would keep
 * a file's block waiting for results that never print.
 */
function plannedFiles(selection: Selection): { file: string; target: string; tests: number }[] {
  const files = new Map<string, { file: string; target: string; tests: number }>();
  for (const pair of selection.pairs) {
    if (pair.disposition === 'filtered') continue;
    const key = `${pair.target.name}\u0000${pair.test.file}`;
    const entry = files.get(key);
    if (entry === undefined) {
      files.set(key, { file: pair.test.file, target: pair.target.name, tests: 1 });
    } else {
      entry.tests += 1;
    }
  }
  return [...files.values()];
}

/** The exit-code status the report builder starts from; `blocked` is derived from the results there. */
function statusOf(exitCode: RunExitCode): Exclude<RunStatus, 'blocked'> {
  return exitCode === 0 ? 'passed' : exitCode === 1 ? 'failed' : exitCode === 130 ? 'interrupted' : 'error';
}

/**
 * Grades one target from its engine declaration and validates the configured
 * artifacts against it; returns the report provenance.
 */
function validateEngine(target: ResolvedTarget, config: ResolvedConfig): TargetProvenance {
  const provenance = describeTarget(target);
  // A best-effort kind is captured when the engine can; a required one is a
  // contract the engine must be able to honour before any test starts.
  for (const [artifact, policy] of config.artifacts) {
    if (policy === 'required' && !provenance.artifactCapabilities.includes(artifact)) {
      throw new ConfigurationError(
        'UNSUPPORTED_ARTIFACT',
        `target "${target.name}" (engine ${provenance.engine.name}) does not support the configured "${artifact}" artifact`,
      );
    }
  }
  return provenance;
}

function resultExitCodes(results: readonly ResultRecord[]): number[] {
  const codes: number[] = [0];
  for (const result of results) {
    switch (result.status) {
      case 'failed':
      case 'timed-out':
        codes.push(1);
        for (const attempt of result.attempts) {
          if (attempt.error !== undefined) codes.push(exitCodeForCategory(attempt.error.category));
        }
        break;
      case 'interrupted':
        codes.push(130);
        break;
      default:
        break;
    }
  }
  return codes;
}

const REPORTER_TIMED_OUT = Symbol('reporter timed out');

/**
 * Awaits every reporter's `onRunFinished` at once, each within `timeoutMs`,
 * and collects the links they resolve with. A reporter that throws or runs
 * out of time is one line on stderr; it can never change the run's outcome.
 */
async function runReporters(
  reporters: readonly Reporter[],
  finished: FinishedRun,
  timeoutMs: number,
): Promise<ReporterLinks> {
  const warn = (reporter: Reporter, detail: string): void => {
    process.stderr.write(`e2e: reporter "${reporter.name}" ${detail}\n`);
  };
  const outcomes = await Promise.all(
    reporters.map(async (reporter): Promise<ReporterLinks> => {
      if (reporter.onRunFinished === undefined) return [];
      const timer = new AbortController();
      try {
        const result = await Promise.race([
          reporter.onRunFinished(finished),
          // Rejects when aborted below, which is how the pending timer is cleared.
          sleep(timeoutMs, timer.signal).then(
            (): typeof REPORTER_TIMED_OUT => REPORTER_TIMED_OUT,
            (): undefined => undefined,
          ),
        ]);
        if (result === REPORTER_TIMED_OUT) {
          warn(reporter, `did not finish within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`}`);
          return [];
        }
        return result ?? [];
      } catch (cause) {
        warn(reporter, `failed: ${errorMessage(cause)}`);
        return [];
      } finally {
        timer.abort();
      }
    }),
  );
  return outcomes.flat();
}

function resolveArtifactsRoot(config: ResolvedConfig, override: string | undefined): string {
  if (override !== undefined) return path.resolve(config.projectRoot, override);
  return path.join(config.projectRoot, '.e2e', 'artifacts');
}

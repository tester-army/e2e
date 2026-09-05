/** Run orchestration: config, collection, selection, execution, reporting. */

import path from 'node:path';
import { discoverConfig, loadConfigModule } from '../config/load.ts';
import {
  isCiMode,
  resolveConfig,
  type CliOverrides,
  type ResolvedConfig,
  type ResolvedTarget,
} from '../config/resolve.ts';
import { collect, type Collection } from '../collect/collect.ts';
import { select, type Selection, type SelectionFilters } from '../collect/select.ts';
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
import { FailureAnalysisRunner } from '../analysis/run.ts';
import { AiTraceCollector, AiTraceRecorder, registerAiTraceRecorder } from '../internal/ai-trace.ts';
import { DebugTrace } from '../internal/debug.ts';
import { timestamp, uuidv7 } from '../internal/ids.ts';
import { buildReport, describeTarget, type Report1Document, type TargetProvenance } from '../report/build.ts';
import { agentStepTable } from '../report/debug-steps.ts';
import { ListReporter } from '../report/list.ts';
import { writeJsonReport } from '../report/write.ts';
import { AppProcess } from './app-process.ts';
import { createRunEventEmitter, toEventResult, type RunEventSink, type RunExitCode } from './events.ts';
import { inProcessSpawner } from './in-process.ts';
import type { ResultRecord, RunError, SerialGroupRecord } from './records.ts';
import { runUnits } from './scheduler.ts';
import { SessionStore } from './sessions.ts';
import { childProcessSpawner } from './worker/handle.ts';
import { setCredentialRegistry } from '../credentials.ts';
import type { E2EConfig } from '../types.ts';

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
  reporters?: readonly ('list' | 'json')[] | undefined;
  artifactsDir?: string | undefined;
  passWithNoTests?: boolean | undefined;
  /** Runs with the trace cache off (`--no-cache`), overriding the config. */
  noCache?: boolean | undefined;
  /** Prints aggregated phase timings to stderr after the run. */
  debug?: boolean | undefined;
  /** Records every model call to `.e2e/ai-trace.json` (`--ai-trace`). */
  aiTrace?: boolean | undefined;
  /** Enables post-failure analysis with defaults when the config has no `analysis` block (`--analyze`). */
  analyze?: boolean | undefined;
  /**
   * A config value instead of a discovered file — the embedding-host entry
   * point (see the embedding guide). May hold live values (executors, driver
   * handles, model instances, cache stores, secret providers), which cannot
   * cross a process boundary, so the run executes in-process on one worker.
   */
  rawConfig?: E2EConfig | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  quiet?: boolean | undefined;
  /** Cancellation: the running test ends, its teardown runs, the run finishes as `interrupted`. */
  interruptSignal?: AbortSignal | undefined;
  /**
   * Forced cancellation: every worker disposes its backend at once instead
   * of finishing its test, and is killed after the cleanup budget. Counts as
   * an interrupt on its own. The runner never handles process signals itself;
   * the CLI's Ctrl-C ladder (`cli/signals.ts`) feeds these two.
   */
  forceSignal?: AbortSignal | undefined;
  /** Structured, JSON-serializable run events for embedding hosts. */
  onEvent?: RunEventSink | undefined;
}

export interface RunOutcome {
  exitCode: RunExitCode;
  status: 'passed' | 'failed' | 'error' | 'interrupted';
  report: Report1Document;
  reportPath: string | undefined;
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
  const startedAt = timestamp();
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
  let appProcess: AppProcess | undefined;
  let sessionStore: SessionStore | undefined;
  let analysis: FailureAnalysisRunner | undefined;

  /**
   * The in-process AI trace recorder, registered once. In-process execution
   * needs it for the tests' own calls; post-failure analysis needs it in the
   * runner process whichever transport ran the tests.
   */
  const ensureAiTraceRecorder = async (): Promise<void> => {
    if (aiTrace === undefined || aiTraceRecorder !== undefined) return;
    aiTraceRecorder = new AiTraceRecorder();
    await registerAiTraceRecorder(aiTraceRecorder, loadAiSdk);
  };

  // Hoisted: workers re-resolve the same config file and need these overrides,
  // or a flag would apply in the runner and be dropped in every worker.
  const cli: CliOverrides = {};
  if (options.retries !== undefined) cli.retries = options.retries;
  if (options.workers !== undefined) cli.workers = options.workers;
  if (options.reporters !== undefined) cli.reporters = options.reporters;
  if (options.noCache === true) cli.cache = 'off';
  if (options.analyze === true) cli.analyze = true;

  // Config resolves before anything is emitted, and its failure is kept rather
  // than thrown: the reporter set is config truth (CLI overrides merge during
  // resolution), so the emitter below is built exactly once from the set
  // actually in force. When config itself failed, the CLI's own value is the
  // best available, and the failure still renders through it.
  const loaded = await debug.time('config.load', () => loadRunConfig(options, cwd, env, cli)).then(
    (config) => ({ config, error: undefined }),
    (cause: unknown) => ({ config: undefined, error: classifyError(cause) }),
  );

  // The event stream is the run's single spine: the list reporter is just one
  // sink on it, beside the host's, so the CLI and a host can never see
  // different stories.
  const reporters = loaded.config?.reporters ?? options.reporters ?? ['list'];
  const emit = createRunEventEmitter([
    options.quiet === true || reporters.includes('json') ? undefined : new ListReporter().handle,
    options.onEvent,
  ]);
  const jsonReport = reporters.includes('json');

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
   * The exit code is a fold over run state — every result, every run error,
   * the interrupt — never threaded through by hand. A run error recorded
   * anywhere, including during teardown or the report write, reaches the exit
   * code the same way.
   */
  const currentExitCode = (): RunExitCode =>
    combineExitCodes([
      ...resultExitCodes(results),
      ...runErrors.map((runError) => exitCodeForCategory(runError.error.category)),
      ...(interruptController.signal.aborted ? [130] : []),
    ]);

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
  const writeCanonicalReport = async (config: ResolvedConfig): Promise<string | undefined> => {
    const target = path.join(path.dirname(resolveArtifactsRoot(config, options.artifactsDir)), 'report.json');
    try {
      await writeJsonReport(target, buildRunReport(currentExitCode()));
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
    const reportPath = loaded.config === undefined ? undefined : await writeCanonicalReport(loaded.config);
    const exitCode = currentExitCode();
    const status = statusOf(exitCode);
    const report = buildRunReport(exitCode);
    setCredentialRegistry(undefined);
    emit({
      type: 'run-finished',
      status,
      exitCode,
      ...(reportPath === undefined ? {} : { reportPath }),
      ...(aiTracePath === undefined ? {} : { aiTracePath }),
    });
    if (jsonReport) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    if (debug.enabled) {
      process.stderr.write(debug.summary());
      process.stderr.write(agentStepTable(results, serialGroups));
    }
    return { exitCode, status, report, reportPath, aiTracePath, results };
  };

  if (loaded.config === undefined) {
    recordFailure(loaded.error, 'config');
    return finish();
  }
  const config = loaded.config;

  setCredentialRegistry(config.credentials);
  if (config.analysis !== undefined) {
    analysis = new FailureAnalysisRunner({
      config,
      artifactsRoot: resolveArtifactsRoot(config, options.artifactsDir),
      interruptSignal: interruptController.signal,
      emit,
      debug,
    });
    await ensureAiTraceRecorder();
  }
  emit({
    type: 'run-started',
    runId,
    projectId: config.projectId,
    projectRoot: config.projectRoot,
    ci: isCiMode(env),
    targets: config.targets.map((target) => target.name),
  });

  const executeRun = async (): Promise<void> => {
    const interrupted = interruptController.signal;
    if (config.app.command !== undefined) {
      const app = new AppProcess(config.app.command, config.projectRoot, config.app.readyUrl);
      appProcess = app;
      await debug.time('app.start', () => app.start(interrupted));
    }
    // A run cancelled before any test could start collects nothing: the
    // interrupt alone decides the outcome.
    if (interrupted.aborted) return;

    let planned: { collection: Collection; selection: Selection };
    try {
      planned = await debug.time('collect', async () => {
        const collection = await collect(config, options.files);
        const filters: SelectionFilters = {
          ...(options.tags !== undefined ? { tags: options.tags } : {}),
          ...(options.tagMode !== undefined ? { tagMode: options.tagMode } : {}),
          ...(options.targetIds !== undefined ? { targetIds: options.targetIds } : {}),
        };
        const selection = select(
          collection,
          config,
          filters,
          options.passWithNoTests !== undefined ? { passWithNoTests: options.passWithNoTests } : {},
        );
        return { collection, selection };
      });
    } catch (cause) {
      recordFailure(cause, 'collection');
      return;
    }
    const { collection, selection } = planned;

    emit({ type: 'plan', total: selection.pairs.length });

    const artifactsRoot = resolveArtifactsRoot(config, options.artifactsDir);
    const sessionsRoot = path.join(config.projectRoot, '.e2e', 'sessions');
    const store = SessionStore.create(runId, sessionsRoot);
    sessionStore = store;

    // Pre-flight: grade every selected target from its backend declaration
    // before any worker starts, so a config that asks for more than the
    // backend offers fails here, once, instead of inside a launch budget.
    for (const { target } of selection.perTarget) {
      targetProvenance.set(target.name, validateBackend(target, config));
    }

    // Provisioning: a backend that must fetch something onto this machine (a
    // first-run browser download) does it here, once per target and before
    // any worker, outside every launch budget. Only an interrupt cuts it
    // short, and its progress streams as `notice` events, so the reporter
    // prints it instead of a worker's stderr fighting the live status block.
    try {
      await debug.time('backend.prepare', () =>
        prepareBackends(
          selection.perTarget.map(({ target }) => target),
          { runId, env, signal: interrupted },
          (target, message) => emit({ type: 'notice', target, message }),
        ),
      );
    } catch (cause) {
      if (!interrupted.aborted) recordFailure(cause, 'launch');
      return;
    }
    if (interrupted.aborted) return;

    // Workers re-load the config module themselves, so a file-backed config
    // runs across processes. A programmatic `rawConfig` cannot cross a process
    // boundary (it may hold live backend handles), so it runs in-process
    // against one worker. Either way the scheduler is the only engine.
    if (config.configPath === undefined) {
      // In-process execution shares this process with the runner, so the
      // recorder lives here and is drained straight into the collector.
      await ensureAiTraceRecorder();
    }
    const transport =
      config.configPath === undefined
        ? {
            workers: 1,
            spawn: inProcessSpawner({
              config,
              selection,
              runId,
              artifactsRoot,
              sessionStore: store,
              headed: options.headed ?? false,
              debug,
            }),
          }
        : {
            workers: config.workers,
            spawn: childProcessSpawner({
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
            }),
          };

    await debug.time('scheduler', () =>
      runUnits({
        selection,
        collection,
        projectRoot: config.projectRoot,
        workers: transport.workers,
        spawn: transport.spawn,
        interruptGraceMs: config.timeout + config.cleanupTimeout,
        interruptSignal: interrupted,
        forceSignal: forceController.signal,
        forceGraceMs: config.cleanupTimeout + FORCE_KILL_MARGIN_MS,
        events: {
          onResult: (result) => {
            results.push(result);
            emit({ type: 'test-finished', result: toEventResult(result) });
            // Queued, never awaited here: analysis runs beside the remaining tests.
            analysis?.consider(result);
          },
          onSerialGroup: (group) => {
            serialGroups.push(group);
            emit({ type: 'serial-group', group });
          },
          onRunError: recordRunError,
          onTestStart: (testId, title, targetName) =>
            emit({ type: 'test-started', testId, title, target: targetName }),
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
  // event means the app process and session store are gone. A forced
  // interrupt is also an interrupt; that is enforced here, once, so the
  // scheduler can take it for granted.
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
    // Analyses settle first: the report must carry every verdict that was
    // going to land, and an interrupt has already aborted them.
    for (const teardown of [
      () => analysis?.settle(),
      () => sessionStore?.cleanup(),
      () => appProcess?.stop(),
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
 * Runs each target's `prepare` hook in turn. Sequential on purpose: two
 * backends provisioning the same toolchain would race, and the notices of
 * one download read better than two interleaved.
 */
async function prepareBackends(
  targets: readonly ResolvedTarget[],
  scope: { runId: string; env: NodeJS.ProcessEnv; signal: AbortSignal },
  notice: (target: string, message: string) => void,
): Promise<void> {
  for (const target of targets) {
    const backend = target.backend;
    if (backend?.prepare === undefined) continue;
    if (scope.signal.aborted) return;
    try {
      // The same `env` the workers are started with: what prepare provisions
      // must be where a worker's launch will look for it.
      await backend.prepare({
        runId: scope.runId,
        targetName: target.name,
        env: scope.env,
        signal: scope.signal,
        log: (line) => notice(target.name, line),
      });
    } catch (cause) {
      throw translateProvisioningError(cause, ` while preparing backend ${backend.name} for target "${target.name}"`);
    }
  }
}

/** Resolves the run's config: a supplied value, or the discovered file. */
async function loadRunConfig(
  options: RunOptions,
  cwd: string,
  env: NodeJS.ProcessEnv,
  cli: CliOverrides,
): Promise<ResolvedConfig> {
  if (options.rawConfig !== undefined) {
    return resolveConfig(options.rawConfig, { projectRoot: cwd, env, cli });
  }
  const discovered = discoverConfig(cwd, options.configPath);
  const raw = discovered.configPath === undefined ? {} : await loadConfigModule(discovered.configPath);
  return resolveConfig(raw, {
    projectRoot: discovered.projectRoot,
    ...(discovered.configPath !== undefined ? { configPath: discovered.configPath } : {}),
    env,
    cli,
  });
}

function statusOf(exitCode: RunExitCode): RunOutcome['status'] {
  return exitCode === 0 ? 'passed' : exitCode === 1 ? 'failed' : exitCode === 130 ? 'interrupted' : 'error';
}

/**
 * Grades one target from its backend declaration and validates the configured
 * artifacts against it; returns the report provenance.
 */
function validateBackend(target: ResolvedTarget, config: ResolvedConfig): TargetProvenance {
  const provenance = describeTarget(target);
  // The default artifact set is best-effort: a backend without evidence
  // capture simply records none. Asking for one explicitly is a contract.
  for (const artifact of config.artifactsExplicit ? config.artifacts : []) {
    if (!provenance.artifactCapabilities.includes(artifact)) {
      throw new ConfigurationError(
        'UNSUPPORTED_ARTIFACT',
        `target "${target.name}" (backend ${provenance.backend.name}) does not support the configured "${artifact}" artifact`,
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

function resolveArtifactsRoot(config: ResolvedConfig, override: string | undefined): string {
  if (override !== undefined) return path.resolve(config.projectRoot, override);
  return path.join(config.projectRoot, '.e2e', 'artifacts');
}

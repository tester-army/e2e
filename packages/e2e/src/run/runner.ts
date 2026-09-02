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
  type ErrorPhase,
} from '../internal/errors.ts';
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
  /**
   * A config value instead of a discovered file — the embedding-host entry
   * point (see the embedding guide). May hold live values (executors, driver
   * handles, model instances, cache stores, secret providers), which cannot
   * cross a process boundary, so the run executes in-process on one worker.
   */
  rawConfig?: E2EConfig | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  quiet?: boolean | undefined;
  interruptSignal?: AbortSignal | undefined;
  /** Structured, JSON-serializable run events for embedding hosts. */
  onEvent?: RunEventSink | undefined;
}

export interface RunOutcome {
  exitCode: RunExitCode;
  status: 'passed' | 'failed' | 'error' | 'interrupted';
  report: Report1Document;
  reportPath: string | undefined;
  results: readonly ResultRecord[];
}

/** Executes one complete run and returns the outcome without exiting. */
export async function run(options: RunOptions = {}): Promise<RunOutcome> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const runId = uuidv7();
  const startedAt = timestamp();
  const debug = new DebugTrace(options.debug === true);
  const interruptController = new AbortController();
  const runErrors: RunError[] = [];
  const results: ResultRecord[] = [];
  const serialGroups: SerialGroupRecord[] = [];
  const targetProvenance = new Map<string, TargetProvenance>();
  let appProcess: AppProcess | undefined;
  let sessionStore: SessionStore | undefined;

  // Hoisted: workers re-resolve the same config file and need these overrides,
  // or a flag would apply in the runner and be dropped in every worker.
  const cli: CliOverrides = {};
  if (options.retries !== undefined) cli.retries = options.retries;
  if (options.workers !== undefined) cli.workers = options.workers;
  if (options.reporters !== undefined) cli.reporters = options.reporters;
  if (options.noCache === true) cli.cache = 'off';

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

  const finish = async (): Promise<RunOutcome> => {
    const reportPath = loaded.config === undefined ? undefined : await writeCanonicalReport(loaded.config);
    const exitCode = currentExitCode();
    const status = statusOf(exitCode);
    const report = buildRunReport(exitCode);
    setCredentialRegistry(undefined);
    emit({ type: 'run-finished', status, exitCode, ...(reportPath === undefined ? {} : { reportPath }) });
    if (jsonReport) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    if (debug.enabled) {
      process.stderr.write(debug.summary());
      process.stderr.write(agentStepTable(results, serialGroups));
    }
    return { exitCode, status, report, reportPath, results };
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

    // Workers re-load the config module themselves, so a file-backed config
    // runs across processes. A programmatic `rawConfig` cannot cross a process
    // boundary (it may hold live backend handles), so it runs in-process
    // against one worker. Either way the scheduler is the only engine.
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
          onTestStart: (testId, title, targetName) =>
            emit({ type: 'test-started', testId, title, target: targetName }),
          onProgress: (testId, targetName, progress) =>
            emit({ type: 'step', testId, target: targetName, progress }),
          onDebug: (snapshot) => debug.merge(snapshot),
        },
      }),
    );
  };

  // The interrupt bridge is armed for the whole body — app startup, collection,
  // scheduling — so a host's cancellation lands wherever the run is, not only
  // once the scheduler happens to be running. From here the run owns external
  // resources. Failures anywhere are recorded, never thrown — the outcome must
  // survive its own execution and its own cleanup — and teardown always runs
  // before the terminal `run-finished`, so that event means the app process
  // and session store are gone.
  const externalSignal = options.interruptSignal;
  const onInterrupt = () => interruptController.abort();
  if (externalSignal?.aborted === true) interruptController.abort();
  externalSignal?.addEventListener('abort', onInterrupt, { once: true });
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  try {
    await executeRun();
  } catch (cause) {
    recordFailure(cause);
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
    externalSignal?.removeEventListener('abort', onInterrupt);
  }
  for (const teardown of [() => sessionStore?.cleanup(), () => appProcess?.stop()]) {
    try {
      await teardown();
    } catch (cause) {
      recordFailure(cause);
    }
  }
  return finish();
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

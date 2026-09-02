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
  exitCodeForCategory,
  serializeError,
  E2EError,
  errorMessage,
} from '../internal/errors.ts';
import { DebugTrace } from '../internal/debug.ts';
import { timestamp, uuidv7 } from '../internal/ids.ts';
import { buildReport, describeTarget, type Report1Document, type TargetProvenance } from '../report/build.ts';
import { agentStepTable } from '../report/debug-steps.ts';
import { ListReporter } from '../report/list.ts';
import { writeJsonReport } from '../report/write.ts';
import { AppProcess } from './app-process.ts';
import { listReporterSink } from '../report/list.ts';
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
  // The event stream is the run's single spine: the list reporter is just one
  // sink on it, beside the host's, so the CLI and a host can never see
  // different stories.
  const listReporter =
    options.quiet === true || options.reporters?.includes('json') === true
      ? undefined
      : new ListReporter();
  const emit = createRunEventEmitter([
    listReporter === undefined ? undefined : listReporterSink(listReporter),
    options.onEvent,
  ]);

  let config: ResolvedConfig | undefined;
  let reportPath: string | undefined;
  let appProcess: AppProcess | undefined;
  let sessionStore: SessionStore | undefined;

  const statusOf = (exitCode: RunExitCode): RunOutcome['status'] =>
    exitCode === 0 ? 'passed' : exitCode === 1 ? 'failed' : exitCode === 130 ? 'interrupted' : 'error';

  const buildRunReport = (status: RunOutcome['status'], exitCode: RunExitCode) =>
    buildReport({
      runId,
      config,
      startedAt,
      status,
      exitCode,
      results,
      serialGroups,
      runErrors,
      targetProvenance,
    });

  const finish = async (exitCode: RunExitCode): Promise<RunOutcome> => {
    let status = statusOf(exitCode);
    let report = buildRunReport(status, exitCode);
    if (config !== undefined) {
      const artifactsRoot = resolveArtifactsRoot(config, options.artifactsDir);
      const target = path.join(path.dirname(artifactsRoot), 'report.json');
      try {
        await writeJsonReport(target, report);
        // Advertised only once the file exists: a host must never be handed a
        // path to a report that was not written.
        reportPath = target;
      } catch (cause) {
        // A lost canonical report is an infrastructure run error, not a
        // footnote or a test failure: it joins the exit code and the returned
        // in-memory report. The file is not retried — the destination just
        // failed — so the in-memory document is the only complete record.
        const error = new E2EError(
          'infrastructure',
          'REPORT_WRITE_FAILED',
          `the canonical report could not be written: ${errorMessage(cause)}`,
          { cause },
        );
        recordRunError(error, 'report');
        exitCode = combineExitCodes([exitCode, exitCodeForCategory(error.category)]);
        status = statusOf(exitCode);
        report = buildRunReport(status, exitCode);
      }
    }
    setCredentialRegistry(undefined);
    emit({ type: 'run-finished', status, exitCode, ...(reportPath !== undefined ? { reportPath } : {}) });
    if (options.reporters?.includes('json') === true) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    if (debug.enabled) {
      process.stderr.write(debug.summary());
      process.stderr.write(agentStepTable(results, serialGroups));
    }
    return { exitCode, status, report, reportPath, results };
  };

  const recordRunError = (error: E2EError, phase?: 'config' | 'collection' | 'launch' | 'report') => {
    const serialized = serializeError(error, phase === undefined ? {} : { phase });
    runErrors.push({ error: serialized });
    emit({ type: 'run-error', error: serialized });
  };

  // Hoisted: workers re-resolve the same config file and need these overrides,
  // or a flag would apply in the runner and be dropped in every worker.
  const cli: CliOverrides = {};
  if (options.retries !== undefined) cli.retries = options.retries;
  if (options.workers !== undefined) cli.workers = options.workers;
  if (options.reporters !== undefined) cli.reporters = options.reporters;
  if (options.noCache === true) cli.cache = 'off';

  try {

    config = await debug.time('config.load', async () => {
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
    });
  } catch (cause) {
    recordRunError(classifyError(cause), 'config');
    return finish(exitCodeForCategory(classifyError(cause).category));
  }

  setCredentialRegistry(config.credentials);
  emit({
    type: 'run-started',
    runId,
    projectId: config.projectId,
    projectRoot: config.projectRoot,
    ci: isCiMode(env),
    targets: config.targets.map((target) => target.name),
  });

  try {
    if (config.app.command !== undefined) {
      appProcess = new AppProcess(config.app.command, config.projectRoot, config.app.readyUrl);
      await debug.time('app.start', () => appProcess!.start());
    }

    const resolvedConfig = config;
    let planned: { collection: Collection; selection: Selection };
    try {
      planned = await debug.time('collect', async () => {
        const collection = await collect(resolvedConfig, options.files);
        const filters: SelectionFilters = {
          ...(options.tags !== undefined ? { tags: options.tags } : {}),
          ...(options.tagMode !== undefined ? { tagMode: options.tagMode } : {}),
          ...(options.targetIds !== undefined ? { targetIds: options.targetIds } : {}),
        };
        const selection = select(
          collection,
          resolvedConfig,
          filters,
          options.passWithNoTests !== undefined ? { passWithNoTests: options.passWithNoTests } : {},
        );
        return { collection, selection };
      });
    } catch (cause) {
      const error = classifyError(cause);
      recordRunError(error, 'collection');
      return finish(exitCodeForCategory(error.category));
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
      targetProvenance.set(target.name, validateBackend(target, resolvedConfig));
    }

    const externalSignal = options.interruptSignal;
    const onExternalAbort = () => interruptController.abort();
    if (externalSignal?.aborted === true) interruptController.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const onSignal = () => interruptController.abort();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    // Workers re-load the config module themselves, so a file-backed config
    // runs across processes. A programmatic `rawConfig` cannot cross a process
    // boundary (it may hold live backend handles), so it runs in-process
    // against one worker. Either way the scheduler is the only engine.
    const transport =
      config.configPath === undefined
        ? {
            workers: 1,
            spawn: inProcessSpawner({
              config: resolvedConfig,
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

    try {
      await debug.time('scheduler', () =>
        runUnits({
          selection,
          collection,
          projectRoot: resolvedConfig.projectRoot,
          workers: transport.workers,
          spawn: transport.spawn,
          interruptGraceMs: resolvedConfig.timeout + resolvedConfig.cleanupTimeout,
          interruptSignal: interruptController.signal,
          events: {
            onResult: (result) => {
              results.push(result);
              emit({ type: 'test-finished', result: toEventResult(result) });
            },
            onSerialGroup: (group) => {
              serialGroups.push(group);
              emit({ type: 'serial-group', group });
            },
            onRunError: (error) => {
              runErrors.push(error);
              emit({ type: 'run-error', error: error.error });
            },
            onTestStart: (testId, title, targetName) =>
              emit({ type: 'test-started', testId, title, target: targetName }),
            onProgress: (testId, targetName, progress) =>
              emit({ type: 'step', testId, target: targetName, progress }),
            onDebug: (snapshot) => debug.merge(snapshot),
          },
        }),
      );
    } finally {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  } catch (cause) {
    const error = classifyError(cause);
    recordRunError(error);
    const exitCodes = [exitCodeForCategory(error.category), ...resultExitCodes(results)];
    return finish(combineExitCodes(exitCodes));
  } finally {
    sessionStore?.cleanup();
    await appProcess?.stop();
  }

  const codes = resultExitCodes(results);
  for (const runError of runErrors) {
    codes.push(exitCodeForCategory(runError.error.category));
  }
  if (interruptController.signal.aborted) codes.push(130);
  return finish(combineExitCodes(codes));
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

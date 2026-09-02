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
  type E2EError,
} from '../internal/errors.ts';
import { DebugTrace } from '../internal/debug.ts';
import { timestamp, uuidv7 } from '../internal/ids.ts';
import { BACKEND_SPI_VERSION } from '../backend/contract.ts';
import { buildReport, type Report1Document, type TargetProvenance } from '../report/build.ts';
import { agentStepTable } from '../report/debug-steps.ts';
import { ListReporter } from '../report/list.ts';
import { writeJsonReport } from '../report/write.ts';
import { AppProcess } from './app-process.ts';
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
  /** Preloaded raw config (bypasses discovery); intended for tests. */
  rawConfig?: E2EConfig | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  quiet?: boolean | undefined;
  interruptSignal?: AbortSignal | undefined;
}

export interface RunOutcome {
  exitCode: 0 | 1 | 2 | 3 | 4 | 130;
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
  const listReporter =
    options.quiet === true || options.reporters?.includes('json') === true
      ? undefined
      : new ListReporter();

  let config: ResolvedConfig | undefined;
  let reportPath: string | undefined;
  let appProcess: AppProcess | undefined;
  let sessionStore: SessionStore | undefined;

  const finish = async (
    exitCode: 0 | 1 | 2 | 3 | 4 | 130,
  ): Promise<RunOutcome> => {
    const status =
      exitCode === 0 ? 'passed' : exitCode === 1 ? 'failed' : exitCode === 130 ? 'interrupted' : 'error';
    const report = buildReport({
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
    if (config !== undefined) {
      const artifactsRoot = resolveArtifactsRoot(config, options.artifactsDir);
      reportPath = path.join(path.dirname(artifactsRoot), 'report.json');
      try {
        await writeJsonReport(reportPath, report);
      } catch (cause) {
        const error = classifyError(cause);
        runErrors.push({ error: serializeError(error, { phase: 'report' }) });
      }
    }
    listReporter?.onRunEnd({
      status,
      exitCode,
      reportPath: reportPath ?? '(not written)',
      errors: runErrors,
    });
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
    runErrors.push({ error: serializeError(error, phase === undefined ? {} : { phase }) });
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
  listReporter?.onRunStart({
    runId,
    targets: config.targets.map((target) => target.name),
    ci: isCiMode(env),
    projectRoot: config.projectRoot,
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

    listReporter?.onPlan({ total: selection.pairs.length });

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
              listReporter?.onResult(result);
            },
            onSerialGroup: (group) => {
              serialGroups.push(group);
              listReporter?.onSerialGroup(group);
            },
            onRunError: (error) => runErrors.push(error),
            onTestStart: (testId, title, targetName) =>
              listReporter?.onTestStart({ id: testId, title, target: targetName }),
            onProgress: (testId, targetName, progress) =>
              listReporter?.onProgress({ testId, target: targetName, progress }),
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
 * artifacts against it; returns the report provenance. A target without a
 * backend is agent-tools-only and honestly reports no capabilities.
 */
function validateBackend(target: ResolvedTarget, config: ResolvedConfig): TargetProvenance {
  const backend = target.backend;
  const artifactCapabilities: ('screenshot' | 'trace' | 'video')[] = [];
  if (backend?.artifacts !== undefined) {
    artifactCapabilities.push('screenshot');
    if (backend.artifacts.startTrace !== undefined) artifactCapabilities.push('trace');
  }
  // The default artifact set is best-effort: a backend without evidence
  // capture simply records none. Asking for one explicitly is a contract.
  for (const artifact of config.artifactsExplicit ? config.artifacts : []) {
    if (!artifactCapabilities.includes(artifact)) {
      throw new ConfigurationError(
        'UNSUPPORTED_ARTIFACT',
        `target "${target.name}" (backend ${backend?.name ?? 'none'}) does not support the configured "${artifact}" artifact`,
      );
    }
  }
  return {
    backend: {
      name: backend?.name ?? 'none',
      version: backend?.version ?? 'unversioned',
      spiVersion: BACKEND_SPI_VERSION,
    },
    capabilities: [...(backend?.capabilities ?? [])].toSorted(),
    artifactCapabilities,
    stateCapability: backend?.state !== undefined,
  };
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

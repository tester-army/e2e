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
import type { Driver } from '../driver/index.ts';
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
import { buildReport, type Report1Document, type TargetProvenance } from '../report/build.ts';
import { ListReporter } from '../report/list.ts';
import { writeJsonReport } from '../report/write.ts';
import { ensureBrowsersInstalled } from '../playwright/install.ts';
import { AppProcess } from './app-process.ts';
import { inProcessSpawner } from './in-process.ts';
import type { ResultRecord, RunError, SerialGroupRecord } from './records.ts';
import { resolveDriver } from './resolve-driver.ts';
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
  reporters?: readonly ('list' | 'json' | 'html')[] | undefined;
  artifactsDir?: string | undefined;
  /** `--no-agent-cache`: false forces agent cache mode off. */
  agentCache?: boolean | undefined;
  passWithNoTests?: boolean | undefined;
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
  const driversToDispose = new Set<Driver>();

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
      // The trust model is documented and report-recorded, never printed.
      trustNoticeShown: false,
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
    listReporter?.onRunEnd({ status, exitCode, reportPath: reportPath ?? '(not written)' });
    if (options.reporters?.includes('json') === true) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    if (debug.enabled) process.stderr.write(debug.summary());
    return { exitCode, status, report, reportPath, results };
  };

  const recordRunError = (error: E2EError, phase?: 'config' | 'collection' | 'launch' | 'report') => {
    runErrors.push({ error: serializeError(error, phase === undefined ? {} : { phase }) });
  };

  try {
    const cli: CliOverrides = {};
    if (options.retries !== undefined) cli.retries = options.retries;
    if (options.workers !== undefined) cli.workers = options.workers;
    if (options.reporters !== undefined) cli.reporters = options.reporters;
    if (options.agentCache === false) cli.agentCache = 'off';

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

    const testTitles = new Map<string, string>();
    for (const { pairs } of selection.perTarget) {
      for (const pair of pairs) {
        testTitles.set(pair.test.id, pair.test.titlePath.join(' \u203a '));
      }
    }
    listReporter?.onPlan({ total: selection.pairs.length });

    const artifactsRoot = resolveArtifactsRoot(config, options.artifactsDir);
    const sessionsRoot = path.join(config.projectRoot, '.e2e', 'sessions');
    const store = SessionStore.create(runId, sessionsRoot);
    sessionStore = store;

    // Pre-flight: validate every selected driver before any session launches.
    // Child-process workers build their own driver instances; these are used
    // for validation, for report provenance, and (in-process only) execution.
    const preflightDrivers = new Map<string, Driver>();
    for (const { target } of selection.perTarget) {
      const driver = resolveDriver(target);
      driversToDispose.add(driver);
      preflightDrivers.set(target.name, driver);
      targetProvenance.set(target.name, validateDriver(driver, target, resolvedConfig));
    }

    // Pre-flight: provision browsers for the bundled driver before any
    // session launches, so first-run downloads never eat launch timeouts.
    // Worker processes launch their own browsers, so this must happen here,
    // once, before any worker starts.
    const bundledBrowsers = selection.perTarget
      .filter(({ target }) => target.driver === 'playwright')
      .map(({ target }) => target.browser);
    if (bundledBrowsers.length > 0) {
      await debug.time('browsers.install', () => ensureBrowsersInstalled(bundledBrowsers));
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
    // boundary (it may hold live driver instances), so it runs in-process
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
              env,
              debug,
              drivers: preflightDrivers,
            }),
          }
        : {
            workers: config.workers,
            spawn: childProcessSpawner({
              configPath: config.configPath,
              projectRoot: config.projectRoot,
              configDigest: config.configDigest,
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
            onSerialGroup: (group) => serialGroups.push(group),
            onRunError: (error) => runErrors.push(error),
            onTestStart: (testId, targetName) =>
              listReporter?.onTestStart({
                id: testId,
                title: testTitles.get(testId) ?? testId,
                target: targetName,
              }),
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
    await debug.time('driver.dispose', () => disposeDrivers(driversToDispose));
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

/** Disposes driver-level shared resources; failures never affect the run outcome. */
async function disposeDrivers(drivers: ReadonlySet<Driver>): Promise<void> {
  for (const driver of drivers) {
    try {
      await driver.dispose?.();
    } catch {
      // dispose is best-effort cleanup
    }
  }
}

/** Validates one driver against the SPI version and configured artifacts; returns provenance. */
function validateDriver(
  driver: Driver,
  target: ResolvedTarget,
  config: ResolvedConfig,
): TargetProvenance {
  if (driver.spiVersion !== 1) {
    throw new ConfigurationError(
      'SPI_MISMATCH',
      `driver ${driver.id} uses unsupported SPI version ${String(driver.spiVersion)}`,
    );
  }
  for (const artifact of config.artifacts) {
    if (!driver.capabilities.artifacts.includes(artifact)) {
      throw new ConfigurationError(
        'UNSUPPORTED_ARTIFACT',
        `driver ${driver.id} does not support the configured "${artifact}" artifact`,
      );
    }
  }
  return {
    browserVersion: 'unknown',
    viewport: {
      width: target.viewport?.width ?? 1280,
      height: target.viewport?.height ?? 720,
      scale: 1,
    },
    driver: { id: driver.id, version: driver.version, spiVersion: 1 },
    capabilities: [...driver.capabilities.fixtures],
    artifactCapabilities: [...driver.capabilities.artifacts],
    stateCapability: driver.capabilities.state,
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

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
import { playwright } from '../playwright/index.ts';
import { ensureBrowsersInstalled } from '../playwright/install.ts';
import { AppProcess } from './app-process.ts';
import { TargetExecutor } from './execute.ts';
import type { ResultRecord, RunError, SerialGroupRecord } from './records.ts';
import { SessionStore } from './sessions.ts';
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

/** Resolves the driver implementation for one target. */
function resolveDriver(target: ResolvedTarget): Driver {
  if (target.driver === 'playwright') return playwright();
  return target.driver;
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
      trustNoticeShown: listReporter !== undefined,
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
  });

  try {
    if (config.app.command !== undefined) {
      appProcess = new AppProcess(config.app.command, config.projectRoot, config.app.readyUrl);
      await debug.time('app.start', () => appProcess!.start());
    }

    let collection: Collection;
    let selection: Selection;
    try {
      collection = await debug.time('collect', () => collect(config!, options.files));
      const filters: SelectionFilters = {
        ...(options.tags !== undefined ? { tags: options.tags } : {}),
        ...(options.tagMode !== undefined ? { tagMode: options.tagMode } : {}),
        ...(options.targetIds !== undefined ? { targetIds: options.targetIds } : {}),
      };
      selection = select(
        collection,
        config,
        filters,
        options.passWithNoTests !== undefined ? { passWithNoTests: options.passWithNoTests } : {},
      );
    } catch (cause) {
      const error = classifyError(cause);
      recordRunError(error, 'collection');
      return finish(exitCodeForCategory(error.category));
    }

    const artifactsRoot = resolveArtifactsRoot(config, options.artifactsDir);
    sessionStore = new SessionStore(runId, path.join(config.projectRoot, '.e2e', 'sessions'));

    // Pre-flight: validate every selected driver before any session launches.
    const resolvedConfig = config;
    const targetRuns = selection.perTarget.map(({ target, pairs }) => {
      const driver = resolveDriver(target);
      driversToDispose.add(driver);
      targetProvenance.set(target.name, validateDriver(driver, target, resolvedConfig));
      return { target, driver, pairs };
    });

    // Pre-flight: provision browsers for the bundled driver before any
    // session launches, so first-run downloads never eat launch timeouts.
    const bundledBrowsers = targetRuns
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

    try {
      for (const { target, driver, pairs } of targetRuns) {
        const executor = new TargetExecutor({
          config,
          target,
          driver,
          runId,
          artifactsRoot,
          sessionStore,
          headed: options.headed ?? false,
          interruptSignal: interruptController.signal,
          debug,
          events: {
            onResult: (result) => listReporter?.onResult(result),
          },
        });
        const outcome = await debug.time(`target.${target.name}`, () =>
          executor.run(pairs, collection.files),
        );
        results.push(...outcome.results);
        serialGroups.push(...outcome.serialGroups);
        runErrors.push(...outcome.runErrors);
      }
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

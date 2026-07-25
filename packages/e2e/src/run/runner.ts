/** Run orchestration: config, collection, selection, execution, reporting. */

import path from 'node:path';
import { discoverConfig, loadConfigModule } from '../config/load.js';
import {
  isCiMode,
  resolveConfig,
  type CliOverrides,
  type ResolvedConfig,
  type ResolvedTarget,
} from '../config/resolve.js';
import type { Driver } from '../driver/index.js';
import { collect, type Collection } from '../collect/collect.js';
import { select, type Selection, type SelectionFilters } from '../collect/select.js';
import {
  classifyError,
  combineExitCodes,
  ConfigurationError,
  exitCodeForCategory,
  serializeError,
  type E2EError,
} from '../internal/errors.js';
import { timestamp, uuidv7 } from '../internal/ids.js';
import { buildReport, type TargetProvenance } from '../report/build.js';
import { ListReporter } from '../report/list.js';
import { writeJsonReport } from '../report/write.js';
import { playwright } from '../playwright/index.js';
import { AppProcess } from './app-process.js';
import { TargetExecutor } from './execute.js';
import type { ResultRecord, RunError, SerialGroupRecord } from './records.js';
import { SessionStore } from './sessions.js';
import { setCredentialRegistry } from '../credentials.js';
import type { E2EConfig } from '../types.js';

export interface RunOptions {
  cwd?: string;
  configPath?: string;
  files?: readonly string[];
  tags?: readonly string[];
  tagMode?: 'any' | 'all';
  targetIds?: readonly string[];
  headed?: boolean;
  retries?: number;
  workers?: number;
  reporters?: readonly ('list' | 'json' | 'html')[];
  artifactsDir?: string;
  passWithNoTests?: boolean;
  /** Preloaded raw config (bypasses discovery); intended for tests. */
  rawConfig?: E2EConfig;
  env?: NodeJS.ProcessEnv;
  quiet?: boolean;
  interruptSignal?: AbortSignal;
}

export interface RunOutcome {
  exitCode: 0 | 1 | 2 | 3 | 4 | 130;
  status: 'passed' | 'failed' | 'error' | 'interrupted';
  report: Record<string, unknown>;
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
  let interrupted = false;

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
    return { exitCode, status, report: report as Record<string, unknown>, reportPath, results };
  };

  const recordRunError = (error: E2EError, phase?: 'config' | 'collection' | 'launch' | 'report') => {
    runErrors.push({ error: serializeError(error, phase === undefined ? {} : { phase }) });
  };

  try {
    const cli: CliOverrides = {};
    if (options.retries !== undefined) cli.retries = options.retries;
    if (options.workers !== undefined) cli.workers = options.workers;
    if (options.reporters !== undefined) cli.reporters = options.reporters;

    if (options.rawConfig !== undefined) {
      config = resolveConfig(options.rawConfig, { projectRoot: cwd, env, cli });
    } else {
      const discovered = discoverConfig(cwd, options.configPath);
      const raw = discovered.configPath === undefined ? {} : await loadConfigModule(discovered.configPath);
      config = resolveConfig(raw, {
        projectRoot: discovered.projectRoot,
        ...(discovered.configPath !== undefined ? { configPath: discovered.configPath } : {}),
        env,
        cli,
      });
    }
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
      await appProcess.start();
    }

    let collection: Collection;
    let selection: Selection;
    try {
      collection = await collect(config, options.files);
      const filters: SelectionFilters = {
        ...(options.tags !== undefined ? { tags: options.tags } : {}),
        ...(options.tagMode !== undefined ? { tagMode: options.tagMode } : {}),
        ...(options.targetIds !== undefined ? { targetIds: options.targetIds } : {}),
      };
      selection = select(collection, config, filters, {
        ...(options.passWithNoTests !== undefined ? { passWithNoTests: options.passWithNoTests } : {}),
      });
    } catch (cause) {
      const error = classifyError(cause);
      recordRunError(error, 'collection');
      return finish(exitCodeForCategory(error.category));
    }

    const artifactsRoot = resolveArtifactsRoot(config, options.artifactsDir);
    sessionStore = new SessionStore(runId, path.join(config.projectRoot, '.e2e', 'sessions'));

    const interruptController = new AbortController();
    const externalSignal = options.interruptSignal;
    const onExternalAbort = () => interruptController.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const onSignal = () => {
      interrupted = true;
      interruptController.abort();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    try {
      const selectedTargets =
        options.targetIds === undefined || options.targetIds.length === 0
          ? config.targets
          : config.targets.filter((target) => options.targetIds!.includes(target.name));

      for (const target of selectedTargets) {
        const driver = resolveDriver(target);
        if (driver.spiVersion !== 1) {
          throw new ConfigurationError(
            'SPI_MISMATCH',
            `driver ${driver.id} uses unsupported SPI version ${String(driver.spiVersion)}`,
          );
        }
        targetProvenance.set(target.name, {
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
        });
        for (const artifact of config.artifacts) {
          if (!driver.capabilities.artifacts.includes(artifact)) {
            throw new ConfigurationError(
              'UNSUPPORTED_ARTIFACT',
              `driver ${driver.id} does not support the configured "${artifact}" artifact`,
            );
          }
        }

        const executor = new TargetExecutor({
          config,
          target,
          driver,
          runId,
          artifactsRoot,
          sessionStore,
          headed: options.headed ?? false,
          interruptSignal: interruptController.signal,
          events: {
            onResult: (result) => listReporter?.onResult(result),
          },
        });
        const outcome = await executor.run(selection.pairs, collection.files);
        results.push(...outcome.results);
        serialGroups.push(...outcome.serialGroups);
        runErrors.push(...outcome.runErrors);
        if (outcome.interrupted) interrupted = true;
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
    sessionStore?.cleanup();
    await appProcess?.stop();
  }

  const codes = resultExitCodes(results);
  for (const runError of runErrors) {
    codes.push(exitCodeForCategory(runError.error.category));
  }
  if (interrupted || options.interruptSignal?.aborted === true) codes.push(130);
  return finish(combineExitCodes(codes));
}

function resultExitCodes(results: readonly ResultRecord[]): number[] {
  const codes: number[] = [0];
  for (const result of results) {
    switch (result.status) {
      case 'failed':
      case 'timed-out':
        codes.push(1);
        if (result.attempts.some((attempt) => attempt.error?.category === 'infrastructure')) {
          codes.push(3);
        }
        if (result.attempts.some((attempt) => attempt.error?.category === 'configuration')) {
          codes.push(2);
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

/**
 * Worker process entry: loads the config itself (config modules may hold live
 * driver instances that cannot cross IPC), owns one driver instance, executes
 * file-target units assigned by the runner, and streams records back.
 */

import {
  collectFromRegistration,
  type CollectedFile,
  type CollectedTest,
} from '../../collect/collect.ts';
import { collectModule } from '../../collect/registry.ts';
import type { TestTargetPair } from '../../collect/select.ts';
import { importModule, loadConfigModule } from '../../config/load.ts';
import { resolveConfig, type ResolvedConfig, type ResolvedTarget } from '../../config/resolve.ts';
import { setCredentialRegistry } from '../../credentials.ts';
import type { Driver } from '../../driver/index.ts';
import {
  classifyError,
  ConfigurationError,
  serializeError,
} from '../../internal/errors.ts';
import { TargetExecutor } from '../execute.ts';
import { resolveDriver } from '../resolve-driver.ts';
import { SessionStore } from '../sessions.ts';
import type {
  InitMessage,
  MainToWorker,
  RunUnitMessage,
  WorkerToMain,
} from './protocol.ts';
import { encodeResult } from './protocol.ts';

interface WorkerState {
  config: ResolvedConfig;
  target: ResolvedTarget;
  driver: Driver;
  executor: TargetExecutor;
  runErrorWatermark: number;
  collectCounter: number;
}

let state: WorkerState | undefined;
let currentUnitId: string | undefined;
const interruptController = new AbortController();

function send(message: WorkerToMain): void {
  process.send?.(message);
}

function fatal(cause: unknown): never {
  send({ type: 'fatal', error: serializeError(classifyError(cause)) });
  process.exit(1);
}

async function initialize(message: InitMessage): Promise<void> {
  const raw = await loadConfigModule(message.configPath);
  const config = resolveConfig(raw, {
    projectRoot: message.projectRoot,
    configPath: message.configPath,
    env: process.env,
  });
  if (config.configDigest !== message.configDigest) {
    throw new ConfigurationError(
      'CONFIG_NOT_DETERMINISTIC',
      'worker resolved a different config digest than the runner; config must be deterministic',
    );
  }
  const target = config.targets.find((candidate) => candidate.name === message.targetName);
  if (target === undefined) {
    throw new ConfigurationError('UNKNOWN_TARGET', `unknown target "${message.targetName}"`);
  }
  setCredentialRegistry(config.credentials);
  const driver = resolveDriver(target);
  const sessionStore = new SessionStore(
    message.runId,
    message.sessionsRoot,
    Buffer.from(message.sessionKeyBase64, 'base64'),
  );
  const executor = new TargetExecutor({
    config,
    target,
    driver,
    runId: message.runId,
    artifactsRoot: message.artifactsRoot,
    sessionStore,
    headed: message.headed,
    interruptSignal: interruptController.signal,
    events: {
      onResult: (result) => {
        send({ type: 'result', unitId: currentUnitId ?? '', result: encodeResult(result) });
      },
      onSerialGroup: (group) => {
        send({ type: 'serial-group', unitId: currentUnitId ?? '', group });
      },
      onPairStart: (pair) => {
        send({ type: 'pair-start', unitId: currentUnitId ?? '', testId: pair.test.id });
      },
    },
  });
  state = { config, target, driver, executor, runErrorWatermark: 0, collectCounter: 0 };
  send({ type: 'ready' });
}

/** Re-collects one file in this process and rebuilds the unit's pairs. */
async function collectUnitFile(active: WorkerState, message: RunUnitMessage): Promise<CollectedFile> {
  active.collectCounter += 1;
  const registration = await collectModule(() =>
    importModule(message.absolutePath, `worker-collect-${active.collectCounter}`),
  );
  return collectFromRegistration(active.config.projectRoot, message.absolutePath, registration);
}

async function runUnit(message: RunUnitMessage): Promise<void> {
  const active = state;
  if (active === undefined) throw new ConfigurationError('PROTOCOL', 'run-unit before init');
  currentUnitId = message.unitId;
  try {
    const collected = await collectUnitFile(active, message);
    const pairs: TestTargetPair[] = [];
    for (const wire of message.pairs) {
      const test = collected.tests.find((candidate) => candidate.id === wire.testId);
      if (test === undefined) {
        active.executor.recordDisappeared(
          `test ${wire.testId} disappeared on re-import; registration must be deterministic`,
        );
        active.executor.emit({
          test: minimalDisappearedTest(message, wire.testId),
          target: active.target,
          status: 'failed',
          selected: true,
          attempts: [],
        });
        continue;
      }
      pairs.push({ test, target: active.target, options: wire.options, disposition: 'run', skip: undefined });
    }
    if (message.kind === 'setup') {
      for (const pair of pairs) await active.executor.runSetupUnit(pair);
    } else {
      await active.executor.runFileUnit(
        { file: message.file, absolutePath: message.absolutePath },
        pairs,
      );
    }
  } finally {
    const runErrors = active.executor.outcome().runErrors;
    const delta = runErrors.slice(active.runErrorWatermark);
    active.runErrorWatermark = runErrors.length;
    send({ type: 'unit-done', unitId: message.unitId, runErrors: delta });
    currentUnitId = undefined;
  }
}

/** Synthesized identity for a test that vanished on re-import. */
function minimalDisappearedTest(message: RunUnitMessage, testId: string): CollectedTest {
  return {
    kind: 'test' as const,
    title: testId,
    titlePath: [testId],
    declarationIndex: 0,
    options: {},
    sessions: [],
    fn: () => undefined,
    group: undefined,
    mode: 'normal' as const,
    source: undefined,
    file: message.file,
    id: testId,
    serialRoot: undefined,
    serialId: undefined,
  };
}

async function shutdown(): Promise<void> {
  try {
    await state?.driver.dispose?.();
  } catch {
    // dispose is best-effort cleanup
  }
  process.exit(0);
}

function main(): void {
  if (process.send === undefined) {
    process.stderr.write('e2e worker requires an IPC channel\n');
    process.exit(1);
  }
  // Interrupts arrive over IPC; terminal signals target the runner process.
  process.on('SIGINT', () => undefined);
  process.on('SIGTERM', () => undefined);
  process.on('uncaughtException', (cause) => fatal(cause));
  process.on('unhandledRejection', (cause) => fatal(cause));

  let queue: Promise<void> = Promise.resolve();
  process.on('message', (message: MainToWorker) => {
    switch (message.type) {
      case 'interrupt':
        interruptController.abort();
        break;
      case 'shutdown':
        queue = queue.then(() => shutdown()).catch((cause) => fatal(cause));
        break;
      case 'init':
        queue = queue.then(() => initialize(message)).catch((cause) => fatal(cause));
        break;
      case 'run-unit':
        queue = queue.then(() => runUnit(message)).catch((cause) => fatal(cause));
        break;
    }
  });
}

main();

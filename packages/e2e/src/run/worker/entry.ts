/**
 * Worker process glue. Owns nothing but the process: it loads the config
 * itself (config modules may hold live driver instances that cannot cross
 * IPC), resolves each unit's pairs by re-importing the file, and hands all
 * actual execution to `TargetWorker`.
 */

import { collectFromRegistration, type TestIdentity } from '../../collect/collect.ts';
import { collectModule } from '../../collect/registry.ts';
import type { TestTargetPair } from '../../collect/select.ts';
import { importModule, loadConfigModule } from '../../config/load.ts';
import { resolveConfig } from '../../config/resolve.ts';
import { setCredentialRegistry } from '../../credentials.ts';
import { classifyError, ConfigurationError, serializeError } from '../../internal/errors.ts';
import { resolveDriver } from '../resolve-driver.ts';
import { SessionStore } from '../sessions.ts';
import type { ChildProcessInbound, RunUnitMessage, WorkerBootstrap, WorkerToMain } from './protocol.ts';
import { TargetWorker, type ResolvedUnitPairs, type TargetWorkerDeps } from './session.ts';

function send(message: WorkerToMain): void {
  process.send?.(message);
}

function fatal(cause: unknown): never {
  send({ type: 'fatal', error: serializeError(classifyError(cause)) });
  process.exit(1);
}

/**
 * Loads the config in this process and verifies it matches the runner's, then
 * assembles everything the worker core needs.
 */
async function bootstrap(message: WorkerBootstrap): Promise<TargetWorkerDeps> {
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

  let collectCounter = 0;
  const resolvePairs = async (unit: RunUnitMessage): Promise<ResolvedUnitPairs> => {
    collectCounter += 1;
    const registration = await collectModule(() =>
      importModule(unit.absolutePath, `worker-collect-${collectCounter}`),
    );
    const collected = collectFromRegistration(config.projectRoot, unit.absolutePath, registration);
    const pairs: TestTargetPair[] = [];
    const missing: TestIdentity[] = [];
    for (const wire of unit.pairs) {
      const test = collected.tests.find((candidate) => candidate.id === wire.test.id);
      if (test === undefined) {
        missing.push(wire.test);
        continue;
      }
      pairs.push({ test, target, options: wire.options, disposition: 'run', skip: undefined });
    }
    return { pairs, missing };
  };

  return {
    config,
    target,
    driver: resolveDriver(target),
    sessionStore: SessionStore.forWorker(
      message.runId,
      message.sessionsRoot,
      Buffer.from(message.sessionKeyBase64, 'base64'),
    ),
    runId: message.runId,
    artifactsRoot: message.artifactsRoot,
    headed: message.headed,
    env: process.env,
    resolvePairs,
    disposeDriver: true,
  };
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

  let worker: TargetWorker | undefined;
  process.on('message', (message: ChildProcessInbound) => {
    if (message.type === 'bootstrap') {
      worker = new TargetWorker(
        { emit: send, fatal, finished: () => process.exit(0) },
        () => bootstrap(message.bootstrap),
      );
      worker.start();
      return;
    }
    worker?.handle(message);
  });
}

main();

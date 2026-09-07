/**
 * Worker process glue. Owns nothing but the process: it loads the config
 * itself (config modules may hold live engine handles that cannot cross
 * IPC), resolves each unit's pairs by re-importing the file, and hands all
 * actual execution to `TargetWorker`.
 */

import { collectFromRegistration, type TestIdentity } from '../../collect/collect.ts';
import { collectModule } from '../../collect/registry.ts';
import type { TestTargetPair } from '../../collect/select.ts';
import { importModule, loadConfigModule } from '../../config/load.ts';
import { resolveConfig } from '../../config/resolve.ts';
import { setCredentialRegistry } from '../../credentials.ts';
import { loadAiSdk } from '../../agent/ai-sdk.ts';
import { AiTraceRecorder, registerAiTraceRecorder } from '../../internal/ai-trace.ts';
import { DebugTrace } from '../../internal/debug.ts';
import { classifyError, ConfigurationError, serializeError } from '../../internal/errors.ts';
import { SessionStore } from '../sessions.ts';
import type { ChildProcessInbound, RunUnitMessage, WorkerBootstrap, WorkerToMain } from './protocol.ts';
import { TargetWorker, type ResolvedUnitPairs, type TargetWorkerDeps } from './session.ts';

/**
 * Outbound messages in flight. `process.send` is asynchronous and a
 * `process.exit` right behind it can drop the message, so exiting waits for
 * the queue to flush: the runner must see the worker's last word.
 */
let outbox: Promise<void> = Promise.resolve();

/** How long an exit waits for the outbox: a channel whose runner is gone may never acknowledge. */
const FLUSH_GRACE_MS = 2_000;

function send(message: WorkerToMain): void {
  outbox = outbox.then(
    () =>
      new Promise<void>((resolve) => {
        try {
          if (process.send === undefined || !process.connected) resolve();
          else process.send(message, undefined, undefined, () => resolve());
        } catch {
          // channel already closed; nothing left to deliver
          resolve();
        }
      }),
  );
}

function exitAfterFlush(code: 0 | 1): void {
  const exit = (): void => process.exit(code);
  setTimeout(exit, FLUSH_GRACE_MS).unref();
  void outbox.then(exit);
}

function fatal(cause: unknown): void {
  send({ type: 'fatal', error: serializeError(classifyError(cause)) });
  exitAfterFlush(1);
}

/**
 * Loads the config in this process and verifies it matches the runner's, then
 * assembles everything the worker core needs.
 */
async function bootstrap(
  message: WorkerBootstrap,
  debug: DebugTrace,
  aiTrace: AiTraceRecorder | undefined,
): Promise<TargetWorkerDeps> {
  // Registered before the config loads: a config module may construct an
  // executor that imports the AI SDK itself, and the integration list is
  // process-wide, so calls from either module instance land in one trace.
  if (aiTrace !== undefined) await registerAiTraceRecorder(aiTrace, loadAiSdk);
  const raw = await loadConfigModule(message.configPath);
  const config = resolveConfig(raw, {
    projectRoot: message.projectRoot,
    configPath: message.configPath,
    env: process.env,
    cli: message.cli,
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
    const byId = new Map(collected.tests.map((test) => [test.id, test]));
    const pairs: TestTargetPair[] = [];
    const missing: TestIdentity[] = [];
    for (const wire of unit.pairs) {
      const test = byId.get(wire.test.id);
      if (test === undefined) {
        missing.push(wire.test);
        continue;
      }
      pairs.push({ test, target, options: wire.options, disposition: 'run', skip: undefined });
    }
    return { pairs, missing, registration };
  };

  return {
    config,
    target,
    sessionStore: SessionStore.forWorker(
      message.runId,
      message.sessionsRoot,
      Buffer.from(message.sessionKeyBase64, 'base64'),
    ),
    runId: message.runId,
    artifactsRoot: message.artifactsRoot,
    headed: message.headed,
    isolated: true,
    resolvePairs,
    debug,
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

  // The channel closes when the runner is gone: killed, crashed, or exited
  // before this worker. A worker nobody is listening to must not keep driving
  // a device or a browser: it tears its engine down right away — bounded by
  // the cleanup budget like every disposal — and exits.
  process.on('disconnect', () => {
    if (worker === undefined) process.exit(1);
    else worker.handle({ type: 'terminate' });
  });

  process.on('message', (message: ChildProcessInbound) => {
    if (message.type === 'bootstrap') {
      // This worker owns its trace outright, so each drain point (unit-done,
      // shutdown-done) ships the entries accumulated since the previous one.
      const debug = new DebugTrace(message.bootstrap.debug);
      const aiTrace = message.bootstrap.aiTrace ? new AiTraceRecorder() : undefined;
      const emit = (outbound: WorkerToMain): void => {
        if (outbound.type !== 'unit-done' && outbound.type !== 'shutdown-done') {
          send(outbound);
          return;
        }
        send({
          ...outbound,
          ...(debug.enabled ? { debug: debug.drain() } : {}),
          ...(aiTrace === undefined
            ? {}
            : { aiTrace: aiTrace.drain({ all: outbound.type === 'shutdown-done' }) }),
        });
      };
      worker = new TargetWorker(
        { emit, fatal, finished: () => exitAfterFlush(0) },
        () => bootstrap(message.bootstrap, debug, aiTrace),
      );
      worker.start();
      return;
    }
    worker?.handle(message);
  });
}

main();

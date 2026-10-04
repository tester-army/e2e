/**
 * Worker process glue. Owns nothing but the process: it loads the config
 * itself (config modules may hold live engine handles that cannot cross
 * IPC), resolves each unit's pairs by re-importing the file, and hands all
 * actual execution to `TargetWorker`.
 */

import { collectFromRegistration } from '../../collect/collect.ts';
import { collectModule } from '../../collect/registry.ts';
import type { TestTargetPair } from '../../collect/select.ts';
import { importModule, loadConfigModule } from '../../config/load.ts';
import { assignPorts, resolveConfig } from '../../config/resolve.ts';
import { setSecretRegistry } from '../../secrets.ts';
import { loadAiSdk } from '../../agent/ai-sdk.ts';
import { AiTraceRecorder, registerAiTraceRecorder } from '../../internal/ai-trace.ts';
import { DebugTrace } from '../../internal/debug.ts';
import { classifyError, ConfigurationError, serializeError } from '../../internal/errors.ts';
import { StreamRedactor } from '../../internal/redact.ts';
import { processSecrets, registerStaticSecrets, staticSecretLedger } from '../secrecy.ts';
import { SessionStore } from '../sessions.ts';
import type {
  ChildProcessInbound,
  OutputMessage,
  RunUnitMessage,
  WirePair,
  WorkerBootstrap,
  WorkerToMain,
} from './protocol.ts';
import { TargetWorker, type ResolvedUnitPairs, type TargetWorkerDeps } from './session.ts';
import { isAbandonedRejection } from '../../internal/abandoned.ts';

/**
 * Outbound messages in flight. `process.send` is asynchronous and a
 * `process.exit` right behind it can drop the message, so exiting waits for
 * the queue to flush: the runner must see the worker's last word.
 */
let outbox: Promise<void> = Promise.resolve();

/** How long an exit waits for the outbox: a channel whose runner is gone may never acknowledge. */
const FLUSH_GRACE_MS = 2_000;

/**
 * Hands one message to the channel at once; resolves once the channel has
 * taken it and every message before it (or is gone). The channel keeps the
 * order. Handing it over synchronously is what lets a `pair-start` reach the
 * runner when the test body exits the process right after it.
 */
function send(message: WorkerToMain): Promise<void> {
  const taken = new Promise<void>((resolve) => {
    try {
      if (process.send === undefined || !process.connected) resolve();
      else process.send(message, undefined, undefined, () => resolve());
    } catch {
      // channel already closed; nothing left to deliver
      resolve();
    }
  });
  outbox = outbox.then(() => taken);
  return outbox;
}

/**
 * Output messages the channel has not taken yet before `write` answers
 * false: a producer that honors backpressure then waits for `drain`, so a
 * test streaming a large log cannot pile the whole of it into the outbox.
 */
const OUTPUT_HIGH_WATER = 64;

function exitAfterFlush(code: 0 | 1): void {
  const exit = (): void => process.exit(code);
  setTimeout(exit, FLUSH_GRACE_MS).unref();
  void outbox.then(exit);
}

/**
 * Routes everything the process writes to stdout or stderr into `output`
 * messages: the streams are inherited from the runner, whose terminal shows
 * the live window, so a test's `console.log` written straight through would
 * land inside it and be painted over. Text is attributed to the pair in
 * flight, with every secret value this process has seen redacted across
 * writes: a write that ends mid-line holds back the tail a later write could
 * complete into a value, and the returned function releases what is held,
 * attributed to the pair that wrote it. The stream's contract holds: the
 * callback fires once the channel took the message, `write` answers false
 * past the high-water mark, and `drain` follows when the backlog has cleared.
 */
function captureOutput(pairInFlight: () => OutputMessage['pair']): () => void {
  const flushes: (() => void)[] = [];
  for (const [stream, name] of [
    [process.stdout, 'stdout'],
    [process.stderr, 'stderr'],
  ] as const) {
    type Done = (error?: Error | null) => void;
    const redactor = new StreamRedactor(processSecrets);
    let heldFor: OutputMessage['pair'] = undefined;
    let pending = 0;
    let needsDrain = false;
    const output = (text: string, pair: OutputMessage['pair']): Promise<void> =>
      text === '' ? Promise.resolve() : send({ type: 'output', pair, stream: name, text });
    flushes.push(() => void output(redactor.flush(), heldFor));
    const write = (chunk: string | Uint8Array, encoding?: BufferEncoding | Done, callback?: Done): boolean => {
      const done = typeof encoding === 'function' ? encoding : callback;
      const pair = pairInFlight();
      pending += 1;
      void output(redactor.push(chunk), pair).then(() => {
        pending -= 1;
        if (done !== undefined) done();
        if (needsDrain && pending < OUTPUT_HIGH_WATER) {
          needsDrain = false;
          stream.emit('drain');
        }
      });
      heldFor = pair;
      if (pending < OUTPUT_HIGH_WATER) return true;
      needsDrain = true;
      return false;
    };
    stream.write = write as typeof stream.write;
  }
  return () => {
    for (const flush of flushes) flush();
  };
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
  const config = assignPorts(
    resolveConfig(raw, { projectRoot: message.projectRoot, configPath: message.configPath, env: process.env, cli: message.cli }),
    message.ports,
  );
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
  setSecretRegistry(config);
  registerStaticSecrets(config.allSecrets);

  let collectCounter = 0;
  const resolvePairs = async (unit: RunUnitMessage): Promise<ResolvedUnitPairs> => {
    collectCounter += 1;
    const registration = await collectModule(
      () => importModule(unit.absolutePath, `worker-collect-${collectCounter}`),
      unit.absolutePath,
      staticSecretLedger(config.allSecrets).redact,
    );
    const collected = collectFromRegistration(config.projectRoot, unit.absolutePath, registration);
    const byId = new Map(collected.tests.map((test) => [test.id, test]));
    const pairs: TestTargetPair[] = [];
    const missing: WirePair[] = [];
    for (const wire of unit.pairs) {
      const test = byId.get(wire.test.id);
      if (test === undefined) {
        missing.push(wire);
        continue;
      }
      pairs.push({ test, target, agent: wire.agent, repeat: wire.repeat, options: wire.options, disposition: 'run', skip: undefined });
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
    rerunDir: message.rerunDir,
    headed: message.headed,
    workerSlot: message.workerSlot,
    env: process.env,
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
  // A step or poll the test did not await rejects on a promise nobody holds
  // once it is cancelled; the attempt has already recorded it as STEP_NOT_AWAITED.
  // Any other rejection nobody caught is charged to the attempt in flight,
  // or recorded against the last test that finished; only before any test
  // has finished is it the worker's.
  process.on('unhandledRejection', (cause) => {
    if (isAbandonedRejection(cause)) return;
    if (worker?.strayRejection(cause) !== true) fatal(cause);
  });

  let worker: TargetWorker | undefined;
  const flushOutput = captureOutput(() => worker?.pairInFlight);

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
        // Output written without a final newline is still held; it leaves
        // before the message that starts the next pair (a serial member's
        // line must not land on the member after it), ends the test, the
        // unit, or the worker.
        if (
          outbound.type === 'pair-start' ||
          outbound.type === 'result' ||
          outbound.type === 'unit-done' ||
          outbound.type === 'shutdown-done'
        ) {
          flushOutput();
        }
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

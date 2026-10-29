/**
 * The host half of the iOS engine: an engine-protocol transport that runs
 * the Swift server on a simulator. Opening a connection installs the
 * target's `appPath`, starts the server's UI test with `xcodebuild
 * test-without-building` on a free port, waits for it to listen, and
 * connects: a simulator shares its Mac's loopback, so no forward is needed.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import path from 'node:path';
import { ConfigurationError, InfrastructureError, type EngineTransport, type TransportContext } from 'e2e/engine';

/** Options of the iOS transport. */
export interface IosTransportOptions {
  /** The simulator's UDID; defaults to `E2E_IOS_UDID`, else the one booted simulator. */
  readonly udid?: string;
  /**
   * Whether XCUITest waits for the app to go idle around every gesture, its
   * default. `false` skips the wait through private XCTest API, as
   * WebDriverAgent can; the harness's polling then waits for outcomes.
   */
  readonly waitForIdle?: boolean;
  /**
   * How long a control that appeared or moved with the last action is given
   * to finish arriving before it is acted on, in milliseconds; default 500,
   * as the mobile engine's `transition`. A presenting view drops touches and
   * reports its final frame throughout, so the budget is the only signal.
   */
  readonly transition?: number;
}

const PRODUCTS = path.join(import.meta.dirname, '..', 'build', 'DerivedData', 'Build', 'Products');
/** How long `xcodebuild` may take to start the runner and the server to listen. */
const READY_TIMEOUT_MS = 180_000;

/** Runs a tool and resolves with its stdout. */
export function run(command: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...(signal === undefined ? {} : { signal }) }, (error, stdout, stderr) => {
      if (error) reject(new InfrastructureError('ENGINE_FAILURE', `${command} ${args.join(' ')} failed: ${stderr.trim() || error.message}`));
      else resolve(stdout);
    });
  });
}

async function simulator(options: IosTransportOptions, env: TransportContext['env'], signal: AbortSignal): Promise<string> {
  const chosen = options.udid ?? env['E2E_IOS_UDID'];
  if (chosen !== undefined) return chosen;
  const listed: unknown = JSON.parse(await run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], signal));
  const devices = Object.values((listed as { devices?: Record<string, { udid: string }[]> }).devices ?? {}).flat();
  if (devices.length !== 1) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      devices.length === 0
        ? 'the ios engine found no booted simulator: boot one'
        : `the ios engine found ${devices.length} booted simulators: pick one with ios({ udid }) or E2E_IOS_UDID`,
    );
  }
  return devices[0]!.udid;
}

function xctestrun(): string {
  const file = (() => {
    try {
      return readdirSync(PRODUCTS).find((entry) => entry.endsWith('.xctestrun'));
    } catch {
      return undefined;
    }
  })();
  if (file === undefined) {
    throw new ConfigurationError('INVALID_CONFIG', 'the ios engine server is not built; run pnpm --filter @e2e-dev/ios build:server');
  }
  return path.join(PRODUCTS, file);
}

/** A TCP port free on the loopback right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

/** Starts the server's UI test and resolves once it listens. */
function startServer(udid: string, port: number, options: IosTransportOptions, signal: AbortSignal): Promise<{ process: ChildProcess; output: () => string }> {
  // xcodebuild hands the runner every `TEST_RUNNER_`-prefixed variable with
  // the prefix removed: the server reads `E2E_PORT`, `E2E_WAIT_FOR_IDLE`, and `E2E_TRANSITION_MS`.
  const child = spawn(
    'xcodebuild',
    ['test-without-building', '-xctestrun', xctestrun(), '-destination', `id=${udid}`, '-only-testing:E2EServer/EngineServer/testServe'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TEST_RUNNER_E2E_PORT: String(port), TEST_RUNNER_E2E_WAIT_FOR_IDLE: options.waitForIdle === false ? '0' : '1', TEST_RUNNER_E2E_TRANSITION_MS: String(options.transition ?? 500) } },
  );
  let output = '';
  const tail = (): string => output.trim().slice(-2048);
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      child.kill();
      reject(new InfrastructureError('ENGINE_FAILURE', 'opening the simulator was abandoned'));
      return;
    }
    const fail = (reason: string): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abandon);
      child.kill();
      reject(new InfrastructureError('ENGINE_FAILURE', `${reason}${tail() === '' ? '' : `: ${tail()}`}`));
    };
    const timer = setTimeout(() => fail(`the engine server did not start within ${READY_TIMEOUT_MS}ms`), READY_TIMEOUT_MS);
    const abandon = (): void => fail('opening the simulator was abandoned');
    signal.addEventListener('abort', abandon, { once: true });
    const read = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-16_384);
      if (output.includes('E2E_SERVER_READY')) {
        clearTimeout(timer);
        signal.removeEventListener('abort', abandon);
        resolve({ process: child, output: tail });
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('error', (cause) => fail(`xcodebuild could not start: ${cause.message}`));
    child.once('exit', () => fail('the engine server exited before it was ready'));
  });
}

/** The engine-protocol transport to the Swift engine server on one simulator; `onOpen` learns which. */
export function iosTransport(options: IosTransportOptions = {}, onOpen: (udid: string) => void = () => {}): EngineTransport {
  return {
    label: 'ios simulator',
    async open(context) {
      const udid = await simulator(options, context.env, context.signal);
      onOpen(udid);
      if (context.app?.appPath !== undefined) await run('xcrun', ['simctl', 'install', udid, path.resolve(context.cwd, context.app.appPath)], context.signal);
      const port = await freePort();
      const server = await startServer(udid, port, options, context.signal);
      let socket: Socket;
      try {
        socket = connect({ host: '127.0.0.1', port });
        socket.setNoDelay(true);
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('error', reject);
        });
      } catch (cause) {
        server.process.kill();
        throw cause;
      }
      return {
        input: socket,
        output: socket,
        diagnostics: () => `simulator ${udid}; xcodebuild output: ${server.output() || '(none)'}`,
        async close(timeoutMs) {
          socket.end();
          const { process: child } = server;
          const exited = new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) resolve();
            else child.once('exit', () => resolve());
          });
          const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(0, timeoutMs));
          await exited;
          clearTimeout(timer);
          socket.destroy();
        },
      };
    },
  };
}

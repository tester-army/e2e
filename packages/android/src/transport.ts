/**
 * The host half of the Android engine: an engine-protocol transport that
 * provisions a device and connects to the engine server on it. Opening a
 * connection installs the server APK when the device lacks this build,
 * installs the target's `appPath`, starts the server as an instrumentation,
 * and forwards a local TCP port to its socket. Every engine message then
 * goes straight to the device; adb only carries the bytes.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import path from 'node:path';
import { ConfigurationError, InfrastructureError, type EngineTransport, type TransportContext } from 'e2e/engine';

/** Options of the Android transport. */
export interface AndroidTransportOptions {
  /** The device's adb serial; defaults to `ANDROID_SERIAL`, else the one device attached. */
  readonly serial?: string;
  /** The adb executable; defaults to the SDK's under `ANDROID_HOME`, else `adb` on `PATH`. */
  readonly adb?: string;
  /** The server APK; defaults to the package's build. */
  readonly serverApk?: string;
}

const SERVER_PACKAGE = 'dev.e2e.android.server';
const RUNNER = `${SERVER_PACKAGE}/dev.e2e.android.EngineInstrumentation`;
const SOCKET = 'e2e-android-engine';
const HASH_FILE = '/data/local/tmp/e2e-android-server.sha256';
/** Budget of each adb call that cleans up on the device. */
const CLEANUP_MS = 3_000;
/** How long the instrumentation may take to start and open its socket. */
const READY_TIMEOUT_MS = 30_000;

const DEFAULT_APK = path.join(import.meta.dirname, '..', 'build', 'e2e-android-server.apk');

/** Runs adb and resolves with its stdout. */
function adb(executable: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...(signal === undefined ? {} : { signal }) }, (error, stdout, stderr) => {
      if (error) reject(new InfrastructureError('ENGINE_FAILURE', `adb ${args.join(' ')} failed: ${stderr.trim() || error.message}`));
      else resolve(stdout);
    });
  });
}

function adbExecutable(options: AndroidTransportOptions, env: TransportContext['env']): string {
  if (options.adb !== undefined) return options.adb;
  const home = env['ANDROID_HOME'] ?? env['ANDROID_SDK_ROOT'];
  const candidate = home === undefined ? undefined : path.join(home, 'platform-tools', 'adb');
  return candidate !== undefined && existsSync(candidate) ? candidate : 'adb';
}

async function deviceSerial(executable: string, options: AndroidTransportOptions, env: TransportContext['env'], signal: AbortSignal): Promise<string> {
  const chosen = options.serial ?? env['ANDROID_SERIAL'];
  if (chosen !== undefined) return chosen;
  const devices = (await adb(executable, ['devices'], signal))
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial !== undefined && serial !== '' && state === 'device')
    .map(([serial]) => serial!);
  if (devices.length !== 1) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      devices.length === 0
        ? 'the android engine found no device: boot an emulator or attach a device'
        : `the android engine found ${devices.length} devices (${devices.join(', ')}): pick one with android({ serial }) or ANDROID_SERIAL`,
    );
  }
  return devices[0]!;
}

/** Installs the server APK unless the device already holds this exact build. */
async function ensureServer(run: (args: readonly string[]) => Promise<string>, apk: string): Promise<void> {
  if (!existsSync(apk)) {
    throw new ConfigurationError('INVALID_CONFIG', `the android engine server is not built (${apk}); run pnpm --filter @e2e-dev/android build:server`);
  }
  const hash = createHash('sha256').update(readFileSync(apk)).digest('hex');
  const installed = (await run(['shell', `cat ${HASH_FILE} 2>/dev/null; pm path ${SERVER_PACKAGE} 2>/dev/null; true`])).trim();
  if (installed.startsWith(hash) && installed.includes('package:')) return;
  await run(['install', '-r', '-t', '-g', apk]).catch(async (cause: unknown) => {
    // A server signed with another key cannot be updated, only replaced.
    if (!String(cause).includes('INSTALL_FAILED_UPDATE_INCOMPATIBLE')) throw cause;
    await run(['uninstall', SERVER_PACKAGE]);
    await run(['install', '-t', '-g', apk]);
  });
  await run(['shell', `echo ${hash} > ${HASH_FILE}`]);
}

/** Starts the instrumentation and resolves once its socket is listening. */
function startServer(executable: string, serial: string, signal: AbortSignal): Promise<{ process: ChildProcess; output: () => string }> {
  const child = spawn(executable, ['-s', serial, 'shell', 'am', 'instrument', '-w', '-r', '-e', 'socket', SOCKET, RUNNER], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const tail = (): string => output.trim().slice(-2048);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(`the engine server did not start within ${READY_TIMEOUT_MS}ms`), READY_TIMEOUT_MS);
    const fail = (reason: string): void => {
      clearTimeout(timer);
      child.kill();
      reject(new InfrastructureError('ENGINE_FAILURE', `${reason}${tail() === '' ? '' : `: ${tail()}`}`));
    };
    const abandon = (): void => fail('opening the device was abandoned');
    signal.addEventListener('abort', abandon, { once: true });
    const read = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-16_384);
      if (output.includes('INSTRUMENTATION_STATUS: ready=true')) {
        clearTimeout(timer);
        signal.removeEventListener('abort', abandon);
        resolve({ process: child, output: tail });
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('exit', () => fail('the engine server exited before it was ready'));
  });
}

/** The engine-protocol transport to the Android engine server on one device. */
export function androidTransport(options: AndroidTransportOptions = {}): EngineTransport {
  return {
    label: 'android device',
    async open(context) {
      const executable = adbExecutable(options, context.env);
      const serial = await deviceSerial(executable, options, context.env, context.signal);
      const run = (args: readonly string[]): Promise<string> => adb(executable, ['-s', serial, ...args], context.signal);
      await ensureServer(run, options.serverApk ?? DEFAULT_APK);
      if (context.app?.appPath !== undefined) await run(['install', '-r', '-t', path.resolve(context.cwd, context.app.appPath)]);
      // Killing the host's `am instrument` leaves the server running on the
      // device, holding its socket; only a force-stop ends it there.
      const stopOnDevice = (signal?: AbortSignal): Promise<unknown> =>
        adb(executable, ['-s', serial, 'shell', 'am', 'force-stop', SERVER_PACKAGE], signal).catch(() => undefined);
      const server = await startServer(executable, serial, context.signal).catch(async (cause: unknown) => {
        // A server that never said it was ready may still have bound its socket.
        await stopOnDevice(AbortSignal.timeout(CLEANUP_MS));
        throw cause;
      });
      let forwarded: number | undefined;
      const unforward = (signal?: AbortSignal): Promise<unknown> =>
        forwarded === undefined ? Promise.resolve() : adb(executable, ['-s', serial, 'forward', '--remove', `tcp:${String(forwarded)}`], signal).catch(() => undefined);
      let socket: Socket;
      try {
        forwarded = Number((await run(['forward', 'tcp:0', `localabstract:${SOCKET}`])).trim());
        socket = connect({ host: '127.0.0.1', port: forwarded });
        socket.setNoDelay(true);
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('error', reject);
        });
      } catch (cause) {
        server.process.kill();
        await unforward(AbortSignal.timeout(CLEANUP_MS));
        await stopOnDevice(AbortSignal.timeout(CLEANUP_MS));
        throw cause;
      }
      return {
        input: socket,
        output: socket,
        diagnostics: () => `device ${serial}; instrumentation output: ${server.output() || '(none)'}`,
        async close(timeoutMs) {
          socket.end();
          const { process: child } = server;
          const exited = new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) resolve();
            else child.once('exit', () => resolve());
          });
          const timer = setTimeout(() => child.kill(), Math.max(0, timeoutMs));
          await exited;
          clearTimeout(timer);
          socket.destroy();
          // The device cleanup gets a short budget of its own: a host process
          // that used the whole budget must still not leave the server
          // running or the port forwarded.
          await unforward(AbortSignal.timeout(CLEANUP_MS));
          await stopOnDevice(AbortSignal.timeout(CLEANUP_MS));
        },
      };
    },
  };
}

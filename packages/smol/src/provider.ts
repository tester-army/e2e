/** Chromium in smol machines as a `BrowserProvider` for the web engine. */

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import type { BrowserLease, BrowserProvider, BrowserProviderScope, BrowserReleaseContext, BrowserRequest } from '@e2e-dev/web';
import { ConfigurationError } from 'e2e/engine';
import { smolMachines, type SmolMachine, type SmolMachines } from './machines.ts';

/**
 * The browser's published port reaches its guest only when its source
 * published that port too. A TCP relay listens here before the browser is
 * ready and stays alive in every branch of the warm machine.
 */
const IMAGE = 'mcr.microsoft.com/playwright:v1.64.1-noble';
const GUEST_PORT = 80;
/** Chromium's new headless mode binds DevTools to loopback whatever it is told, hence the relay. */
const CHROMIUM_CDP_PORT = 9229;

/** Where each browser saves downloads on its machine's own disk, read back through the SDK. */
const DOWNLOADS_DIR = '/tmp/e2e-downloads';

const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY_MB = 2048;

/** How long a new browser has to answer on its DevTools endpoint. */
const CDP_READY_MS = 60_000;

/** How often, and how far apart, `sweep` tries to delete one machine. */
const SWEEP_ATTEMPTS = 5;
const SWEEP_RETRY_MS = 2_000;

/** Where the app's source is mounted, and where the copy it runs from lives. */
const APP_SOURCE_MOUNT = '/e2e-source';
const APP_DIR = '/app';
const APP_LOG = '/tmp/e2e-app.log';
/** How long the app has to answer after `start`, in seconds. */
const APP_READY_SECONDS = 180;

/**
 * An app that runs inside each browser machine, beside the browser, instead
 * of on this computer. In `attempt` scope every attempt's branch then holds
 * its own copy of the running app and everything it wrote to disk, a
 * database included.
 */
export interface SmolApp {
  /**
   * Directory on this computer copied into the machine at `/app`, resolved
   * against the directory the run starts in; `.` by default. `node_modules`,
   * `.git`, and `.e2e` are left out, so dependencies install for the
   * machine's Linux in `setup`.
   */
  readonly source?: string | undefined;
  /**
   * Shell script run as root in `/app` once per browser machine, before
   * `start`: install a runtime and dependencies, create and seed a
   * database. The image already includes Node.js and npm (`npm ci` is enough).
   */
  readonly setup?: string | undefined;
  /** Shell command that serves the app, run in `/app` in the background: `node server.mjs`, `npm start`. */
  readonly start: string;
  /** Port the app listens on inside the machine; the browser opens it as `http://localhost:<port>`. */
  readonly port: number;
  /** Environment for `setup` and `start`. */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export interface SmolOptions {
  /**
   * `attempt` (default): every test attempt gets its own branch of a warm
   * browser machine, a copy-on-write clone of the running Chromium typically
   * ready in about a second, depending on port readiness, and deleted when
   * the attempt ends. `worker`: one browser machine per worker slot for the
   * run, no branching.
   */
  readonly scope?: BrowserProviderScope | undefined;
  /**
   * Shell script run as root once per browser machine, before Chromium
   * starts, in the Ubuntu Playwright image: `apt-get update && apt-get
   * install -y fonts-noto-cjk` for more fonts, a CA certificate, a hosts entry.
   */
  readonly setup?: string | undefined;
  /** vCPUs per browser machine, 2 by default. */
  readonly cpus?: number | undefined;
  /** Memory per browser machine in MiB, 2048 by default. Unused memory goes back to the host. */
  readonly memoryMb?: number | undefined;
  /**
   * Ports on this computer's loopback the browser reaches as its own
   * `localhost`, so an app the run serves at `http://localhost:3000` opens
   * unchanged inside the machine. This is not a network allowlist: the
   * machine can also reach host loopback through `host.smolvm.internal`.
   */
  readonly hostPorts?: readonly number[] | undefined;
  /**
   * Drives the warm browser once before any attempt branches it: sign in,
   * seed storage, open the app. Every attempt then starts from that state.
   * It gets the browser's DevTools endpoint and must disconnect, not close
   * the browser, before it resolves. Runs once per worker slot. `attempt`
   * scope only: in `worker` scope every attempt gets a new browser context,
   * which would never see it.
   */
  readonly prepare?: ((cdpEndpoint: string) => Promise<void>) | undefined;
  /**
   * Runs the app under test inside each browser machine instead of on this
   * computer: its code never runs on the host, and every attempt gets its
   * own copy of the running app and its data. Point the target's `app.url`
   * at `http://localhost:<port>` and declare no `app.command`.
   */
  readonly app?: SmolApp | undefined;
}

/** A browser machine and the DevTools endpoint it publishes on this computer. */
interface Browser {
  readonly machine: SmolMachine;
  readonly endpoint: string;
}

/** A short stable digest, for machine names the engine's socket paths can hold. */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/** A port on this computer's loopback that nothing listens on right now. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('no free port'))));
    });
  });
}

/** Resolves once the DevTools endpoint answers, rejecting after `CDP_READY_MS` or on `signal`. */
async function waitForCdp(endpoint: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + CDP_READY_MS;
  let last = 'no answer';
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (cause) {
      signal.throwIfAborted();
      last = cause instanceof Error ? cause.message : String(cause);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`browser at ${endpoint} did not answer within ${CDP_READY_MS / 1000}s (${last})`);
}

/** Runs `command` in the background, past the end of the exec that starts it. */
function detached(command: string, log = '/dev/null'): string {
  return `nohup setsid ${command} </dev/null >${log} 2>&1 &`;
}

/** Forward raw TCP so DevTools WebSocket upgrades keep their Host header and connection state. */
const TCP_RELAY = `const net = require('node:net');
const [listen, host, port, bind] = process.argv.slice(1);
net.createServer((client) => {
  const peer = net.connect(Number(port), host);
  client.setNoDelay(true);
  peer.setNoDelay(true);
  client.on('error', () => peer.destroy());
  peer.on('error', () => client.destroy());
  client.on('close', () => peer.destroy());
  peer.on('close', () => client.destroy());
  client.pipe(peer);
  peer.pipe(client);
}).listen(Number(listen), bind);`;

/** Run a TCP relay in the guest after the shell command returns. */
function tcpRelay(listen: number, host: string, port: number, bind: string, log = '/dev/null'): string {
  return detached(`node -e ${shellQuote(TCP_RELAY)} ${listen} ${shellQuote(host)} ${port} ${shellQuote(bind)}`, log);
}

/** Start the pinned Chromium build and relay its DevTools and requested host ports. */
function startScript(setup: string | undefined, hostPorts: readonly number[]): string {
  return [
    'set -e',
    ...(setup === undefined ? [] : [setup]),
    `mkdir -p ${DOWNLOADS_DIR}`,
    'chrome=$(find /ms-playwright -maxdepth 3 -type f -name chrome | head -n 1)',
    '[ -x "$chrome" ] || { echo "Playwright Chromium is missing from the browser image" >&2; exit 1; }',
    // The machine's loopback is its own; the host's is behind host.smolvm.internal.
    ...hostPorts.map((port) => tcpRelay(port, 'host.smolvm.internal', port, '127.0.0.1')),
    tcpRelay(GUEST_PORT, '127.0.0.1', CHROMIUM_CDP_PORT, '0.0.0.0', '/tmp/e2e-cdp-relay.log'),
    // A history restore from Chromium's back/forward cache emits no load event
    // over CDP, so Playwright goBack({ waitUntil: 'load' }) otherwise hangs.
    detached(
      `"$chrome" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check --disable-features=BackForwardCache --remote-debugging-port=${CHROMIUM_CDP_PORT} --user-data-dir=/tmp/e2e-chromium about:blank`,
      '/tmp/e2e-chromium.log',
    ),
    `ready=; for i in $(seq 300); do if curl -fsS --max-time 1 http://127.0.0.1:${GUEST_PORT}/json/version >/dev/null 2>&1; then ready=1; break; fi; sleep 0.1; done`,
    '[ -n "$ready" ] || { echo "chromium did not start:" >&2; tail -5 /tmp/e2e-chromium.log >&2; tail -5 /tmp/e2e-cdp-relay.log >&2; exit 1; }',
  ].join('\n');
}

/** A shell variable name, the only form `app.env` names are exported under. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Refuses a port the machine cannot give the browser's `localhost`: out of range, or one the browser itself uses. */
function checkPort(what: string, port: unknown): void {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535 || port === GUEST_PORT || port === CHROMIUM_CDP_PORT) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `smol: ${what} must be a port from 1 to 65535 other than ${GUEST_PORT} and ${CHROMIUM_CDP_PORT}, which the browser uses; got ${JSON.stringify(port)}`,
    );
  }
}

/** `value` as one single-quoted shell word. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/** The script that copies the app in, runs its `setup`, starts it, and waits until it answers. */
function appScript(app: SmolApp): string {
  const exports = Object.entries(app.env ?? {}).map(([name, value]) => `export ${name}=${shellQuote(value)}`);
  return [
    'set -e',
    ...exports,
    `mkdir -p ${APP_DIR}`,
    `tar -C ${APP_SOURCE_MOUNT} --exclude=./node_modules --exclude=./.git --exclude=./.e2e -cf - . | tar -C ${APP_DIR} -xf -`,
    `cd ${APP_DIR}`,
    ...(app.setup === undefined ? [] : [app.setup]),
    detached(`sh -c ${shellQuote(app.start)}`, APP_LOG),
    // Any HTTP status means the app answered; connection failures report 000.
    `ready=; for i in $(seq ${APP_READY_SECONDS * 4}); do code=$(curl -s -o /dev/null --max-time 1 -w '%{http_code}' http://127.0.0.1:${app.port}/) || true; if [ -n "$code" ] && [ "$code" != 000 ]; then ready=1; break; fi; sleep 0.25; done`,
    `[ -n "$ready" ] || { echo "the app did not answer on port ${app.port} within ${APP_READY_SECONDS}s:" >&2; tail -20 ${APP_LOG} >&2; exit 1; }`,
  ].join('\n');
}

/**
 * Chromium in smol machines for `web({ browser: smol() })`. Each worker slot
 * boots one browser machine on this computer's smol engine and, with
 * `prepare`, drives it into the state tests start from. In `attempt` scope
 * (the default) every attempt then gets a live copy-on-write branch of that
 * running browser, cookies, storage, and open pages included, and the branch
 * is deleted when the attempt ends. Machines are labeled with the run and
 * target, and named after both, so `sweep` deletes what a dead worker left.
 */
export function smol(options: SmolOptions = {}): BrowserProvider {
  const { scope = 'attempt', setup, cpus = DEFAULT_CPUS, memoryMb = DEFAULT_MEMORY_MB, hostPorts = [], prepare, app } = options;
  for (const port of hostPorts) checkPort(`hostPorts entry`, port);
  if (app !== undefined) {
    checkPort('app.port', app.port);
    for (const name of Object.keys(app.env ?? {})) {
      if (!ENV_NAME.test(name)) {
        throw new ConfigurationError('INVALID_CONFIG', `smol: app.env name ${JSON.stringify(name)} is not a shell variable name (letters, digits, and _, not starting with a digit)`);
      }
    }
    if (hostPorts.includes(app.port)) {
      throw new ConfigurationError('INVALID_CONFIG', `smol: port ${app.port} is both app.port and in hostPorts; the browser's localhost:${app.port} can be only one of them`);
    }
  }
  const appSource = app === undefined ? undefined : path.resolve(app.source ?? '.');
  if (prepare !== undefined && scope === 'worker') {
    // A worker-scope browser gives every attempt a new context, which never sees what prepare left in the default one.
    throw new ConfigurationError('INVALID_CONFIG', 'smol: prepare needs scope "attempt"; with scope "worker" every attempt gets a new browser context, so use sessions there');
  }
  const machines: SmolMachines = smolMachines();
  const prefixFor = (runId: string, targetName: string) => `e2e-${digest(`${runId}\n${targetName}`)}`;

  /** Boots one browser machine, starts Chromium in it, and runs `prepare` on it. */
  const boot = async (request: BrowserRequest, name: string): Promise<Browser> => {
    request.signal.throwIfAborted();
    const hostPort = await freePort();
    request.signal.throwIfAborted();
    const machine = await machines.create({
      name,
      image: IMAGE,
      cpus,
      memoryMb,
      port: { host: hostPort, guest: GUEST_PORT },
      labels: { e2e_run: request.runId, e2e_target: request.targetName },
      // A worker-scope browser is made in the runner and read from a worker; an attempt-scope one lives and dies with its worker, so the engine deletes it when the worker exits however it exits.
      persistent: scope === 'worker',
      ...(appSource === undefined ? {} : { mount: { source: appSource, target: APP_SOURCE_MOUNT } }),
    });
    const endpoint = `http://127.0.0.1:${hostPort}`;
    try {
      request.signal.throwIfAborted();
      await machine.shell(startScript(setup, hostPorts), request.signal);
      if (app !== undefined) await machine.shell(appScript(app), request.signal);
      await waitForCdp(endpoint, request.signal);
      if (prepare !== undefined) await prepare(endpoint);
      return { machine, endpoint };
    } catch (cause) {
      await machines.delete(name).catch(() => false);
      throw cause;
    }
  };

  /** Each slot's warm browser in this process, booted by the first attempt that needs it. */
  const warm = new Map<string, Promise<Browser>>();
  const warmFor = (request: BrowserRequest): Promise<Browser> => {
    const slot = `${prefixFor(request.runId, request.targetName)}-w${request.slot}`;
    let browser = warm.get(slot);
    if (browser === undefined) {
      // Use a new name even when a failed boot left an undeletable machine.
      browser = boot(request, `${slot}-${randomBytes(6).toString('hex')}`);
      warm.set(slot, browser);
      // A timed-out attempt must not lend its still-running boot to a replacement worker.
      const discard = () => { if (warm.get(slot) === browser) warm.delete(slot); };
      request.signal.addEventListener('abort', discard, { once: true });
      if (request.signal.aborted) discard();
      void browser.then(
        () => request.signal.removeEventListener('abort', discard),
        () => { request.signal.removeEventListener('abort', discard); discard(); },
      );
    }
    return browser;
  };

  return {
    name: 'smol',
    scope,
    async acquire(request: BrowserRequest): Promise<BrowserLease> {
      if (scope === 'worker') {
        // A worker whose browser dropped leases a replacement for its slot while the dropped one is still held,
        // in this process or the runner's, so every lease gets a name of its own.
        const name = `${prefixFor(request.runId, request.targetName)}-s${request.slot}-${randomBytes(3).toString('hex')}`;
        const { endpoint } = await boot(request, name);
        request.log(`browser machine ${name}`);
        return { id: name, cdpEndpoint: endpoint };
      }
      const source = await warmFor(request);
      const name = `${source.machine.name}-${digest(request.attemptId ?? String(Date.now()))}`;
      const hostPort = await freePort();
      const started = Date.now();
      const endpoint = `http://127.0.0.1:${hostPort}`;
      try {
        // A branch that fails partway can still leave a machine under its name.
        await source.machine.branch(name, { host: hostPort, guest: GUEST_PORT });
        await waitForCdp(endpoint, request.signal);
      } catch (cause) {
        await machines.delete(name).catch(() => false);
        throw cause;
      }
      request.log(`browser ${name}, branched from ${source.machine.name} in ${Date.now() - started} ms`);
      return { id: name, cdpEndpoint: endpoint };
    },
    async release(lease: BrowserLease): Promise<void> {
      await machines.delete(lease.id);
    },
    async sweep(context: BrowserReleaseContext): Promise<readonly string[]> {
      const prefix = prefixFor(context.runId, context.targetName);
      // Longest name first, so a branch goes before the warm browser it came from.
      const open = (await machines.list()).filter((name) => name.startsWith(`${prefix}-`)).toSorted((a, b) => b.length - a.length);
      const deleted: string[] = [];
      const failed: string[] = [];
      for (const name of open) {
        // A worker that just exited may still have the engine stopping its machines; a delete then fails until the stop settles.
        for (let attempt = 1; ; attempt += 1) {
          try {
            if (await machines.delete(name)) deleted.push(name);
            break;
          } catch (cause) {
            if (attempt < SWEEP_ATTEMPTS && !context.signal.aborted) {
              await new Promise((resolve) => setTimeout(resolve, SWEEP_RETRY_MS));
              continue;
            }
            failed.push(`${name} (${cause instanceof Error ? cause.message : String(cause)})`);
            break;
          }
        }
      }
      if (failed.length > 0) throw new Error(`deleted ${deleted.length === 0 ? 'none' : deleted.join(', ')}; could not delete ${failed.join(', ')}`);
      return deleted;
    },
    downloads: {
      dir: DOWNLOADS_DIR,
      read: async (lease, file) => machines.readFile(lease.id, file),
    },
  };
}

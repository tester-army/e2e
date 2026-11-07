/** Chromium in E2B sandboxes as a `BrowserProvider` for the web engine. */

import type { BrowserLease, BrowserProvider, BrowserProviderScope, BrowserReleaseContext, BrowserRequest } from '@e2e-dev/web';
import { rejectUnknownKeys } from 'e2e/engine';
import { sandboxClients, type E2BSandbox } from './client.ts';
import { leaseMetadata, messageOf, poll, sandboxLeases, templateOption, timeoutOption, withLog } from './lease.ts';
import type { Tunnel } from './tunnel.ts';

export interface E2BBrowsersOptions {
  /**
   * Sandbox template with Playwright's Chromium under `/ms-playwright`, such as one built from the Playwright image
   * `@e2e-dev/web` pins. `e2e-chromium` by default.
   */
  readonly template?: string | undefined;
  /**
   * `worker` (default): one browser sandbox per worker slot, leased in
   * `prepare` and released in `finish`. `attempt`: a fresh sandbox per test
   * attempt.
   */
  readonly scope?: BrowserProviderScope | undefined;
  /**
   * How long a sandbox lives before E2B kills it, in milliseconds. Defaults to
   * one hour: the backstop for a run that died before it could release.
   */
  readonly timeoutMs?: number | undefined;
}

const OPTION_KEYS: readonly string[] = Object.keys({
  template: true,
  scope: true,
  timeoutMs: true,
} satisfies Record<keyof E2BBrowsersOptions, true>);

const DEFAULT_TEMPLATE = 'e2e-chromium';
const DEFAULT_TIMEOUT_MS = 60 * 60_000;

/** Chromium's DevTools port, on the sandbox's loopback only. */
const CHROMIUM_CDP_PORT = 9222;

/**
 * Chromium refuses a DevTools request whose `Host` is neither an IP address
 * nor localhost, which every request through E2B's public host would be, so
 * E2B's edge rewrites `Host` to this on the way into the sandbox. `${PORT}`
 * is E2B's placeholder for the port, not a template literal.
 */
const MASKED_HOST = 'localhost:${PORT}';

/** Where each browser saves downloads on its own disk, for the engine to read back through the sandbox filesystem. */
const DOWNLOADS_DIR = '/tmp/e2e-downloads';

/** Chromium's output, read into the error when it never answers. */
const CHROMIUM_LOG = '/tmp/e2e-chromium.log';

/** Bounds Chromium's start and its first answer from outside, together. */
const START_TIMEOUT_MS = 60_000;

/**
 * Finds the template's Playwright Chromium and prints its path, run in the foreground so a
 * template without it fails the lease at once, with this message, instead of at the start timeout.
 */
const FIND_CHROMIUM = [
  `mkdir -p ${DOWNLOADS_DIR}`,
  'chrome=$(find /ms-playwright -maxdepth 3 -type f -name chrome | head -n 1)',
  '[ -x "$chrome" ] || { echo "Playwright Chromium is missing from the sandbox template: no /ms-playwright/*/chrome-linux*/chrome" >&2; exit 1; }',
  'printf %s "$chrome"',
].join('\n');

/** A path `find` printed for Chromium, as the only shape that reaches the start command. */
const CHROMIUM_PATH = /^\/ms-playwright\/[\w./-]+$/;

/** Starts Chromium at `chrome` headless, with DevTools on loopback. */
function startChromium(chrome: string): string {
  if (!CHROMIUM_PATH.test(chrome)) throw new Error(`unexpected Chromium path ${JSON.stringify(chrome)} in the sandbox template`);
  // A history restore from Chromium's back/forward cache emits no load event
  // over CDP, so Playwright goBack({ waitUntil: 'load' }) otherwise hangs.
  return `exec ${chrome} --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check --disable-features=BackForwardCache --remote-debugging-port=${CHROMIUM_CDP_PORT} --user-data-dir=/tmp/e2e-chromium about:blank > ${CHROMIUM_LOG} 2>&1`;
}

/** The browser WebSocket URL in a `/json/version` answer, or `undefined`. */
function debuggerUrl(body: unknown): unknown {
  return typeof body === 'object' && body !== null && 'webSocketDebuggerUrl' in body ? body.webSocketDebuggerUrl : undefined;
}

/**
 * Polls Chromium through the tunnel until it answers, and resolves to its
 * browser WebSocket endpoint on the tunnel. Chromium reports the endpoint
 * under the masked `localhost` host, so only its path is kept: the endpoint a
 * lease carries is a bare loopback URL.
 */
function browserEndpoint(tunnel: Tunnel, signal: AbortSignal): Promise<string> {
  return poll('Chromium did not answer through the sandbox tunnel', signal, async (attempt) => {
    const response = await fetch(`${tunnel.url}/json/version`, { signal: attempt });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const endpoint = debuggerUrl(await response.json());
    const path = typeof endpoint === 'string' && URL.canParse(endpoint) ? new URL(endpoint).pathname : '';
    if (!path.startsWith('/devtools/browser/')) throw new Error('no WebSocket endpoint in /json/version');
    return `${tunnel.url.replace(/^http:/, 'ws:')}${path}`;
  });
}

/**
 * E2B browsers for `web({ browser: e2bBrowsers() })`: Chromium in an E2B
 * sandbox per worker slot, or per attempt with `scope: 'attempt'`. Chromium
 * listens on the sandbox's loopback, and E2B's edge masks each request's
 * `Host` as localhost so DevTools accepts it. The sandbox refuses public
 * traffic: the lease's `cdpEndpoint` is a loopback tunnel on the runner's
 * machine that adds E2B's traffic access token, so it carries no secret.
 * Sandboxes are tagged with the run, target, slot, and attempt, killed at
 * release, swept at the end of the run, and killed by E2B after `timeoutMs`
 * if the run died first.
 */
export function e2bBrowsers(options: E2BBrowsersOptions = {}): BrowserProvider {
  rejectUnknownKeys('e2bBrowsers()', options, OPTION_KEYS);
  const template = templateOption('e2bBrowsers()', options.template, DEFAULT_TEMPLATE);
  const timeoutMs = timeoutOption('e2bBrowsers()', options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const clientFor = sandboxClients();
  const leases = sandboxLeases(clientFor);

  /** Starts Chromium and resolves to the endpoint a worker attaches to, through the lease's tunnel. */
  async function ready(sandbox: E2BSandbox, tunnel: Tunnel, request: BrowserRequest): Promise<BrowserLease> {
    request.log(`browser sandbox ${sandbox.sandboxId}`);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(START_TIMEOUT_MS)]);
    const chrome = await sandbox.run(FIND_CHROMIUM, { timeoutMs: START_TIMEOUT_MS, signal });
    await sandbox.start(startChromium(chrome.trim()), { signal });
    const cdpEndpoint = await browserEndpoint(tunnel, signal).catch(async (cause: unknown) => {
      throw await withLog(sandbox, CHROMIUM_LOG, cause);
    });
    return { id: sandbox.sandboxId, cdpEndpoint };
  }

  return {
    name: 'e2b',
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    async acquire(request: BrowserRequest): Promise<BrowserLease> {
      const metadata = { ...leaseMetadata(request), ...(request.attemptId === undefined ? {} : { e2e_attempt: request.attemptId }) };
      return leases.acquire(request, { template, timeoutMs, metadata, maskRequestHost: MASKED_HOST, port: CHROMIUM_CDP_PORT }, (sandbox, tunnel) => ready(sandbox, tunnel, request));
    },
    release: (lease: BrowserLease, context: BrowserReleaseContext) => leases.release(lease.id, context),
    async sweep(context: BrowserReleaseContext): Promise<readonly string[]> {
      const client = clientFor(context.env);
      const open = await client.list({ e2e_run: context.runId, e2e_target: context.targetName }, context.signal);
      const settled = await Promise.allSettled(open.map((id) => client.kill(id, context.signal)));
      const killed: string[] = [];
      const failed: string[] = [];
      settled.forEach((result, index) => {
        const id = open[index]!;
        if (result.status === 'rejected') {
          failed.push(`${id} (${messageOf(result.reason)})`);
        } else if (result.value) {
          killed.push(id);
        }
      });
      if (failed.length > 0) {
        throw new Error(`killed ${killed.length === 0 ? 'none' : killed.join(', ')}; could not kill ${failed.join(', ')}, so E2B ends them after timeoutMs`);
      }
      return killed;
    },
    downloads: {
      dir: DOWNLOADS_DIR,
      read: (lease, file, context) => clientFor(context.env).readFile(lease.id, file, context.signal),
    },
  };
}

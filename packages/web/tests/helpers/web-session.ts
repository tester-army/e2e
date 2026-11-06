/**
 * One web engine hosted by the runner for an integration test: a launched
 * browser, one open attempt, the attempt's real `browser` fixture, and a
 * local server that serves the pages a test writes inline.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'vitest';
import type {
  EngineAttemptContext,
  EngineFixtureContext,
  EngineHandle,
  EngineObserveOptions,
  EngineSnapshot,
  Expectable,
  LocatorAction,
  LocatorExpression,
  OperationContext,
  SemanticNode,
} from 'e2e/engine';
import { openHost, type E2EHost, type E2ESession } from 'e2e/runner';
import type { TargetApp } from 'e2e';
import { web, type Browser, type WebOptions } from '../../src/index.ts';
import { BROWSER_NAMES, isBrowserName, type BrowserName } from '../../src/browsers.ts';
import { readSemanticsFunction } from '../../src/in-page/read-semantics.ts';
import { SECURE_FIELD_SELECTOR, type RawNodeData } from '../../src/in-page/read-node.ts';

/** Answers one request the page server got for a path a test registered. */
export type PageHandler = (request: IncomingMessage, response: ServerResponse) => void;

/** The attempt sinks a test may listen on beside the runner's own. */
export type AttemptSinks = Partial<Pick<EngineAttemptContext, 'appLog' | 'navigation' | 'screen' | 'environment'>>;

/**
 * The browser the integration suite runs on: `E2E_WEB_BROWSER` (the
 * `integration-firefox` project sets it), else chromium.
 */
export function testBrowser(): BrowserName {
  const name = process.env['E2E_WEB_BROWSER'] ?? 'chromium';
  if (!isBrowserName(name)) throw new Error(`E2E_WEB_BROWSER must be one of ${BROWSER_NAMES.join(', ')}, got "${name}"`);
  return name;
}

/** Whether the suite runs on Firefox, for a test that names a Firefox limit in its skip. */
export const onFirefox = testBrowser() === 'firefox';

/** `it`, or `it.fails` on Firefox: for a test a named Firefox bug fails today, so the run says when the bug is fixed. */
export const itFailsOnFirefox = onFirefox ? it.fails : it;

/** `web(options)` on the suite's browser, for a test that drives the engine contract by hand. */
export function testWeb(options: WebOptions = {}): EngineHandle {
  return web({ browser: testBrowser(), ...options });
}

/** How to boot the session. */
export interface WebSessionOptions {
  /** The browser; defaults to `testBrowser()`. A `web.browser` wins. */
  readonly browser?: BrowserName;
  /** The `web()` options. */
  readonly web?: WebOptions;
  /** The app's URL; defaults to the page server's origin. */
  readonly appUrl?: string;
  /** App fields beside the URL, such as the permissions it holds. */
  readonly app?: Omit<TargetApp, 'url'>;
  /** Static secrets the config declares, by name. */
  readonly secrets?: Readonly<Record<string, string>>;
  /** The action timeout, every operation's budget; defaults to 30 s. */
  readonly timeoutMs?: number;
  /** Sinks that hear what the engine tells each attempt's trace, beside the runner. */
  readonly attempt?: AttemptSinks;
  /** The project root `{ path }` init scripts and uploads resolve against; defaults to a fresh directory. */
  readonly projectRoot?: string;
  /** Whether to start the attempt at boot; defaults to true. */
  readonly startAttempt?: boolean;
}

export interface WebSession {
  readonly engine: EngineHandle;
  /** The `browser` fixture of the current attempt. */
  readonly browser: Browser;
  /** The page server's origin, `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** The current attempt's artifact directory. */
  readonly artifactsDir: string;
  readonly projectRoot: string;
  /** The ids of the artifacts the current attempt's steps attached, in order. */
  artifacts(): string[];
  /** A fresh operation context for the current attempt. */
  op(timeoutMs?: number): OperationContext;
  /** Serves `body` (HTML) or a handler at `pathname` and returns its URL. */
  serve(pathname: string, body: string | PageHandler): string;
  /** Serves `html` at a fresh path and opens it. */
  setContent(html: string): Promise<void>;
  /** Opens `url` through the session contract. */
  open(url: string): Promise<void>;
  /** One observation. */
  observe(options?: EngineObserveOptions): Promise<EngineSnapshot>;
  /** Every node of one observation, depth first. */
  nodes(options?: EngineObserveOptions): Promise<SemanticNode[]>;
  /** The nodes `expression` resolves to. */
  locate(expression: LocatorExpression): Promise<readonly SemanticNode[]>;
  /** Locates exactly one node for `expression` and performs `action` on it. */
  act(expression: LocatorExpression, action: LocatorAction): Promise<void>;
  /** The in-page reader's node read of the first element `selector` matches. */
  readNode(selector: string): Promise<RawNodeData>;
  /** Resolves once every iframe of the top document finished loading. */
  waitForFrames(): Promise<void>;
  /** Starts a new attempt, ending the current one first if it is open. */
  startAttempt(): Promise<void>;
  /** Ends the current attempt; throws what its close reported. */
  endAttempt(): Promise<void>;
  /** Ends the attempt, closes the host, and closes the page server. */
  close(): Promise<void>;
}

/** The session deadline: long enough that a file-wide attempt never hits it, so each operation's own budget decides. */
const SESSION_DEADLINE_MS = 600_000;

/** Every node under `node`, depth first, `node` first. */
function flatten(node: SemanticNode, out: SemanticNode[] = []): SemanticNode[] {
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}

/** A role query with an exact role and, when given, an exact name. */
export function byRole(role: string, name?: string): LocatorExpression {
  return {
    kind: 'query',
    query: {
      kind: 'role',
      value: { kind: 'string', value: role, exact: true },
      ...(name === undefined ? {} : { name: { kind: 'string', value: name, exact: true } }),
    },
  };
}

/** A test id query. */
export function byTestId(testId: string): LocatorExpression {
  return { kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: testId, exact: true } } };
}

/** A CSS selector expression. */
export function bySelector(selector: string): LocatorExpression {
  return { kind: 'selector', selector };
}

/** A local HTTP server for the pages a test writes inline. */
export interface PageServer {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** Serves `body` (HTML) or a handler at `pathname` and returns its URL. */
  serve(pathname: string, body: string | PageHandler): string;
  /** Closes the server and every connection it holds. */
  close(): Promise<void>;
}

/** Starts a page server on an ephemeral port. */
export async function startPageServer(): Promise<PageServer> {
  const pages = new Map<string, string | PageHandler>();
  const server: Server = createServer((request, response) => {
    const page = pages.get(new URL(request.url ?? '/', 'http://pages.test').pathname);
    if (typeof page === 'function') return page(request, response);
    if (page === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    origin,
    serve(pathname, body) {
      pages.set(pathname, body);
      return `${origin}${pathname}`;
    },
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

/** What a `browser` fixture over a hand-driven engine reads of its harness. */
export interface FixtureOptions {
  /** The base URL relative navigations resolve against. */
  readonly baseUrl: string;
  readonly site?: string;
  /** The per-operation budget; defaults to 30 s. */
  readonly timeoutMs?: number;
  /** Receives each artifact path the fixture attaches. */
  readonly attach?: (relative: string) => void;
  /** Overrides the operation context each call gets, to record the budgets the fixture asks for. */
  readonly operation?: (timeoutMs?: number) => OperationContext;
}

/**
 * The `browser` fixture over an engine a test drives through the engine
 * contract by hand (its own `init` and `startAttempt`, a provider, a lease),
 * which no runner hosts. The context records no steps and mints no
 * locators; a test that needs neither the hand-driven lifecycle nor a
 * provider uses `startWebSession`, whose fixture is the runner's own.
 */
export function browserFixture(engine: EngineHandle, options: FixtureOptions): Browser {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const unsupported = (what: string) => () => {
    throw new Error(`${what} needs the runner: use startWebSession`);
  };
  const context: EngineFixtureContext = {
    targetName: 'web',
    app: {
      ...(options.site === undefined ? {} : { site: options.site }),
      resolveUrl: (url) => new URL(url, `${options.baseUrl}/`).href,
    },
    timeouts: { test: timeoutMs, action: timeoutMs, assertion: 5_000 },
    signal: new AbortController().signal,
    operation: options.operation ?? ((budget) => ({ signal: new AbortController().signal, timeoutMs: budget ?? timeoutMs, runId: 'run-web-session', attemptId: 'attempt', origin: 'test' })),
    attachArtifact: (_kind, relative) => options.attach?.(relative),
    attachViewport: () => undefined,
    locator: unsupported('a locator'),
    screen: unsupported('a screen scope'),
    expectable: <T extends object, E extends object>(target: T): T & Expectable<E> => target as T & Expectable<E>,
    fixture: (_name, surface) => surface,
  };
  return engine.fixtures!['browser']!(context) as Browser;
}

/** `engine` with each attempt's trace sinks teed to `sinks` as well as the runner's. */
function withAttemptSinks(engine: EngineHandle, sinks: AttemptSinks | undefined): EngineHandle {
  if (sinks === undefined) return engine;
  return {
    ...engine,
    startAttempt: (context) => {
      const teed: Record<string, (...args: never[]) => void> = {};
      for (const [key, extra] of Object.entries(sinks) as [keyof AttemptSinks, (...args: never[]) => void][]) {
        const own = context[key] as ((...args: never[]) => void) | undefined;
        teed[key] = (...args) => {
          own?.(...args);
          extra(...args);
        };
      }
      return engine.startAttempt!({ ...context, ...teed });
    },
  };
}

/**
 * Boots a web engine through the runner's public host (`openHost` from
 * `e2e/runner`), starts one attempt, and hands back the attempt's real
 * `browser` fixture beside the engine's own contract. The browser is
 * `options.browser`, else the one `testBrowser()` names.
 */
export async function startWebSession(options: WebSessionOptions = {}): Promise<WebSession> {
  const server = await startPageServer();
  const { origin } = server;
  const engine = web({ browser: options.browser ?? testBrowser(), ...options.web });
  const ownRoot = options.projectRoot === undefined ? mkdtempSync(path.join(tmpdir(), 'e2e-web-root-')) : undefined;
  const projectRoot = options.projectRoot ?? ownRoot!;
  // The runner keeps output inside the project.
  const output = mkdtempSync(path.join(projectRoot, '.e2e-session-'));
  const timeoutMs = options.timeoutMs ?? 30_000;
  type Fixtures = { browser: Browser };
  let host: E2EHost<Fixtures> | undefined;
  let attempt: E2ESession<Fixtures> | undefined;
  let attemptCount = 0;
  let attemptController = new AbortController();
  let contentCount = 0;

  const live = (): E2ESession<Fixtures> => {
    if (attempt === undefined) throw new Error('no attempt is open');
    return attempt;
  };

  const op = (budget = timeoutMs): OperationContext => ({
    signal: attemptController.signal,
    timeoutMs: budget,
    runId: host?.runId ?? 'run-web-session',
    attemptId: attempt?.attemptId ?? 'no-attempt',
    origin: 'test',
  });

  const session: WebSession = {
    engine,
    get browser() { return live().fixtures.browser; },
    origin,
    get artifactsDir() { return live().artifactsDir; },
    projectRoot,
    artifacts: () => live().steps().flatMap((step) => step.artifacts),
    op,
    serve: (pathname, body) => server.serve(pathname, body),
    async setContent(html) {
      contentCount += 1;
      await session.open(session.serve(`/content-${String(contentCount)}`, html));
    },
    open: (url) => engine.session!.open!(url, op()),
    observe: (observeOptions) => engine.observe!(op(), observeOptions),
    nodes: async (observeOptions) => flatten((await engine.observe!(op(), observeOptions)).root),
    locate: (expression) => engine.locate!(expression, op()),
    async act(expression, action) {
      const located = await engine.locate!(expression, op());
      if (located.length !== 1) throw new Error(`expected one node for ${JSON.stringify(expression)}, located ${String(located.length)}`);
      await engine.perform!(located[0]!.ref, action, op());
    },
    readNode: (selector) => session.browser.evaluate(
      `({ selector, options }) => (${readSemanticsFunction.toString()})(document.querySelector(selector), options)`,
      { selector, options: { testIdAttribute: 'data-testid', secureFieldSelector: SECURE_FIELD_SELECTOR, mode: { kind: 'node' } } },
    ) as unknown as Promise<RawNodeData>,
    waitForFrames: () => session.browser.evaluate(async () => {
      const loaded = (frame: HTMLIFrameElement) => frame.contentDocument === null || frame.contentDocument.readyState === 'complete';
      while (![...document.querySelectorAll('iframe')].every(loaded)) await new Promise((resolve) => setTimeout(resolve, 20));
      return null;
    }).then(() => undefined),
    async startAttempt() {
      if (attempt !== undefined) await session.endAttempt();
      attemptCount += 1;
      attemptController = new AbortController();
      attempt = await host!.openSession({ name: `attempt ${String(attemptCount)}`, timeout: SESSION_DEADLINE_MS });
    },
    async endAttempt() {
      const ending = attempt;
      if (ending === undefined) return;
      attempt = undefined;
      attemptController.abort();
      const failures = await ending.close();
      if (failures.length > 0) throw new AggregateError(failures, `ending the attempt failed: ${failures.map((failure) => failure.message).join('; ')}`);
    },
    async close() {
      const ended = await session.endAttempt().then(() => undefined, (error: unknown) => error);
      const failures = (await host?.close()) ?? [];
      await server.close();
      rmSync(output, { recursive: true, force: true });
      if (ownRoot !== undefined) rmSync(ownRoot, { recursive: true, force: true });
      if (ended !== undefined) throw ended;
      if (failures.length > 0) throw new AggregateError(failures, `closing the host failed: ${failures.map((failure) => failure.message).join('; ')}`);
    },
  };

  try {
    host = await openHost<Fixtures>({
      cwd: projectRoot,
      env: {},
      config: {
        targets: [{ engine: withAttemptSinks(engine, options.attempt), app: { ...options.app, url: options.appUrl ?? origin } }],
        timeout: SESSION_DEADLINE_MS,
        actionTimeout: timeoutMs,
        video: 'off',
        output,
        ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
      },
    });
    if (options.startAttempt !== false) await session.startAttempt();
  } catch (cause) {
    await session.close().catch(() => undefined);
    throw cause;
  }
  return session;
}

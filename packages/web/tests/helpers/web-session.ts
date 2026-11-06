/**
 * One web engine booted through its public contract for an integration test:
 * a launched browser, one open attempt, the `browser` fixture over it, and a
 * local server that serves the pages a test writes inline.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  EngineAttemptContext,
  EngineFixtureContext,
  EngineHandle,
  EngineObserveOptions,
  EngineSnapshot,
  LocatorExpression,
  OperationContext,
  SemanticNode,
} from 'e2e/engine';
import { web, type Browser, type WebOptions } from '../../src/index.ts';
import { ignoreTrace, noSecrets } from './secrets.ts';

/** Answers one request the page server got for a path a test registered. */
export type PageHandler = (request: IncomingMessage, response: ServerResponse) => void;

/** How to boot the session. */
export interface WebSessionOptions {
  /** The `web()` options. */
  readonly web?: WebOptions;
  /** The site the app declares; defaults to the page server's host. */
  readonly site?: string | null;
  /** The per-operation budget; defaults to 30 s. */
  readonly timeoutMs?: number;
  /** Fields of the attempt context beside the defaults: secrets, trace sinks. */
  readonly attempt?: Partial<Omit<EngineAttemptContext, 'attemptId' | 'artifactsDir' | 'signal'>>;
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
  readonly artifactsDir: string;
  readonly projectRoot: string;
  /** The artifact paths the fixture attached, in order. */
  readonly attached: string[];
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
  /** Starts a new attempt, ending the current one first if it is open. */
  startAttempt(attemptId?: string): Promise<void>;
  /** Ends the current attempt. */
  endAttempt(): Promise<void>;
  /** Ends the attempt, disposes the engine, and closes the page server. */
  close(): Promise<void>;
}

/** Every node under `node`, depth first, `node` first. */
export function flatten(node: SemanticNode, out: SemanticNode[] = []): SemanticNode[] {
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

/** Starts the page server on an ephemeral port. */
async function startPageServer(pages: Map<string, string | PageHandler>): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
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
  return { server, origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` };
}

/**
 * Boots a web engine, starts one attempt, and builds the `browser` fixture
 * over it with a context that records no steps.
 */
export async function startWebSession(options: WebSessionOptions = {}): Promise<WebSession> {
  const pages = new Map<string, string | PageHandler>();
  const { server, origin } = await startPageServer(pages);
  const engine = web(options.web ?? {});
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-web-session-'));
  const ownRoot = options.projectRoot === undefined ? mkdtempSync(path.join(tmpdir(), 'e2e-web-root-')) : undefined;
  const projectRoot = options.projectRoot ?? ownRoot!;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const attached: string[] = [];
  const site = options.site === undefined ? '127.0.0.1' : options.site;
  let attemptId = 'attempt-1';
  let attemptOpen = false;
  let attemptController = new AbortController();
  let contentCount = 0;
  let browser: Browser | undefined;

  const op = (budget = timeoutMs): OperationContext => ({
    signal: attemptController.signal,
    timeoutMs: budget,
    runId: 'run-web-session',
    attemptId,
    origin: 'test',
  });

  const fixtureContext = {
    targetName: 'web',
    app: {
      ...(site === null ? {} : { site }),
      resolveUrl: (url: string) => new URL(url, `${origin}/`).href,
    },
    timeouts: { test: timeoutMs, action: timeoutMs, assertion: 5_000 },
    get signal() { return attemptController.signal; },
    operation: (budget?: number) => op(budget),
    attachArtifact: (_kind: string, relative: string) => { attached.push(relative); },
    attachViewport: () => undefined,
    expectable: (target: object) => target,
    fixture: (_name: string, target: object) => target,
  } as unknown as EngineFixtureContext;

  const cleanup = () => ({ signal: new AbortController().signal, timeoutMs });

  const session: WebSession = {
    engine,
    get browser() {
      if (browser === undefined) throw new Error('no attempt is open');
      return browser;
    },
    origin,
    artifactsDir,
    projectRoot,
    attached,
    op,
    serve(pathname, body) {
      pages.set(pathname, body);
      return `${origin}${pathname}`;
    },
    async setContent(html) {
      contentCount += 1;
      await session.open(session.serve(`/content-${String(contentCount)}`, html));
    },
    open: (url) => engine.session!.open!(url, op()),
    observe: (observeOptions) => engine.observe!(op(), observeOptions),
    nodes: async (observeOptions) => flatten((await engine.observe!(op(), observeOptions)).root),
    locate: (expression) => engine.locate!(expression, op()),
    async startAttempt(id = `attempt-${String(Number(attemptId.split('-').at(-1) ?? '0') + 1)}`) {
      if (attemptOpen) await session.endAttempt();
      attemptId = id;
      attemptController = new AbortController();
      await engine.startAttempt!({
        attemptId,
        artifactsDir,
        signal: attemptController.signal,
        resolveSecret: noSecrets,
        ...ignoreTrace,
        ...options.attempt,
      });
      attemptOpen = true;
      browser = engine.fixtures!['browser']!(fixtureContext) as Browser;
    },
    async endAttempt() {
      if (!attemptOpen) return;
      attemptOpen = false;
      browser = undefined;
      await engine.endAttempt!(cleanup());
    },
    async close() {
      try {
        await session.endAttempt();
        await engine.dispose!(cleanup());
      } finally {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        await closed;
        rmSync(artifactsDir, { recursive: true, force: true });
        if (ownRoot !== undefined) rmSync(ownRoot, { recursive: true, force: true });
      }
    },
  };

  try {
    await engine.init!({
      runId: 'run-web-session',
      targetName: 'web',
      projectRoot,
      app: site === null ? {} : { site },
      env: {},
      headed: false,
      workerSlot: 0,
      log: () => undefined,
      signal: new AbortController().signal,
    });
    if (options.startAttempt !== false) await session.startAttempt('attempt-1');
  } catch (cause) {
    await session.close().catch(() => undefined);
    throw cause;
  }
  return session;
}

/**
 * Every operation ends at its budget, whatever the page does: a server that
 * never answers a navigation, which Playwright's own timeout ends, and a
 * renderer stuck in a script a button started. Playwright cannot answer an
 * evaluate or a point tap there at all, so the engine's own deadline ends
 * the call: `OPERATION_TIMEOUT`, or `ACTION_MAY_HAVE_COMMITTED`
 * for input, which may have reached the page.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Locator } from 'e2e';
import type { EngineFixtureContext, EngineHandle, LocatorExpression, NodeRef, OperationContext } from 'e2e/engine';
import { web, type BrowserExpectation } from '../../src/index.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const BUDGET_MS = 1_000;
/** The action timeout a read left to the harness's default budget takes. */
const ACTION_TIMEOUT_MS = 30_000;
/** How long past its budget a call may still be pending before the test calls it unbounded. */
const SLACK_MS = 1_000;
/** How much sooner than the budget a call may fail: Playwright's own timeout is set 250 ms short of it. */
const EARLY_MS = 300;

const BUSY_PAGE = `<!doctype html><title>Busy</title>
<button onclick="while (true) {}">Freeze</button>
<button>Next</button>`;

const COVERED_PAGE = `<!doctype html><title>Covered</title>
<button>Pay</button>
<div id="overlay" style="position: fixed; inset: 0; background: rgba(0, 0, 0, 0.3)"></div>`;

function operation(): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: BUDGET_MS, runId: 'run-hung', attemptId: 'hung', origin: 'test' };
}

function button(name: string): LocatorExpression {
  return {
    kind: 'query',
    query: {
      kind: 'role',
      value: { kind: 'string', value: 'button', exact: true },
      name: { kind: 'string', value: name, exact: true },
    },
  };
}

/**
 * Settles one call, or gives up on it a while after its budget: a call
 * still pending then is reported as such, so an unbounded one fails the test
 * at once instead of holding it to the vitest timeout. A call that failed
 * well before its budget fails the test too: the budget must bound it, not
 * cut it short.
 */
async function bounded(call: () => Promise<unknown>): Promise<{ error: unknown }> {
  const started = Date.now();
  const pending = Symbol('pending');
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    call().then(() => undefined, (error: unknown) => error),
    new Promise<typeof pending>((resolve) => { timer = setTimeout(() => resolve(pending), BUDGET_MS + SLACK_MS); }),
  ]);
  clearTimeout(timer);
  if (outcome === pending) throw new Error(`still pending ${BUDGET_MS + SLACK_MS}ms into a ${BUDGET_MS}ms budget`);
  expect(Date.now() - started).toBeGreaterThanOrEqual(BUDGET_MS - EARLY_MS);
  return { error: outcome };
}

describe('operations on a hung page', () => {
  let server: Server;
  let origin: string;
  let artifactsDir: string;
  let engine: EngineHandle;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/never') return;
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(request.url === '/covered' ? COVERED_PAGE : BUSY_PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-hung-page-'));
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    const cleanup = { signal: new AbortController().signal, timeoutMs: 10_000 };
    await engine.endAttempt!(cleanup);
    await engine.dispose!(cleanup);
  });

  /** Boots a fresh engine and attempt. */
  async function start(): Promise<void> {
    engine = web();
    await engine.init!({
      runId: 'run-hung',
      targetName: 'web',
      projectRoot: process.cwd(),
      app: { site: '127.0.0.1' },
      env: {},
      headed: false,
      workerSlot: 0,
      log: () => undefined,
      signal: new AbortController().signal,
    });
    await engine.startAttempt!({ attemptId: 'hung', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
  }

  /** Opens the busy page, observes it, and taps the button that starts the endless script. */
  async function freeze(): Promise<void> {
    await engine.session!.open!(`${origin}/`, operation());
    await engine.observe!(operation());
    const [target] = await engine.locate!(button('Freeze'), operation());
    const tap = await bounded(() => engine.perform!(target!.ref as NodeRef, { kind: 'tap' }, operation()));
    expect(tap.error).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  }

  /**
   * `expect(browser)` over the attempt, through a fixture context with the
   * harness's budgets: an operation with no explicit timeout gets the action
   * timeout.
   */
  function browserExpectation(): BrowserExpectation {
    let expectation: (() => unknown) | undefined;
    const context = {
      targetName: 'web',
      timeouts: { test: 60_000, action: ACTION_TIMEOUT_MS, assertion: BUDGET_MS },
      signal: new AbortController().signal,
      operation: (timeoutMs?: number) => ({ ...operation(), timeoutMs: Math.max(1, timeoutMs ?? ACTION_TIMEOUT_MS) }),
      app: { resolveUrl: (url: string) => new URL(url, origin).href },
      fixture: (_name: string, target: object) => target,
      expectable: (target: object, factory: () => unknown) => {
        expectation = factory;
        return target;
      },
    } as unknown as EngineFixtureContext;
    engine.fixtures!.browser!(context);
    return expectation!() as BrowserExpectation;
  }

  it('ends a browser assertion on a stuck page at its own timeout, not the action timeout', async () => {
    await start();
    await freeze();
    const expectation = browserExpectation();
    const title = await bounded(() => expectation.toHaveTitle('Other', { timeout: BUDGET_MS }));
    expect(title.error).toMatchObject({ code: 'OPERATION_TIMEOUT' });
    // A locator read waits out the action timeout, as the harness's does.
    const card = {
      getAttribute: async () => {
        await engine.locate!(button('Next'), { ...operation(), timeoutMs: ACTION_TIMEOUT_MS });
        return 'card';
      },
    } as unknown as Locator;
    const negated = await bounded(() => expectation.not.toHaveClass(card, 'card', { timeout: BUDGET_MS }));
    expect(negated.error).toMatchObject({ code: 'OPERATION_TIMEOUT' });
  });

  it('times out a navigation to a server that never answers', async () => {
    await start();
    const open = await bounded(() => engine.session!.open!(`${origin}/never`, operation()));
    expect(open.error).toMatchObject({ code: 'OPERATION_TIMEOUT' });
  });

  it('times out a locate and a point tap on a page whose renderer is stuck in a script', async () => {
    await start();
    await freeze();
    const locate = await bounded(() => engine.locate!(button('Next'), operation()));
    expect(locate.error).toMatchObject({ code: 'OPERATION_TIMEOUT' });
    const tap = await bounded(() => engine.performAt!({ x: 10, y: 10 }, { kind: 'tap' }, operation()));
    expect(tap.error).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  });

  it('keeps the reason Playwright gives for a tap that cannot land, ahead of the deadline', async () => {
    await start();
    await engine.session!.open!(`${origin}/covered`, operation());
    const [target] = await engine.locate!(button('Pay'), operation());
    const tap = await bounded(() => engine.perform!(target!.ref as NodeRef, { kind: 'tap' }, operation()));
    expect(tap.error).toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringContaining('intercepts pointer events') });
  });
});

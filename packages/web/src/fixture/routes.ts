/**
 * The `browser` fixture's route contract over the network's decisions, and
 * the responses `route.fetch` and `waitForResponse` hand the test.
 */

import { raceAbort, TestError, withTimeout, type EngineFixtureContext } from 'e2e/engine';
import type { Browser, WebResponse, WebRoute } from './types.ts';
import { parseContinue, parseFulfill, requireNoArguments } from '../route-options.ts';
import { message } from '../support.ts';
import type { RouteDecisions } from '../driver/network.ts';

/**
 * Runs one test route handler on a held request with Playwright's route contract:
 * exactly one of fulfill, continue, fallback, or abort. Options are checked
 * before the decision, so a rejected one leaves the request to the abort. A
 * handler that decides twice, returns undecided, or throws fails the next
 * step with its cause (`latch`), and an undecided or failed decision aborts
 * the request rather than leaving it pending.
 */
export async function runRouteHandler(
  handler: Parameters<Browser['route']>[1],
  request: WebRoute['request'],
  decisions: RouteDecisions & { fetch(): Promise<WebResponse> },
  latch: (error: Error) => void,
  context: EngineFixtureContext,
  resolvePath: (file: string) => string,
): Promise<void> {
  let decided = false;
  const abortQuietly = async (): Promise<void> => {
    try {
      await decisions.abort();
    } catch {
      return;
    }
  };
  const decideWith = async (name: string, act: () => Promise<void>): Promise<void> => {
    if (decided) throw new TestError('ACTION_FAILED', `route handler already decided; ${name} called twice`);
    decided = true;
    try {
      await act();
    } catch (cause) {
      await abortQuietly();
      throw cause;
    }
  };
  const route: WebRoute = {
    request,
    fetch: async (...args: unknown[]) => {
      requireNoArguments('route.fetch', args);
      return decisions.fetch();
    },
    fulfill: async (response) => {
      const decision = parseFulfill(response, resolvePath);
      await decideWith('fulfill', () => decisions.fulfill(decision));
    },
    continue: async (overrides) => {
      const decision = parseContinue(overrides, request.url, context.app.resolveUrl);
      await decideWith('continue', () => decisions.continue(decision));
    },
    fallback: async (...args: unknown[]) => {
      requireNoArguments('route.fallback', args);
      await decideWith('fallback', () => decisions.fallback());
    },
    abort: async (...args: unknown[]) => {
      requireNoArguments('route.abort', args);
      await decideWith('abort', () => decisions.abort());
    },
  };
  try {
    await handler(route);
    if (!decided) throw new TestError('ACTION_FAILED', 'route handler returned without calling fulfill, continue, fallback, or abort');
  } catch (cause) {
    latch(cause instanceof Error ? cause : new TestError('ACTION_FAILED', `route handler failed: ${message(cause)}`));
    if (!decided) await abortQuietly();
  }
}

/**
 * Reads the body once the response is known and keeps the outcome: a body
 * that arrived returns a copy of its bytes on every call, a body the browser could not
 * read rejects every call with `ACTION_FAILED` naming the cause. Swallowing
 * that failure would hand the test an empty string the server never sent,
 * indistinguishable from a real empty body. `failure` names the reason the
 * browser reported on a page request (`net::ERR_CONTENT_LENGTH_MISMATCH` for
 * a connection cut short of the declared length, `net::ERR_ABORTED` for a
 * request the page aborted), and the error behind the read is the fallback,
 * as for a redirect, whose body the browser never keeps.
 */
export async function readResponseBody(
  api: 'waitForResponse' | 'route.fetch',
  body: () => Promise<Buffer>,
  failure: () => string | undefined = () => undefined,
): Promise<() => Promise<Buffer>> {
  try {
    const bytes = await body();
    return () => Promise.resolve(Buffer.from(bytes));
  } catch (cause) {
    const error = new TestError('ACTION_FAILED', `${api}: response body could not be read: ${failure() ?? message(cause)}`);
    return () => Promise.reject(error);
  }
}

/** The `WebResponse` over a response's metadata and a reader for its body bytes. */
export function webResponse(fields: Pick<WebResponse, 'url' | 'status' | 'headers'>, body: () => Promise<Buffer>): WebResponse {
  const text = async (): Promise<string> => new TextDecoder().decode(await body());
  return {
    ...fields,
    body,
    // oxlint-disable-next-line e2e/no-unchecked-json -- public API: the caller names T, unknown by default
    json: async <T = unknown>() => JSON.parse(await text()) as T,
    text,
  };
}

/**
 * A matched response as `waitForResponse` reports it. The body read started
 * when the response was known, and is awaited only by the body readers on a
 * budget of their own: the wait's timeout bounds the match, never a body
 * still streaming in behind headers that already arrived.
 */
export function waitedResponse(
  context: EngineFixtureContext,
  fields: Pick<WebResponse, 'url' | 'status' | 'headers'>,
  body: Promise<() => Promise<Buffer>>,
): WebResponse {
  return webResponse(fields, async () => {
    const { signal, timeoutMs } = context.operation();
    const read = await raceAbort(
      withTimeout(body, timeoutMs, () => new TestError('ACTION_FAILED', `waitForResponse: response body did not finish within ${timeoutMs}ms`)),
      signal,
      'waitForResponse body',
    );
    return read();
  });
}

/**
 * The `browser` fixture's route contract over the network's decisions, and
 * the responses `route.fetch` and `waitForResponse` hand the test. Every key
 * of a decision is checked before it is taken: an option this engine does
 * not implement (Playwright's `abort(errorCode)`, `fulfill({ response })`, a
 * misspelled key) is `INVALID_ARGUMENT` rather than a request answered as if
 * the option were absent. A continue URL goes through the harness's
 * navigation rule, the same `resolveUrl` `goto` uses.
 */

import { statSync } from 'node:fs';
import { types } from 'node:util';
import { raceAbort, rejectUnknownOptions, TestError, validateJsonValue, withTimeout, type EngineFixtureContext, type JsonValue } from 'e2e/engine';
import { headerProblem } from '../protected-app.ts';
import type { Browser, WebResponse, WebRoute } from './types.ts';
import type { ContinueDecision, FulfillDecision, RouteDecisions } from '../driver/network.ts';
import { message } from '../errors.ts';

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

const FULFILL_KEYS = ['status', 'headers', 'contentType', 'json', 'body', 'path'];
const CONTINUE_KEYS = ['url', 'method', 'headers', 'postData'];

/**
 * Validates `route.fulfill(response)`, synchronously so the decision is
 * taken the moment `fulfill` is called. `path` resolves with `resolvePath`
 * (the project root, never `process.cwd()`) and must name a file now, so a
 * missing fixture fails the step with its own message, and `json` follows
 * the JSON-value rules `evaluate` does. A `content-type` header becomes
 * `contentType` when none is given, since the driver overwrites the header
 * with the type it derives for `json` and `path`.
 */
export function parseFulfill(
  response: unknown,
  resolvePath: (file: string) => string,
): FulfillDecision {
  const fields = requireOptions('route.fulfill', response, FULFILL_KEYS, false);
  const sources = ['json', 'body', 'path'].filter((key) => fields[key] !== undefined);
  if (sources.length > 1) {
    throw new TestError('INVALID_ARGUMENT', `route.fulfill takes one of json, body, or path; got ${sources.join(' and ')}`);
  }
  const { status, headers, contentType, json, body, path } = fields;
  if (status !== undefined && !(Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599)) {
    throw new TestError('INVALID_ARGUMENT', 'route.fulfill status must be an integer from 100 to 599');
  }
  if (json !== undefined) validateJsonValue(json, 'route.fulfill json');
  const file = path === undefined ? undefined : resolvePath(requireString('route.fulfill', 'path', path, true));
  if (file !== undefined) requireFile(file);
  const replied = requireHeaders('route.fulfill', headers, 'response') ?? {};
  const type = contentType === undefined
    ? Object.entries(replied).find(([name]) => name.toLowerCase() === 'content-type')?.[1]
    : requireString('route.fulfill', 'contentType', contentType, true);
  return {
    status: (status as number | undefined) ?? 200,
    headers: replied,
    ...(type === undefined ? {} : { contentType: type }),
    ...(json === undefined ? {} : { json: json as JsonValue }),
    ...(body === undefined ? {} : { body: requireBody(body) }),
    ...(file === undefined ? {} : { path: file }),
  };
}

/**
 * Validates `route.continue(overrides)`. A `url` resolves against the base
 * URL through `resolveUrl`, which denies what navigation denies, and keeps
 * the request's scheme, as the browser requires of a rewritten request.
 */
export function parseContinue(
  overrides: unknown,
  requestUrl: string,
  resolveUrl: (url: string) => string,
): ContinueDecision {
  const fields = requireOptions('route.continue', overrides, CONTINUE_KEYS, true);
  const { url, method, headers, postData } = fields;
  let target: string | undefined;
  if (url !== undefined) {
    target = resolveUrl(requireString('route.continue', 'url', url, true));
    const from = new URL(requestUrl).protocol;
    const to = new URL(target).protocol;
    if (from !== to) {
      throw new TestError('INVALID_ARGUMENT', `route.continue url must keep the request's ${from} scheme; got ${to}`);
    }
  }
  const replaced = requireHeaders('route.continue', headers, 'request');
  return {
    ...(target === undefined ? {} : { url: target }),
    ...(method === undefined ? {} : { method: requireString('route.continue', 'method', method, true) }),
    ...(replaced === undefined ? {} : { headers: replaced }),
    ...(postData === undefined ? {} : { postData: requireString('route.continue', 'postData', postData, false) }),
  };
}

/** Rejects any argument to a decision that takes none (`abort`, `fallback`). */
function requireNoArguments(api: string, args: readonly unknown[]): void {
  if (args.some((arg) => arg !== undefined)) {
    throw new TestError('INVALID_ARGUMENT', `${api}() takes no arguments`);
  }
}

/** The options object with every key checked against `allowed`; `undefined` is `{}` when `optional`. */
function requireOptions(
  api: string,
  value: unknown,
  allowed: readonly string[],
  optional: boolean,
): Record<string, unknown> {
  if (value === undefined) {
    if (optional) return {};
    throw new TestError('INVALID_ARGUMENT', `${api} takes an options object`);
  }
  rejectUnknownOptions(api, value as object, allowed);
  return value as Record<string, unknown>;
}

/** `value` as a string, else `INVALID_ARGUMENT` naming the option. */
function requireString(api: string, key: string, value: unknown, nonempty: boolean): string {
  if (typeof value !== 'string' || (nonempty && value.length === 0)) {
    throw new TestError('INVALID_ARGUMENT', `${api} ${key} must be a ${nonempty ? 'nonempty ' : ''}string`);
  }
  return value;
}

/**
 * A header map the browser can send, or `undefined` when none was given. A
 * request header set to `undefined` is dropped, so the request goes without
 * it. A response `set-cookie` may join several cookies with `\n`, the way
 * Playwright reports them, and each line is checked as its own value; any
 * other line break is refused as header injection.
 */
function requireHeaders(api: string, value: unknown, kind: 'request' | 'response'): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TestError('INVALID_ARGUMENT', `${api} headers must map names to string values`);
  }
  const headers: [string, string][] = [];
  for (const [name, entry] of Object.entries(value)) {
    if (entry === undefined && kind === 'request') continue;
    if (typeof entry !== 'string') throw new TestError('INVALID_ARGUMENT', `${api} ${headerProblem(name, entry)}`);
    const lines = kind === 'response' && name.toLowerCase() === 'set-cookie' ? entry.split('\n') : [entry];
    for (const line of lines) {
      const problem = headerProblem(name, line);
      if (problem !== undefined) throw new TestError('INVALID_ARGUMENT', `${api} ${problem}`);
    }
    headers.push([name, entry]);
  }
  return Object.fromEntries(headers);
}

/** A fulfill body: a string as is, or bytes as a `Buffer` over the same memory so they are sent unchanged. */
function requireBody(value: unknown): string | Buffer {
  if (typeof value === 'string') return value;
  if (types.isUint8Array(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TestError('INVALID_ARGUMENT', 'route.fulfill body must be a string, Buffer, or Uint8Array');
}

/** Rejects a path that does not name a regular file; synchronous so the check lands before the decision. */
function requireFile(file: string): void {
  let isFile = false;
  try {
    isFile = statSync(file, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    // A directory on the path the runner may not search (`EACCES`): not a file the route can serve.
  }
  if (!isFile) {
    throw new TestError('INVALID_ARGUMENT', `route.fulfill path is not a readable file: ${file}`);
  }
}

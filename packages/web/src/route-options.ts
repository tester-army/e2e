/**
 * Argument validation for a route handler's decision. Every key is checked
 * before the decision is taken: an option this engine does not implement
 * (Playwright's `abort(errorCode)`, `fulfill({ response })`, a misspelled
 * key) is `INVALID_ARGUMENT` rather than a request answered as if the option
 * were absent. A continue URL goes through the harness's navigation rule,
 * the same `resolveUrl` `goto` uses.
 */

import { statSync } from 'node:fs';
import { rejectUnknownOptions, TestError, validateJsonValue, type JsonValue } from 'e2e/engine';
import { headerProblem } from './protected-app.ts';

/** What `route.fulfill` hands Playwright once the response is validated. */
export interface FulfillDecision {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly contentType?: string;
  readonly json?: JsonValue;
  readonly body?: string;
  /** Absolute; Playwright reads it and derives `Content-Type` from its extension when none is given. */
  readonly path?: string;
}

/** What `route.continue` hands Playwright once the overrides are validated; `headers` before the site's are merged in. */
export interface ContinueDecision {
  readonly url?: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly postData?: string;
}

const FULFILL_KEYS = ['status', 'headers', 'contentType', 'json', 'body', 'path'];
const CONTINUE_KEYS = ['url', 'method', 'headers', 'postData'];

/**
 * Validates `route.fulfill(response)`, synchronously so the decision is
 * taken the moment `fulfill` is called. `path` resolves with `resolvePath`
 * (the project root, never `process.cwd()`) and must name a file now, so a
 * missing fixture fails the step with its own message, and `json` follows
 * the JSON-value rules `evaluate` does. A `content-type` header becomes
 * `contentType` when none is given, since Playwright overwrites the header
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
  const replied = requireHeaders('route.fulfill', headers) ?? {};
  const type = contentType === undefined
    ? Object.entries(replied).find(([name]) => name.toLowerCase() === 'content-type')?.[1]
    : requireString('route.fulfill', 'contentType', contentType, true);
  return {
    status: (status as number | undefined) ?? 200,
    headers: replied,
    ...(type === undefined ? {} : { contentType: type }),
    ...(json === undefined ? {} : { json: json as JsonValue }),
    ...(body === undefined ? {} : { body: requireString('route.fulfill', 'body', body, false) }),
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
  const replaced = requireHeaders('route.continue', headers);
  return {
    ...(target === undefined ? {} : { url: target }),
    ...(method === undefined ? {} : { method: requireString('route.continue', 'method', method, true) }),
    ...(replaced === undefined ? {} : { headers: replaced }),
    ...(postData === undefined ? {} : { postData: requireString('route.continue', 'postData', postData, false) }),
  };
}

/** Rejects any argument to a decision that takes none (`abort`, `fallback`). */
export function requireNoArguments(api: string, args: readonly unknown[]): void {
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

/** A header map the browser can send, or `undefined` when none was given. */
function requireHeaders(api: string, value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TestError('INVALID_ARGUMENT', `${api} headers must map names to string values`);
  }
  for (const [name, entry] of Object.entries(value)) {
    const problem = headerProblem(name, entry);
    if (problem !== undefined) throw new TestError('INVALID_ARGUMENT', `${api} ${problem}`);
  }
  return value as Record<string, string>;
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

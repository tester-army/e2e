/**
 * BrowserStack's App Automate REST API over `fetch`: uploads a build from a
 * URL, and finds a session by its build and name, with its start time and the
 * URL of its video.
 */

import { ConfigurationError } from 'e2e/engine';
import type { BrowserStackCredentials } from './credentials.ts';

/** The App Automate API's base. */
const DEFAULT_API_ENDPOINT = 'https://api-cloud.browserstack.com/app-automate';

const REQUEST_TIMEOUT_MS = 15_000;

/** BrowserStack downloads the build before it answers an upload from a URL. */
const UPLOAD_TIMEOUT_MS = 300_000;

/** Builds or sessions the list asks for at once. */
const PAGE_SIZE = 50;

/** Pages a lookup reads before it gives up: both lists are newest first, so the run is near the top. */
const MAX_PAGES = 10;

/** A session the recording covers, as the lease named it. */
export interface SessionRef {
  readonly build: string;
  readonly sessionName: string;
}

/**
 * The API at `BROWSERSTACK_API_ENDPOINT` from the run's environment, else
 * BrowserStack's own. Throws, without repeating the value, when the override
 * is not an http(s) URL or carries a username or password, which a failed
 * request would otherwise put in its error message.
 */
export function browserstackApiEndpoint(env: Readonly<Record<string, string | undefined>>): string {
  const override = env['BROWSERSTACK_API_ENDPOINT']?.trim();
  if (override === undefined || override === '') return DEFAULT_API_ENDPOINT;
  if (!URL.canParse(override) || !/^https?:$/.test(new URL(override).protocol)) throw new ConfigurationError('INVALID_CONFIG', 'BROWSERSTACK_API_ENDPOINT is not an http(s) URL');
  const url = new URL(override);
  if (url.search !== '' || url.hash !== '') throw new ConfigurationError('INVALID_CONFIG', 'BROWSERSTACK_API_ENDPOINT must not carry a query or fragment');
  if (url.username !== '' || url.password !== '') {
    throw new ConfigurationError('INVALID_CONFIG', 'BROWSERSTACK_API_ENDPOINT must not carry a username or password; set BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY instead');
  }
  return override.replace(/\/+$/, '');
}

/** A session the lookup found: its `hashed_id`, when it started, and its video, if the API says. */
export interface FoundSession {
  readonly id: string;
  /** ISO timestamp in UTC; `undefined` when the session has no start time or one that does not parse. */
  readonly startedAt: string | undefined;
  /** `undefined` until BrowserStack has a video for the session. */
  readonly videoUrl: string | undefined;
}

/**
 * The newest session named `sessionName` in the newest build named `build`,
 * reading each list a page at a time. Every request is bounded by
 * `REQUEST_TIMEOUT_MS` and `signal`, and errors name the build and the
 * session, never the credentials or a URL.
 */
export async function findSession(endpoint: string, credentials: BrowserStackCredentials, { build, sessionName }: SessionRef, signal: AbortSignal): Promise<FoundSession> {
  const auth = basicAuth(credentials);
  const what = `BrowserStack session lookup in build ${JSON.stringify(build)}`;
  // Builds of different projects may share a name, as targets of one run do by default.
  for (const buildId of await findBuilds(endpoint, auth, build, signal)) {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const rows = await getRows(listUrl(`${endpoint}/builds/${encodeURIComponent(buildId)}/sessions.json`, page), auth, signal, what);
      for (const row of rows) {
        const session = asRecord(asRecord(row)?.['automation_session']);
        const id = session?.['hashed_id'];
        if (session?.['name'] === sessionName && typeof id === 'string' && id !== '') {
          const video = session['video_url'];
          return { id, startedAt: utcTimestamp(session['created_at']), videoUrl: typeof video === 'string' && isHttpUrl(video) ? video : undefined };
        }
      }
      if (rows.length < PAGE_SIZE) break;
    }
  }
  throw new Error(`BrowserStack has no session named ${JSON.stringify(sessionName)} in build ${JSON.stringify(build)}`);
}

/**
 * Has BrowserStack fetch the build at `url` and returns its `bs://` app id:
 * the session's `app` capability takes only an uploaded app, never a URL.
 */
export async function uploadAppFromUrl(endpoint: string, credentials: BrowserStackCredentials, url: string, signal: AbortSignal): Promise<string> {
  const form = new FormData();
  form.set('url', url);
  // The API may echo the URL, which can carry a signed token: `request` hides it in every error.
  const body = asRecord(await request(new URL(`${endpoint}/upload`), basicAuth(credentials), signal, 'BrowserStack app upload from a URL', { timeoutMs: UPLOAD_TIMEOUT_MS, form, hide: url }));
  const appUrl = body?.['app_url'];
  if (typeof appUrl !== 'string' || !appUrl.startsWith('bs://')) throw new Error('BrowserStack app upload from a URL failed: no bs:// app id in the response');
  return appUrl;
}

/** `message` with `url`, raw or encoded, and its query string replaced, so a signed token never reaches a log. */
function redact(message: string, url: string): string {
  const query = URL.canParse(url) ? new URL(url).search.slice(1) : '';
  return [url, encodeURIComponent(url), query, encodeURIComponent(query)]
    .filter((secret) => secret !== '')
    .reduce((text, secret) => text.split(secret).join('<app URL>'), message);
}

/** A transport error's message with `url` redacted, in place of the error itself. */
function redactedError(cause: unknown, url: string): Error {
  return new Error(redact(cause instanceof Error ? cause.message : String(cause), url));
}

/** An error saying `message`, caused by `cause`. */
function withCause(message: string, cause: Error): Error {
  return new Error(message, { cause });
}

/** The `hashed_id` of every build named `build`, newest first. */
async function findBuilds(endpoint: string, auth: string, build: string, signal: AbortSignal): Promise<string[]> {
  const what = `BrowserStack build lookup for ${JSON.stringify(build)}`;
  const ids: string[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await getRows(listUrl(`${endpoint}/builds.json`, page), auth, signal, what);
    for (const row of rows) {
      const found = asRecord(asRecord(row)?.['automation_build']);
      const id = found?.['hashed_id'];
      if (found?.['name'] === build && typeof id === 'string' && id !== '') ids.push(id);
    }
    if (rows.length < PAGE_SIZE) break;
  }
  if (ids.length > 0) return ids;
  throw new Error(`BrowserStack has no build named ${JSON.stringify(build)}`);
}

function listUrl(base: string, page: number): URL {
  const url = new URL(base);
  url.searchParams.set('limit', String(PAGE_SIZE));
  url.searchParams.set('offset', String(page * PAGE_SIZE));
  return url;
}

/**
 * A `created_at` as an ISO timestamp in UTC. The API sends one with a zone;
 * a time without one is read as UTC.
 */
function utcTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const text = value.trim();
  const ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function basicAuth({ username, accessKey }: BrowserStackCredentials): string {
  return `Basic ${Buffer.from(`${username}:${accessKey}`).toString('base64')}`;
}

/** One authenticated GET answered with a JSON array; anything else throws, as `what`, with the HTTP status and the API's message. */
async function getRows(url: URL, auth: string, signal: AbortSignal, what: string): Promise<unknown[]> {
  const body = await request(url, auth, signal, what, { timeoutMs: REQUEST_TIMEOUT_MS });
  if (!Array.isArray(body)) throw new Error(`${what} failed: no list in the response`);
  return body;
}

/** How `request` sends one call: how long it may take, the form it posts, if any, and a URL its errors must not show. */
interface RequestOptions {
  readonly timeoutMs: number;
  readonly form?: FormData;
  readonly hide?: string;
}

/** One authenticated request, a POST when it carries a form, answered with JSON; anything else throws, as `what`, with the HTTP status and the API's message, `hide` replaced in both. */
async function request(url: URL, auth: string, signal: AbortSignal, what: string, { timeoutMs, form, hide }: RequestOptions): Promise<unknown> {
  const clean = (text: string) => (hide === undefined ? text : redact(text, hide));
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      ...(form === undefined ? {} : { method: 'POST', body: form }),
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: AbortSignal.any([signal, timeout.signal]),
    });
    text = await response.text();
  } catch (cause) {
    const failure = signal.aborted ? 'cancelled' : timeout.signal.aborted ? `got no answer within ${timeoutMs / 1000} s` : `failed: ${clean(cause instanceof Error ? cause.message : String(cause))}`;
    if (hide === undefined) throw new Error(`${what} ${failure}`, { cause });
    // The error may carry the hidden URL in its own cause or properties, so only its redacted message is kept.
    throw withCause(`${what} ${failure}`, redactedError(cause, hide));
  } finally {
    clearTimeout(timer);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${what} failed: HTTP ${response.status}, not JSON`);
  }
  if (!response.ok) {
    const message = asRecord(body)?.['message'] ?? asRecord(body)?.['error'];
    throw new Error(`${what} failed: HTTP ${response.status}${typeof message === 'string' && message !== '' ? ` (${clean(message).slice(0, 200)})` : ''}`);
  }
  return body;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isHttpUrl(value: string): boolean {
  return URL.canParse(value) && /^https?:$/.test(new URL(value).protocol);
}

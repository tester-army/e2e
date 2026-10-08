/**
 * TestMu AI's mobile automation sessions API over `fetch`, the one
 * agent-device's `testmu` provider reads session artifacts from: finds a
 * session by its build and name, with its start time, and reads the URL of
 * its video.
 */

import { ConfigurationError } from 'e2e/engine';
import type { TestmuCredentials } from './credentials.ts';

/** The API's base, as agent-device's `TESTMU_API_ENDPOINT` sets it. */
const DEFAULT_API_ENDPOINT = 'https://mobile-api.lambdatest.com/mobile-automation/api/v1';

const REQUEST_TIMEOUT_MS = 15_000;

/** Sessions the list asks for at once. */
const PAGE_SIZE = 50;

/** Pages the lookup reads before it gives up on a build: the list is newest first, so the session is near the top. */
const MAX_PAGES = 10;

/** A session the recording covers, as the lease named it. */
export interface SessionRef {
  readonly build: string;
  readonly sessionName: string;
}

/**
 * The sessions API at `TESTMU_API_ENDPOINT` from the run's environment, else
 * TestMu AI's own. Throws, without repeating the value, when the override is
 * not an http(s) URL or carries a username or password, which a failed
 * request would otherwise put in its error message.
 */
export function testmuApiEndpoint(env: Readonly<Record<string, string | undefined>>): string {
  const override = env['TESTMU_API_ENDPOINT']?.trim();
  if (override === undefined || override === '') return DEFAULT_API_ENDPOINT;
  if (!URL.canParse(override) || !/^https?:$/.test(new URL(override).protocol)) throw new ConfigurationError('INVALID_CONFIG', 'TESTMU_API_ENDPOINT is not an http(s) URL');
  const url = new URL(override);
  if (url.username !== '' || url.password !== '') {
    throw new ConfigurationError('INVALID_CONFIG', 'TESTMU_API_ENDPOINT must not carry a username or password; set LT_USERNAME and LT_ACCESS_KEY instead');
  }
  return override.replace(/\/+$/, '');
}

/** A session the list found: its `test_id`, and when it started, if the list says. */
export interface FoundSession {
  readonly id: string;
  /** ISO timestamp in UTC; `undefined` when the row has no start time or one that does not parse. */
  readonly startedAt: string | undefined;
}

/**
 * The newest session named `sessionName` in `build` that the credentials'
 * user started, reading the list a page at a time. Every request is bounded by `REQUEST_TIMEOUT_MS` and `signal`,
 * and errors name the build and the session, never the credentials or a URL.
 */
export async function findSession(endpoint: string, credentials: TestmuCredentials, { build, sessionName }: SessionRef, signal: AbortSignal): Promise<FoundSession> {
  const auth = basicAuth(credentials);
  const what = `TestMu AI session lookup for build ${JSON.stringify(build)}`;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`${endpoint}/sessions`);
    url.searchParams.set('build', build);
    // The build filter spans the whole organization; a build name another user's run shares would find their session.
    url.searchParams.set('username', credentials.username);
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('offset', String(page * PAGE_SIZE));
    const body = await getJson(url, auth, signal, what);
    // An empty page comes back as `data: null`.
    const rows = body['data'] ?? [];
    if (!Array.isArray(rows)) throw new Error(`${what} failed: no session list in the response`);
    for (const row of rows) {
      const { name, test_id: id, start_timestamp: start } = asRecord(row) ?? {};
      if (name === sessionName && typeof id === 'string' && id !== '') return { id, startedAt: utcTimestamp(start) };
    }
    if (rows.length < PAGE_SIZE) break;
  }
  throw new Error(`TestMu AI has no session named ${JSON.stringify(sessionName)} in build ${JSON.stringify(build)}`);
}

/** The `video_url` of session `id`'s details, bounded and named as `findSession` is. */
export async function sessionVideoUrl(endpoint: string, credentials: TestmuCredentials, id: string, { build, sessionName }: SessionRef, signal: AbortSignal): Promise<string> {
  const what = `TestMu AI session ${id} (${JSON.stringify(sessionName)}, build ${JSON.stringify(build)})`;
  const body = await getJson(new URL(`${endpoint}/sessions/${encodeURIComponent(id)}`), basicAuth(credentials), signal, `${what} details`);
  const details = asRecord(body['data']);
  const videoUrl = details?.['video_url'];
  if (typeof videoUrl !== 'string' || !isHttpUrl(videoUrl)) throw new Error(`${what} reports no video URL`);
  return videoUrl;
}

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:\d{2})?$/;

/**
 * A `start_timestamp` as an ISO timestamp in UTC. The API formats the
 * database time as RFC 3339 with its zone; a time without one is read as UTC,
 * the zone the API's database driver reads it in.
 */
function utcTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = TIMESTAMP.exec(value.trim());
  if (match === null) return undefined;
  const [, date, time, zone] = match;
  const ms = Date.parse(`${date}T${time}${zone ?? 'Z'}`);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function basicAuth({ username, accessKey }: TestmuCredentials): string {
  return `Basic ${Buffer.from(`${username}:${accessKey}`).toString('base64')}`;
}

/** One authenticated GET answered with a JSON object; anything else throws, as `what`, with the HTTP status and the API's message. */
async function getJson(url: URL, auth: string, signal: AbortSignal, what: string): Promise<Record<string, unknown>> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.any([signal, timeout.signal]) });
    text = await response.text();
  } catch (cause) {
    if (signal.aborted) throw new Error(`${what} cancelled`, { cause });
    if (timeout.signal.aborted) throw new Error(`${what} got no answer within ${REQUEST_TIMEOUT_MS / 1000} s`, { cause });
    throw new Error(`${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  } finally {
    clearTimeout(timer);
  }
  let body: Record<string, unknown> | undefined;
  try {
    body = asRecord(JSON.parse(text));
  } catch {
    body = undefined;
  }
  if (body === undefined) throw new Error(`${what} failed: HTTP ${response.status}, not JSON`);
  if (!response.ok) {
    const message = body['message'];
    throw new Error(`${what} failed: HTTP ${response.status}${typeof message === 'string' && message !== '' ? ` (${message.slice(0, 200)})` : ''}`);
  }
  return body;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isHttpUrl(value: string): boolean {
  return URL.canParse(value) && /^https?:$/.test(new URL(value).protocol);
}

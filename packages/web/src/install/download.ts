/**
 * The installer's one network primitive: a download streamed to disk
 * through a SHA-256 check, over the proxy the environment names, from the
 * vendor or the `E2E_BROWSERS_DOWNLOAD_HOST` mirror.
 */

import { createHash } from 'node:crypto';
import { createWriteStream, renameSync, rmSync } from 'node:fs';
import http from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { InfrastructureError } from 'e2e/engine';

/** What `downloadVerified` needs besides the URL and the file. */
export interface DownloadOptions {
  /** The SHA-256 the body must have, lowercase hex. */
  readonly sha256: string;
  /** The environment whose `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY` route the request. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal | undefined;
}

/**
 * The keys undici keeps Node's global fetch dispatcher under, newest first:
 * undici 8 (Node 26) keeps it under `.2` and a fresh compatibility wrapper
 * of it under `.1`; earlier undici keeps it under `.1` only.
 */
const GLOBAL_DISPATCHERS = [Symbol.for('undici.globalDispatcher.2'), Symbol.for('undici.globalDispatcher.1')];

/** The global fetch dispatcher, under the newest key this Node's undici uses. */
export function globalDispatcher(): unknown {
  const slots = globalThis as Record<symbol, unknown>;
  const key = GLOBAL_DISPATCHERS.find((candidate) => slots[candidate] !== undefined);
  return key === undefined ? undefined : slots[key];
}

/** The proxy variables Node's built-in proxy support reads. */
const PROXY_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;

/** Proxy dispatchers already built, by the proxy variables they were built from. */
const dispatchers = new Map<string, unknown>();

/** The proxy settings of `env`, or undefined when it names no proxy. */
function proxyEnv(env: DownloadOptions['env']): Record<string, string> | undefined {
  const entries = [...PROXY_VARIABLES, 'NO_PROXY', 'no_proxy'].flatMap((name) => {
    const value = env[name];
    return value === undefined || value === '' ? [] : [[name, value] as const];
  });
  if (!entries.some(([name]) => (PROXY_VARIABLES as readonly string[]).includes(name))) return undefined;
  return Object.fromEntries(entries);
}

/**
 * The fetch dispatcher that routes through the proxy `env` names, built by
 * Node's own `http.setGlobalProxyFromEnv` and taken back out of the global
 * slot before anything else can run, so the process's own fetches keep
 * their dispatcher. Undefined when `env` names no proxy, or when this Node
 * has no such function: there `NODE_USE_ENV_PROXY=1` proxies every fetch.
 */
function proxyDispatcher(env: DownloadOptions['env']): unknown {
  const proxy = proxyEnv(env);
  const setGlobalProxyFromEnv = (http as Partial<typeof http>).setGlobalProxyFromEnv;
  if (proxy === undefined || setGlobalProxyFromEnv === undefined) return undefined;
  const key = JSON.stringify(proxy);
  if (!dispatchers.has(key)) {
    const restore = setGlobalProxyFromEnv(proxy);
    try {
      dispatchers.set(key, globalDispatcher());
    } finally {
      restore();
    }
  }
  return dispatchers.get(key);
}

/** What to add to a failed download's message when `env` names a proxy this Node cannot use on its own. */
function proxyHint(env: DownloadOptions['env']): string {
  if (proxyEnv(env) === undefined || typeof (http as Partial<typeof http>).setGlobalProxyFromEnv === 'function') return '';
  if (process.env['NODE_USE_ENV_PROXY'] === '1') return '';
  return '; a proxy is set, so on this Node version also set NODE_USE_ENV_PROXY=1';
}

/** An error's message with its cause's, which is where fetch keeps the network error behind "fetch failed". */
function failureOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause === undefined ? error.message : `${error.message} (${failureOf(error.cause)})`;
}

/**
 * Streams `url` into `file` through a SHA-256 of the body, and keeps the
 * file only when the digest is `options.sha256`. The body lands under a
 * temporary name first, removed on any failure, so `file` exists only once
 * it is complete and verified. Throws `BROWSER_INSTALL_FAILED` naming both
 * digests on a mismatch; an abort rethrows the signal's reason.
 */
export async function downloadVerified(url: string, file: string, options: DownloadOptions): Promise<void> {
  const partial = `${file}.download`;
  const hash = createHash('sha256');
  try {
    const dispatcher = proxyDispatcher(options.env);
    const init = { ...(options.signal === undefined ? {} : { signal: options.signal }), ...(dispatcher === undefined ? {} : { dispatcher }) };
    const response = await fetch(url, init as RequestInit);
    if (!response.ok || response.body === null) throw new Error(`${String(response.status)} ${response.statusText}`);
    const digest = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(Readable.from(response.body), digest, createWriteStream(partial), options.signal === undefined ? {} : { signal: options.signal });
  } catch (cause) {
    rmSync(partial, { force: true });
    if (options.signal?.aborted === true) throw cause;
    throw new InfrastructureError('BROWSER_INSTALL_FAILED', `download of ${url} failed: ${failureOf(cause)}${proxyHint(options.env)}`, { cause });
  }
  const actual = hash.digest('hex');
  if (actual !== options.sha256) {
    rmSync(partial, { force: true });
    throw new InfrastructureError('BROWSER_INSTALL_FAILED', `download of ${url} has SHA-256 ${actual}, expected ${options.sha256}; refusing it`);
  }
  renameSync(partial, file);
}

/** Whether `hostname` names this machine's loopback interface. */
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * The mirror origin `E2E_BROWSERS_DOWNLOAD_HOST` names, without a trailing
 * slash; undefined when unset. Throws `BROWSER_INSTALL_FAILED` unless it is
 * an `https` URL, or `http` on a loopback host.
 */
export function mirrorOrigin(env: DownloadOptions['env']): string | undefined {
  const value = env['E2E_BROWSERS_DOWNLOAD_HOST'];
  if (value === undefined || value === '') return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InfrastructureError('BROWSER_INSTALL_FAILED', `E2E_BROWSERS_DOWNLOAD_HOST is not a URL: "${value}"`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new InfrastructureError('BROWSER_INSTALL_FAILED', `E2E_BROWSERS_DOWNLOAD_HOST must be an https URL (http only on localhost): "${value}"`);
  }
  return value.replace(/\/+$/, '');
}

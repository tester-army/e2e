/**
 * Where OrcaRouter is reached. Authentication and inference are different
 * public origins, so each is read from its own variable and one is never
 * derived from the other: swapping a hostname or appending a path yields
 * `https://api.orcarouter.ai/v1/auth/keys`, which is a 404.
 *
 * `ORCA_BASE_URL` is the shared self-hosted fallback for both surfaces.
 * The explicit `ORCA_AUTH_BASE_URL` and `ORCA_API_BASE_URL` win over it.
 * A remote origin must be HTTPS; plain HTTP is allowed only on a loopback
 * host so a local deployment can be tested.
 */

import { isLoopbackHost } from '../internal/urls.ts';
import { OAuthError } from './errors.ts';

/** The public consent origin, where the browser is sent. */
const DEFAULT_AUTH_BASE_URL = 'https://www.orcarouter.ai';
/** The public inference origin, which serves `/v1` and the model catalog. */
const DEFAULT_API_BASE_URL = 'https://api.orcarouter.ai/v1';
/** The consent screen: always on the auth origin. */
const AUTHORIZE_PATH = '/auth';
/** The code exchange: always on the auth origin, and never under `/v1`. */
const EXCHANGE_PATH = '/api/v1/auth/keys';

/** The two origins an OrcaRouter request goes to, resolved once per flow. */
export interface OrcaRouterOrigins {
  /** No trailing slash. */
  readonly auth: string;
  /** No trailing slash; the base the OpenAI-compatible client is constructed with. */
  readonly api: string;
}

export function orcaRouterOrigins(env: NodeJS.ProcessEnv = process.env): OrcaRouterOrigins {
  const shared = variable(env, 'ORCA_BASE_URL');
  const selfHosted = shared === undefined ? undefined : baseUrl(shared, DEFAULT_AUTH_BASE_URL, 'ORCA_BASE_URL');
  return {
    auth: baseUrl(variable(env, 'ORCA_AUTH_BASE_URL') ?? selfHosted, DEFAULT_AUTH_BASE_URL, 'ORCA_AUTH_BASE_URL'),
    // Only the shared self-hosted base gets `/v1` appended; an explicit API
    // base is taken as the caller wrote it, and the public default already has it.
    api: baseUrl(
      variable(env, 'ORCA_API_BASE_URL') ?? (selfHosted === undefined ? undefined : `${selfHosted}/v1`),
      DEFAULT_API_BASE_URL,
      'ORCA_API_BASE_URL',
    ),
  };
}

/** An environment value, with an empty one read as unset the way the rest of the config resolver reads it. */
function variable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** The authorize URL: the auth origin plus the fixed consent path and query. */
export function authorizeUrl(origins: OrcaRouterOrigins, params: Readonly<Record<string, string>>): string {
  const url = new URL(AUTHORIZE_PATH, `${origins.auth}/`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** The exchange URL: the auth origin plus the fixed exchange path. */
export function exchangeUrl(origins: OrcaRouterOrigins): string {
  return new URL(EXCHANGE_PATH, `${origins.auth}/`).toString();
}

/** The model catalog URL on the inference origin. */
export function catalogUrl(origins: OrcaRouterOrigins, params: Readonly<Record<string, string>> = {}): string {
  const url = new URL(`${origins.api}/models`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * Normalizes one origin: no userinfo, query, or fragment, HTTPS unless the
 * host is loopback, and no trailing slash so a path can be appended directly.
 */
function baseUrl(raw: string | undefined, fallback: string, name: string): string {
  const value = (raw ?? fallback).trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError('MISCONFIGURED', `${name} is not a URL: ${value}`);
  }
  if (url.username !== '' || url.password !== '') throw new OAuthError('MISCONFIGURED', `${name} must not carry userinfo`);
  if (url.search !== '' || url.hash !== '') throw new OAuthError('MISCONFIGURED', `${name} must not carry a query or fragment`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new OAuthError('MISCONFIGURED', `${name} must use HTTPS unless the host is loopback: ${value}`);
  }
  return url.href.replace(/\/+$/u, '');
}

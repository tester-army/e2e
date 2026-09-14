/**
 * Protected-preview access, scoped to the app's site: the configured headers
 * ride only requests bound for the site, and basic-auth credentials answer
 * a challenge wherever one is issued. The surface calls these on every
 * context it creates; nothing here holds state.
 */

import type { BrowserContext } from 'playwright';
import { sameSite } from 'e2e/engine';
import type { PlaywrightBasicAuth } from './surface.ts';

/** The credentials Playwright answers an HTTP authentication challenge with. */
export interface PlaywrightHttpCredential {
  readonly username: string;
  readonly password: string;
}

/** Header names lowercased, as Playwright reports a request's own headers. */
export function lowercaseNames(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

/**
 * Adds the configured headers to every request bound for the app's site,
 * via a context route that falls back to the network. A request for any
 * other site is not routed at all; without a site there is no policy and
 * nothing is routed. Nothing awaits a route handler, so a fallback that
 * fails (the page closed under the request) is dropped rather than left to
 * surface as an unhandled rejection.
 */
export async function installSiteHeaders(
  context: BrowserContext,
  site: string | undefined,
  headers: Readonly<Record<string, string>> | undefined,
): Promise<void> {
  if (headers === undefined || site === undefined) return;
  await context.route(
    (url) => sameSite(url, site),
    async (route) => {
      await route.fallback({ headers: { ...route.request().headers(), ...headers } }).catch(() => undefined);
    },
  );
}

/**
 * The basic-auth credentials a context answers a challenge with, as
 * Playwright's own `httpCredentials` does: on a 401 from any origin. A site
 * cannot be enumerated into the exact origins Playwright scopes by, and a
 * challenge is answered only where one is issued.
 */
export function httpCredentials(basicAuth: PlaywrightBasicAuth | undefined): PlaywrightHttpCredential | undefined {
  if (basicAuth === undefined) return undefined;
  const { username, password } = basicAuth;
  return { username, password };
}

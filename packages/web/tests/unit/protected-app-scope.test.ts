/**
 * Where the configured headers go, driven through `installSiteHeaders` as the
 * surface drives it on every context, against a context that records its
 * routes instead of a browser: a request on the app's site is routed and
 * leaves with the headers, a request anywhere else is not routed at all. Two
 * deployments of one shared host are two sites. A browser cannot reach a
 * `*.vercel.app` name over plain HTTP (the `.app` TLD is HSTS-preloaded), so
 * the shared-host rule is checked here and the browser plumbing in
 * tests/integration/protected-app.test.ts.
 */

import type { BrowserContext, Route } from 'playwright';
import { describe, expect, it } from 'vitest';
import { siteOf } from 'e2e/engine';
import { installSiteHeaders } from '../../src/protected-app.ts';

type RoutePredicate = (url: URL) => boolean;
type RouteHandler = (route: Route) => Promise<void> | void;
interface RecordedRoute {
  readonly matches: RoutePredicate;
  readonly handler: RouteHandler;
}

const OWN_HEADERS = { accept: 'text/html' } as const;

/** A context that keeps the routes it is given, so a test can ask which URLs they intercept. */
function recordingContext(): { context: BrowserContext; routes: RecordedRoute[] } {
  const routes: RecordedRoute[] = [];
  const context = {
    route: async (matches: RoutePredicate, handler: RouteHandler) => {
      routes.push({ matches, handler });
    },
  } as unknown as BrowserContext;
  return { context, routes };
}

/** The headers a request to `url` leaves the context with: its own, plus whatever the route that matches adds. */
async function headersLeavingFor(routes: readonly RecordedRoute[], url: string): Promise<Record<string, string>> {
  const route = routes.find((candidate) => candidate.matches(new URL(url)));
  if (route === undefined) return { ...OWN_HEADERS };
  let sent: Record<string, string> = { ...OWN_HEADERS };
  await route.handler({
    request: () => ({ headers: () => ({ ...OWN_HEADERS }) }),
    fallback: async (overrides?: { headers?: Record<string, string> }) => {
      sent = overrides?.headers ?? sent;
    },
  } as unknown as Route);
  return sent;
}

describe('installSiteHeaders', () => {
  const headers = { 'x-vercel-protection-bypass': 'token' };

  it('sends the headers to one deployment of a shared host and to none of its neighbours', async () => {
    const { context, routes } = recordingContext();
    await installSiteHeaders(context, siteOf('myapp.vercel.app'), headers);
    expect(routes).toHaveLength(1);
    expect(await headersLeavingFor(routes, 'https://myapp.vercel.app/api/session')).toEqual({ ...OWN_HEADERS, ...headers });
    expect(await headersLeavingFor(routes, 'https://preview.myapp.vercel.app/')).toEqual({ ...OWN_HEADERS, ...headers });
    expect(await headersLeavingFor(routes, 'https://other.vercel.app/api/session')).toEqual(OWN_HEADERS);
    expect(await headersLeavingFor(routes, 'https://vercel.app/')).toEqual(OWN_HEADERS);
  });

  it('routes nothing without a site or without headers', async () => {
    const { context, routes } = recordingContext();
    await installSiteHeaders(context, undefined, headers);
    await installSiteHeaders(context, siteOf('myapp.vercel.app'), undefined);
    expect(routes).toHaveLength(0);
  });
});

/** The fixtures a `web()` target contributes, as types only. */

import type { App } from 'e2e-core';
import type { Browser } from './browser.ts';

/** `app` on a web target. A `web()` target always declares `app.url`, so `baseUrl` is always set. */
export interface WebApp extends App {
  /** The target's `app.url` with the run's port and no trailing slash: `${app.baseUrl}/api/users`. */
  readonly baseUrl: string;
}

/** What a session on a `web()` target holds beside `screen` and `app`: the `browser` fixture, and `app` with its `baseUrl` always set. */
export interface WebFixtures {
  readonly browser: Browser;
  readonly app: WebApp;
}

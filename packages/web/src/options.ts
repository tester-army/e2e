/** The options `web()` takes: which browser, how it is reached, and how every attempt's context is set up. */

import type { Secret, ViewportSize } from 'e2e/engine';
import type { BrowserName } from './browsers.ts';
import type { WebInitScript } from './init-scripts.ts';
import type { WebMedia } from './media.ts';
import type { BrowserProvider } from './provider.ts';

/**
 * Attach to a remote browser over CDP instead of launching a local one. The
 * seam a hosted-browser engine plugs into: a per-run cloud session (its
 * endpoint provisioned only once the run starts) resolves through
 * `cdpEndpoint` at `init`, and again at an attempt start after a disconnect.
 * CDP attach is chromium-only.
 */
export interface WebConnectOptions {
  /**
   * Resolves the CDP endpoint (a `ws://`/`wss://` or `http://` DevTools URL)
   * to attach to. Async because a hosted endpoint is not known at config load;
   * called once per worker in `init`, and again at the start of any attempt
   * that finds the session dropped, so a fresh per-run URL reconnects cleanly.
   * An attach the init or attempt gave up on keeps going for the next
   * attempt. `signal` aborts when the worker is disposed, or the attach
   * takes more than 60 seconds: a resolver that provisions a session should
   * stop and release it, since a browser that arrives then is detached.
   */
  readonly cdpEndpoint: (signal: AbortSignal) => string | Promise<string>;
}

/** HTTP basic authentication the browser answers a `401` challenge with. */
export interface WebBasicAuth {
  /** The user name; `:` is not allowed in one (RFC 7617). */
  readonly username: string;
  /**
   * The password, or `secrets.get(name)` for one in `config.secrets`: resolved
   * when each attempt starts and redacted from reports, logs, and observations
   * like any configured secret.
   */
  readonly password: string | Secret;
}

/** The engine's screencast of the page: the frame size and the JPEG quality of the frames it encodes. */
export interface WebScreencastOptions {
  /** Frame size in pixels; default the viewport's, or the window's under `viewport: null`. A smaller size makes a smaller file. */
  readonly size?: ViewportSize;
  /** JPEG quality of each captured frame, 0 through 100; the browser's default when unset. */
  readonly quality?: number;
}

/**
 * Options of the browser engine: how it drives the app. The app itself
 * (its `url`, `environment`, `identity`, and the command that starts it) is
 * the target's `app`.
 */
export interface WebOptions {
  /**
   * Browser to launch, `chromium` (default) or `firefox`, driven over
   * WebDriver BiDi. A `BrowserProvider` leases hosted browsers instead, one
   * per worker slot, each attached to over CDP and released when the run
   * ends; `scope: 'attempt'` is not supported right now. A provider implies
   * chromium and excludes `connect`.
   */
  readonly browser?: BrowserName | BrowserProvider;
  /**
   * Initial viewport of every attempt's page; default 1280 by 720. `null`
   * emulates no size: the page fills the browser window, whatever size the
   * window has (a hosted browser's live view, a headed run), and
   * `browser.setViewport` still fixes one for the rest of the attempt.
   */
  readonly viewport?: ViewportSize | null;
  /**
   * How the engine's own screencast records an attempt that records video.
   * A browser provider that records (`BrowserProvider.record`) records in
   * its place, and ignores these. Which attempts record is the config's
   * `video`, not an engine option.
   */
  readonly screencast?: WebScreencastOptions;
  /**
   * Attach to a remote browser over CDP instead of launching locally. Requires
   * the chromium browser (the default). Wired by a hosted-browser engine.
   */
  readonly connect?: WebConnectOptions;
  /**
   * HTTP headers added to every request the browser sends to an allowed
   * origin: a preview-protection bypass token, a tunnel's interstitial skip.
   * Requests to any other origin (a CDN, an analytics endpoint, an identity
   * provider) never carry them, so a header that is a secret stays with the
   * app it unlocks. Names are case-insensitive; a header the page already
   * sends under the same name is replaced. Applies to every path onto the
   * page, deterministic and agent-driven alike. Injecting headers routes
   * every request of the attempt, which turns the browser's HTTP cache off
   * and blocks service workers (a worker's requests bypass routing, so a
   * page it controlled would reach the gate bare).
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * HTTP basic authentication for a staging app behind a browser challenge.
   * The browser answers a `401` with these credentials wherever one is
   * issued. Applies to every path
   * onto the page.
   */
  readonly basicAuth?: WebBasicAuth;
  /**
   * The attribute that carries an element's test id: what the `testId` query
   * (`screen.getByTestId`) resolves and what `SemanticNode.testId` reports.
   * Defaults to `data-testid`.
   */
  readonly testIdAttribute?: string;
  /**
   * The `User-Agent` every attempt's context sends and `navigator.userAgent`
   * reports: for an app that switches into a test mode on a marker in the agent string.
   * Defaults to the browser's own. A `user-agent` entry in `headers` beside
   * it is `INVALID_CONFIG`.
   */
  readonly userAgent?: string;
  /**
   * The locale every attempt's context runs in, a BCP 47 tag such as
   * `de-DE`: what `navigator.language`, `Intl` formatting, and the `Accept-Language` header
   * report. Defaults to the browser's own. An `accept-language` entry in
   * `headers` beside it is `INVALID_CONFIG`.
   */
  readonly locale?: string;
  /**
   * The IANA time zone every attempt's context runs in, such as
   * `Europe/Berlin`: what `Date` and `Intl` resolve local time against. Defaults to the
   * machine's.
   */
  readonly timezoneId?: string;
  /**
   * The `prefers-color-scheme` every page reports from its first paint, to
   * its `@media` rules and to `matchMedia`. Defaults to the browser's own.
   * `browser.emulateMedia` changes it for the rest of one attempt.
   */
  readonly colorScheme?: WebMedia['colorScheme'];
  /**
   * The `prefers-reduced-motion` every page reports from its first paint: `'reduce'`
   * lets an app's own rule turn its animations off, so none races an
   * assertion. Defaults to the browser's own. `browser.emulateMedia`
   * changes it for the rest of one attempt.
   */
  readonly reducedMotion?: WebMedia['reducedMotion'];
  /**
   * Scripts every document runs before the page's own, in every tab and
   * frame: JavaScript source, a `{ path }` relative to the project root, or a
   * function, which cannot close over test variables.
   */
  readonly initScripts?: readonly WebInitScript[];
}

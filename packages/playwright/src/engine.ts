/**
 * The Playwright engine for e2e: a browser body built with the
 * public `defineEngine`, validated by the same rules and graded by the same
 * capabilities as any other engine. Core imports nothing from here; this
 * package imports the contract from `@e2edev/e2e/engine` and contributes the `web`
 * fixture the way a device engine contributes `device`.
 */

import type { BrowserContext, Page } from 'playwright';
import {
  ConfigurationError,
  defineEngine,
  obj,
  type EngineAppDeclaration,
  type EngineHandle,
} from '@e2edev/e2e/engine';
import { createRequire } from 'node:module';
import { PlaywrightSurface, type PlaywrightOptions } from './surface.ts';
import { createWebFixture } from './web.ts';

/** Creates one Playwright engine: one browser per worker, one context per attempt. */
const surfaces = new WeakMap<EngineHandle, PlaywrightSurface>();

/**
 * The live browser objects behind a `playwright()` handle, for agent-side code
 * that replaces the toolset wholesale (spec chapter 16) and drives the page with
 * its own Playwright tooling. Both accessors read the current attempt: the
 * context exists from `startAttempt`, the page from the first `app.open()` or
 * `web.goto()`, and either throws `INVALID_STATE` before that. The harness
 * remains the notary for what it witnesses; a caller here acts out of band.
 */
export interface PlaywrightLiveSurface {
  readonly page: () => Page;
  readonly context: () => BrowserContext;
}

/** The live surface of a handle this module created, or undefined for any other engine. */
export function surfaceOf(engine: EngineHandle): PlaywrightLiveSurface | undefined {
  const surface = surfaces.get(engine);
  if (surface === undefined) return undefined;
  return { page: () => surface.requirePage(), context: () => surface.requireContext() };
}

export function playwright(options: PlaywrightOptions = {}): EngineHandle {
  if (options.connect !== undefined && options.browser !== undefined && options.browser !== 'chromium') {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `playwright({ connect }) requires the chromium browser; CDP attach is chromium-only, got "${options.browser}"`,
    );
  }
  if (options.headers !== undefined) validateHeaders(options.headers);
  if (options.basicAuth !== undefined) validateBasicAuth(options.basicAuth);
  const surface = new PlaywrightSurface(options);
  const handle = defineEngine({
    name: 'playwright',
    version: ownVersion(),
    spiVersion: 1,
    platform: 'web',
    prepare: (info) => surface.prepare(info),
    init: (info) => surface.init(info),
    startAttempt: (context) => surface.startAttempt(context),
    endAttempt: (context) => surface.endAttempt(context),
    dispose: (context) => surface.dispose(context),
    observe: (operation, observeOptions) => surface.observe(operation, observeOptions),
    locate: (expression, operation) => surface.locate(expression, operation),
    perform: (ref, action, operation) => surface.perform(ref, action, operation),
    swipe: (direction, momentum, operation) => surface.swipe(direction, momentum, operation),
    app: {
      ...declaredApp(options),
      navigate: (url, operation) => surface.navigate(url, operation),
      back: (operation) => surface.back(operation),
      restart: (operation) => surface.restart(operation),
      clearState: (operation) => surface.clearState(operation),
    },
    artifacts: {
      screenshot: (label, operation) => surface.screenshot(label, operation),
      startTrace: (operation) => surface.startTrace(operation),
      stopTrace: (operation) => surface.stopTrace(operation),
      startVideo: (operation) => surface.startVideo(operation),
      stopVideo: (operation) => surface.stopVideo(operation),
    },
    state: {
      capture: (operation) => surface.captureState(operation),
      restore: (state, operation) => surface.restoreState(state, operation),
    },
    url: (operation) => surface.url(operation),
    fixtures: {
      web: (context) => createWebFixture(surface, context),
    },
  });
  surfaces.set(handle, surface);
  return handle;
}

/** An HTTP header field name: one or more `token` characters (RFC 9110). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Refuses a header the browser could not send, at config load rather than at
 * the first request: a name outside the token grammar, a value carrying a line
 * break (a header-injection vector), or a value that is not a string at all.
 */
function validateHeaders(headers: PlaywrightOptions['headers'] & object): void {
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    throw new ConfigurationError('INVALID_CONFIG', 'playwright({ headers }) must be an object of header name to value');
  }
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) {
      throw new ConfigurationError('INVALID_CONFIG', `playwright({ headers }) has an invalid header name: "${name}"`);
    }
    if (typeof value !== 'string') {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `playwright({ headers }) header "${name}" must be a string, got ${typeof value}`,
      );
    }
    if (/[\r\n]/.test(value)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `playwright({ headers }) header "${name}" must not contain a line break`,
      );
    }
  }
}

/** Refuses credentials the browser could not present: a missing field, or a `:` in the user name (RFC 7617). */
function validateBasicAuth(basicAuth: PlaywrightOptions['basicAuth'] & object): void {
  const { username, password } = basicAuth;
  if (typeof username !== 'string' || username === '') {
    throw new ConfigurationError('INVALID_CONFIG', 'playwright({ basicAuth }) requires a non-empty username string');
  }
  if (username.includes(':')) {
    throw new ConfigurationError('INVALID_CONFIG', 'playwright({ basicAuth }) username must not contain ":"');
  }
  if (typeof password !== 'string') {
    throw new ConfigurationError('INVALID_CONFIG', 'playwright({ basicAuth }) requires a password string');
  }
}

/** The app-declaration half of the options, so browser knobs never reach the manifest. */
function declaredApp(options: PlaywrightOptions): EngineAppDeclaration {
  const { url, allowedOrigins, environment, identity, command, readyUrl, services } = options;
  return obj({ url, allowedOrigins, environment, identity, command, readyUrl, services });
}

/** This package's published version, read through require resolution. */
function ownVersion(): string {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

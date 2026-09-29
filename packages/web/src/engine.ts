/**
 * The Playwright engine for e2e: a browser body built with the
 * public `defineEngine`, validated by the same rules and graded by the same
 * capabilities as any other engine. Core imports nothing from here; this
 * package imports the contract from `e2e/engine` and contributes the `web`
 * fixture the way a device engine contributes `device`.
 */

import type { BrowserContext, Page } from 'playwright';
import {
  ConfigurationError,
  defineEngine,
  isSecret,
  LOCATOR_ACTION_KINDS,
  POINTER_ACTION_KINDS,
  obj,
  rejectUnknownKeys,
  type EngineAppDeclaration,
  type EngineHandle,
} from 'e2e/engine';
import { createRequire } from 'node:module';
import { asBrowserProvider } from './provider.ts';
import { PlaywrightSurface, type WebOptions } from './surface.ts';
import { createWebFixture } from './web.ts';

/** Creates one Playwright engine: one browser per worker, one context per attempt. */
const surfaces = new WeakMap<EngineHandle, PlaywrightSurface>();

/**
 * The live browser objects behind a `web()` handle, for agent-side code
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

export function web(options: WebOptions = {}): EngineHandle {
  if ('allowedOrigins' in options) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'web({ allowedOrigins }) is gone: navigation and secret fills are not gated by origin; remove the option',
    );
  }
  if ('video' in options) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      "web({ video }) was renamed web({ screencast }): it takes { size?, quality? } for the page screencast; which attempts record is the video mode on the config or a target",
    );
  }
  rejectUnknownKeys('web()', options, WEB_OPTION_KEYS);
  const provider = typeof options.browser === 'object' && options.browser !== null ? asBrowserProvider(options.browser) : undefined;
  if (provider !== undefined && options.connect !== undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `web({ browser, connect }) names two browser sources; browser provider "${provider.name}" leases its own browsers, so remove connect`,
    );
  }
  if (isRecord(options.connect)) rejectUnknownKeys('web({ connect })', options.connect, ['cdpEndpoint', 'reconnectEndpoint']);
  if (options.connect !== undefined && typeof options.browser === 'string' && options.browser !== 'chromium') {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `web({ connect }) requires the chromium browser; CDP attach is chromium-only, got "${options.browser}"`,
    );
  }
  if (options.headers !== undefined) validateHeaders(options.headers);
  if (options.basicAuth !== undefined) validateBasicAuth(options.basicAuth);
  if (options.testIdAttribute !== undefined) validateTestIdAttribute(options.testIdAttribute);
  if (options.userAgent !== undefined) validateUserAgent(options.userAgent, options.headers);
  if (options.screencast !== undefined) validateScreencast(options.screencast);
  const reconnecting = options.connect?.reconnectEndpoint !== undefined;
  if (reconnecting && typeof options.connect?.reconnectEndpoint !== 'function') {
    throw new ConfigurationError('INVALID_CONFIG', 'connect.reconnectEndpoint must be a function');
  }
  // A per-attempt lease rides the same persistent context as `reconnectEndpoint`, with the same limits.
  const recoverable = reconnecting || provider?.scope === 'attempt';
  const mode = provider === undefined ? 'connect.reconnectEndpoint' : `browser provider "${provider.name}" with scope "attempt"`;
  if (recoverable && (options.headers !== undefined || options.basicAuth !== undefined || options.userAgent !== undefined)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${mode} uses a persistent context; headers, basicAuth, and userAgent require a newly created context`,
    );
  }
  const surface = new PlaywrightSurface(options);
  const handle = defineEngine({
    name: 'web',
    version: ownVersion(),
    spiVersion: 1,
    platform: 'web',
    prepare: (info) => surface.prepare(info),
    finish: (info) => surface.finish(info),
    init: (info) => surface.init(info),
    startAttempt: (context) => surface.startAttempt(context),
    settleAttempt: (context) => surface.settleAttempt(context),
    endAttempt: (context) => surface.endAttempt(context),
    dispose: (context) => surface.dispose(context),
    observe: (operation, observeOptions) => surface.observe(operation, observeOptions),
    locate: (expression, operation) => surface.locate(expression, operation),
    perform: (ref, action, operation) => surface.perform(ref, action, operation),
    // A browser honors every action kind of the contract; `actions.ts` dispatches each.
    actions: LOCATOR_ACTION_KINDS,
    // Playwright holds each modifier for the click.
    tapModifiers: true,
    // A page takes every pointer action of the contract at a bare point too.
    performAt: (point, action, operation) => surface.performAt(point, action, operation),
    pointerActions: POINTER_ACTION_KINDS,
    keyboard: {
      type: (text, keyboardOptions, operation) => surface.typeText(text, keyboardOptions, operation),
      press: (key, operation) => surface.pressKey(key, operation),
    },
    app: declaredApp(options),
    ...(isSecret(options.basicAuth?.password) ? { secrets: [options.basicAuth.password] } : {}),
    session: {
      open: (url, operation) => surface.open(url, operation),
      back: (operation) => surface.back(operation),
      restart: (operation) => surface.restart(operation),
      reset: recoverable ? () => Promise.reject(persistentContextLimit('app.clearState()', mode, provider !== undefined)) : (operation) => surface.reset(operation),
    },
    artifacts: {
      screenshot: (label, operation) => surface.screenshot(label, operation),
      startTrace: (operation) => surface.startTrace(operation),
      stopTrace: (operation) => surface.stopTrace(operation),
      startVideo: (operation) => surface.startVideo(operation),
      stopVideo: (operation) => surface.stopVideo(operation),
    },
    ...(recoverable
      ? {}
      : {
          state: {
            capture: (operation) => surface.captureState(operation),
            restore: (state, operation) => surface.restoreState(state, operation),
          },
        }),
    fixtures: {
      web: (context) => createWebFixture(surface, context),
    },
  });
  surfaces.set(handle, surface);
  return handle;
}

/** Every option `web()` takes, kept equal to `WebOptions` by the compiler. */
const WEB_OPTION_KEYS: readonly string[] = Object.keys({
  url: true,
  environment: true,
  identity: true,
  command: true,
  readyUrl: true,
  services: true,
  browser: true,
  viewport: true,
  screencast: true,
  connect: true,
  headers: true,
  basicAuth: true,
  testIdAttribute: true,
  userAgent: true,
} satisfies Record<keyof WebOptions, true>);

/**
 * What a persistent context rules out, named with its cause: `what` replaces
 * the browser context, which `mode` never does. A per-attempt lease starts
 * every attempt on a fresh browser already, and worker scope has the reset.
 */
function persistentContextLimit(what: string, mode: string, leased: boolean): ConfigurationError {
  const remedy = leased ? '; every attempt already starts on a fresh browser, and scope "worker" can clear one mid-test' : '';
  return new ConfigurationError(
    'UNSUPPORTED_CAPABILITY',
    `${what} is unavailable with ${mode}: it replaces the browser context, and the attempt rides one persistent context${remedy}`,
  );
}

/** An HTTP header field name: one or more `token` characters (RFC 9110). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** A control character no HTTP field value may carry; a horizontal tab is the one the grammar allows. */
// oxlint-disable-next-line no-control-regex -- the control characters are the point
const FIELD_VALUE_CONTROL = /[\u0000-\u0008\u000A-\u001F\u007F]/;

/** True for a plain object; the shape both options take. Config runs as JavaScript, so the types alone are no guard. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Refuses a header the browser could not send, at config load rather than at
 * the first request: a name outside the token grammar, a value carrying a
 * control character (a line break is a header-injection vector), or a value
 * that is not a string at all.
 */
function validateHeaders(headers: unknown): void {
  if (!isRecord(headers)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ headers }) must be an object of header name to value');
  }
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) {
      throw new ConfigurationError('INVALID_CONFIG', `web({ headers }) has an invalid header name: "${name}"`);
    }
    if (typeof value !== 'string') {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `web({ headers }) header "${name}" must be a string, got ${typeof value}`,
      );
    }
    if (FIELD_VALUE_CONTROL.test(value)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `web({ headers }) header "${name}" must not contain a control character`,
      );
    }
  }
}

/** Refuses credentials the browser could not present: a missing field, or a `:` in the user name (RFC 7617). */
function validateBasicAuth(basicAuth: unknown): void {
  if (!isRecord(basicAuth)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ basicAuth }) must be an object with username and password');
  }
  rejectUnknownKeys('web({ basicAuth })', basicAuth, ['username', 'password']);
  const { username, password } = basicAuth;
  if (typeof username !== 'string' || username === '') {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ basicAuth }) requires a non-empty username string');
  }
  if (username.includes(':')) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ basicAuth }) username must not contain ":"');
  }
  if (typeof password !== 'string' && !isSecret(password)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ basicAuth }) requires a password string or secrets.get(name)');
  }
}

/**
 * Refuses a user agent the browser could not send (not a string, empty, or
 * carrying a control character) and one a `user-agent` header would override
 * on the app's site while `navigator.userAgent` kept reporting it.
 */
function validateUserAgent(userAgent: unknown, headers: Readonly<Record<string, string>> | undefined): void {
  if (typeof userAgent !== 'string' || userAgent === '') {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ userAgent }) must be a non-empty string');
  }
  if (FIELD_VALUE_CONTROL.test(userAgent)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ userAgent }) must not contain a control character');
  }
  if (headers !== undefined && Object.keys(headers).some((name) => name.toLowerCase() === 'user-agent')) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ userAgent }) and a user-agent header in web({ headers }) conflict; set userAgent only');
  }
}

/**
 * An attribute name the document grammar accepts (XML `Name`, ASCII): a value
 * outside it could never be on an element, so `getByTestId` would match nothing
 * and every `testId` query would fail silently.
 */
const ATTRIBUTE_NAME = /^[A-Za-z_:][A-Za-z0-9_:.-]*$/;

/** `web({ screencast })`: a whole-pixel frame size and a 0-100 JPEG quality, each optional. */
function validateScreencast(screencast: unknown): void {
  if (!isPlainObject(screencast)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ screencast }) must be a plain object: { size?, quality? }');
  }
  for (const key of Object.keys(screencast as object)) {
    if (key !== 'size' && key !== 'quality') {
      throw new ConfigurationError('INVALID_CONFIG', `web({ screencast }) has unknown key "${key}"; it is { size?, quality? }, and which attempts record is the config's video`);
    }
  }
  const { size, quality } = screencast as { size?: unknown; quality?: unknown };
  if (size !== undefined) {
    const fields = isPlainObject(size) ? size : {};
    const { width, height } = fields as { width?: unknown; height?: unknown };
    const unknownKey = Object.keys(fields).find((key) => key !== 'width' && key !== 'height');
    if (unknownKey !== undefined) {
      throw new ConfigurationError('INVALID_CONFIG', `web({ screencast: { size } }) has unknown key "${unknownKey}"; it is { width, height }`);
    }
    if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) < 1 || (height as number) < 1) {
      throw new ConfigurationError('INVALID_CONFIG', 'web({ screencast: { size } }) must be { width, height } in whole pixels, each at least 1');
    }
  }
  if (quality !== undefined && (!Number.isInteger(quality) || (quality as number) < 0 || (quality as number) > 100)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ screencast: { quality } }) must be an integer from 0 through 100');
  }
}

/** An object literal (or `Object.create(null)`): not an array, a class instance, or a primitive. */
function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Refuses a test-id attribute no element could carry, at config load. */
function validateTestIdAttribute(attribute: unknown): void {
  if (typeof attribute !== 'string' || !ATTRIBUTE_NAME.test(attribute)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `web({ testIdAttribute }) must be an attribute name such as "data-testid", got ${JSON.stringify(attribute)}`,
    );
  }
}

/** The app-declaration half of the options, so browser knobs never reach the manifest. */
function declaredApp(options: WebOptions): EngineAppDeclaration {
  const { url, environment, identity, command, readyUrl, services } = options;
  return obj({ url, environment, identity, command, readyUrl, services });
}

/** This package's published version, read through require resolution. */
function ownVersion(): string {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
